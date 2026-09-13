import type { Decision, Policy } from '../sample.ts';
import type { Rng } from '../rng.ts';
import { STATE_DIM, optionKey } from './features.ts';

/**
 * Factored linear softmax policy.
 *
 * For a decision with options o_1..o_n in state s, logit_i = w[key(o_i)] · s
 * and the choice is sampled from softmax(logit). One weight vector per
 * option key, so the parameter count is (distinct option keys) x STATE_DIM,
 * a few thousand numbers. Unseen keys start at zero, i.e. uniform.
 *
 * `forState` returns a sampler Policy bound to one state that also records
 * every decision it makes, so the trainer can compute policy gradients
 * after the episode's rewards are known.
 */
export interface Step {
  keys: string[];
  /** Softmax probabilities of the policy itself. */
  probs: Float64Array;
  /** Probabilities actually sampled from: (1-ε)·probs + ε/n. Equal to probs when ε = 0. */
  sampled: Float64Array;
  epsilon: number;
  chosen: number;
  /** Normalised state, as fed to the logits (the gradient is w.r.t. this). */
  state: Float64Array;
  /** Raw state, for fitting the value baseline and the normaliser. */
  rawState: Float64Array;
}

export interface Trace {
  steps: Step[];
}

export class LinearPolicy {
  readonly weights = new Map<string, Float64Array>();
  readonly temperature: number;
  /**
   * Per-feature centring and scaling, fit on training batches and stored
   * with the weights. Raw features are all non-negative, so without this a
   * feature that should push one user type one way and another type the
   * other way gets cancelling gradients and only the bias learns. Centred
   * features are signed, so the same weight moves the same way for both.
   * Feature 0 (bias) is left as 1.
   */
  readonly mean = new Float64Array(STATE_DIM);
  readonly scale = new Float64Array(STATE_DIM).fill(1);
  constructor(temperature = 1) { this.temperature = temperature; }

  normalize(state: Float64Array): Float64Array {
    const z = new Float64Array(STATE_DIM);
    z[0] = 1;
    for (let i = 1; i < STATE_DIM; i++) z[i] = (state[i] - this.mean[i]) / this.scale[i];
    return z;
  }

  /** Blend batch statistics into the stored normaliser (EMA, so evaluation sees a stable transform). */
  updateNormalizer(states: Float64Array[], rate = 0.2): void {
    if (states.length === 0) return;
    for (let i = 1; i < STATE_DIM; i++) {
      let m = 0; for (const s of states) m += s[i]; m /= states.length;
      let v = 0; for (const s of states) v += (s[i] - m) ** 2; v /= states.length;
      const sd = Math.sqrt(v) || 1;
      this.mean[i] += rate * (m - this.mean[i]);
      this.scale[i] += rate * (sd - this.scale[i]);
    }
  }

  vector(key: string): Float64Array {
    let w = this.weights.get(key);
    if (!w) { w = new Float64Array(STATE_DIM); this.weights.set(key, w); }
    return w;
  }

  /** `state` is a raw feature vector; it is normalised here. */
  probs(d: Decision, state: Float64Array): { keys: string[]; probs: Float64Array } {
    const keys = d.options.map((o) => optionKey(d, o));
    const z = this.normalize(state);
    const logits = keys.map((k) => {
      const w = this.weights.get(k);
      if (!w) return 0;
      let acc = 0;
      for (let i = 0; i < STATE_DIM; i++) acc += w[i] * z[i];
      return acc / this.temperature;
    });
    const max = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(z - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return { keys, probs: Float64Array.from(exps, (e) => e / sum) };
  }

  /**
   * A sampler Policy for one state. Decisions are appended to `trace`.
   * `epsilon` mixes in uniform exploration so no option is starved of
   * samples while training; evaluation uses epsilon 0.
   */
  forState(state: Float64Array, rng: Rng, trace?: Trace, greedy = false, epsilon = 0): Policy {
    return (d: Decision) => {
      const { keys, probs } = this.probs(d, state);
      const z = this.normalize(state);
      const n = probs.length;
      const sampled = epsilon > 0 ? Float64Array.from(probs, (p) => (1 - epsilon) * p + epsilon / n) : probs;
      let chosen: number;
      if (greedy) {
        chosen = 0;
        for (let i = 1; i < n; i++) if (probs[i] > probs[chosen]) chosen = i;
      } else {
        let r = rng.next();
        chosen = n - 1;
        for (let i = 0; i < n; i++) { if (r < sampled[i]) { chosen = i; break; } r -= sampled[i]; }
      }
      trace?.steps.push({ keys, probs, sampled, epsilon, chosen, state: z, rawState: state });
      return chosen;
    };
  }

  /**
   * Accumulate the REINFORCE gradient of log p_sampled(chosen) scaled by
   * `advantage` into `grads`. With the ε-mixture, d log p_mix(c) / d z_j =
   * (1-ε)·π_c / p_mix(c) · (1[j=c] − π_j), which reduces to the plain softmax
   * gradient when ε = 0.
   */
  static accumulate(grads: Map<string, Float64Array>, step: Step, advantage: number): void {
    const c = step.chosen;
    const scale = step.epsilon > 0 ? ((1 - step.epsilon) * step.probs[c]) / step.sampled[c] : 1;
    for (let j = 0; j < step.keys.length; j++) {
      const coeff = advantage * scale * ((j === c ? 1 : 0) - step.probs[j]);
      if (coeff === 0) continue;
      let g = grads.get(step.keys[j]);
      if (!g) { g = new Float64Array(STATE_DIM); grads.set(step.keys[j], g); }
      for (let i = 0; i < STATE_DIM; i++) g[i] += coeff * step.state[i];
    }
  }

  private readonly m = new Map<string, Float64Array>();
  private readonly v = new Map<string, Float64Array>();
  private steps = 0;

  /**
   * Gradient step. `optimizer` 'sgd' applies lr·g directly. 'adam' normalises
   * each weight's step by its own gradient history, so a rarely-pushed
   * interaction weight moves about as far per step as a bias weight that is
   * pushed every sample; that is what lets personalising weights move at all
   * when their signal is small next to the global one. L2 decay applies to
   * every weight vector, not only those in this batch.
   */
  applyGradient(grads: Map<string, Float64Array>, lr: number, l2 = 0, optimizer: 'sgd' | 'adam' = 'sgd'): void {
    for (const k of grads.keys()) this.vector(k);
    this.steps++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const c1 = 1 - b1 ** this.steps, c2 = 1 - b2 ** this.steps;
    for (const [k, w] of this.weights) {
      const g = grads.get(k);
      if (optimizer === 'adam') {
        let m = this.m.get(k); if (!m) { m = new Float64Array(STATE_DIM); this.m.set(k, m); }
        let v = this.v.get(k); if (!v) { v = new Float64Array(STATE_DIM); this.v.set(k, v); }
        for (let i = 0; i < STATE_DIM; i++) {
          const gi = g?.[i] ?? 0;
          m[i] = b1 * m[i] + (1 - b1) * gi;
          v[i] = b2 * v[i] + (1 - b2) * gi * gi;
          w[i] += lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps) - lr * l2 * w[i];
        }
      } else {
        for (let i = 0; i < STATE_DIM; i++) w[i] += lr * (g?.[i] ?? 0) - lr * l2 * w[i];
      }
    }
  }

  toJSON(): { mean: number[]; scale: number[]; weights: Record<string, number[]> } {
    return { mean: [...this.mean], scale: [...this.scale], weights: Object.fromEntries([...this.weights].map(([k, w]) => [k, [...w]])) };
  }

  static fromJSON(obj: { mean: number[]; scale: number[]; weights: Record<string, number[]> }, temperature = 1): LinearPolicy {
    const p = new LinearPolicy(temperature);
    p.mean.set(obj.mean);
    p.scale.set(obj.scale);
    for (const [k, w] of Object.entries(obj.weights)) p.weights.set(k, Float64Array.from(w));
    return p;
  }
}
