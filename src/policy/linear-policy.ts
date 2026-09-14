import type { Decision, Policy } from '../sample.ts';
import type { Rng } from '../rng.ts';
import { STATE_DIM, optionKey } from './features.ts';
import { AdamState, chooseIndex, mixtureScale, type PolicyModel, type Step, type Trace } from './model.ts';

export type { Step, Trace } from './model.ts';

/**
 * Factored linear softmax policy.
 *
 * For a decision with options o_1..o_n in (normalised) state z,
 * logit_i = w[key(o_i)] · z and the choice is sampled from softmax(logit).
 * One weight vector per option key. Unseen keys start at zero, i.e. uniform.
 */
export class LinearPolicy implements PolicyModel {
  readonly name = 'linear';
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
  private readonly adam = new Map<string, AdamState>();
  private steps = 0;
  constructor(temperature = 1) { this.temperature = temperature; }

  parameterCount(): number { return this.weights.size * STATE_DIM; }

  normalize(state: Float64Array): Float64Array {
    const z = new Float64Array(STATE_DIM);
    z[0] = 1;
    for (let i = 1; i < STATE_DIM; i++) z[i] = (state[i] - this.mean[i]) / this.scale[i];
    return z;
  }

  vector(key: string): Float64Array {
    let w = this.weights.get(key);
    if (!w) { w = new Float64Array(STATE_DIM); this.weights.set(key, w); }
    return w;
  }

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
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return { keys, probs: Float64Array.from(exps, (e) => e / sum) };
  }

  forState(state: Float64Array, rng: Rng, trace?: Trace, greedy = false, epsilon = 0): Policy {
    return (d: Decision) => {
      const { keys, probs } = this.probs(d, state);
      const { chosen, sampled } = chooseIndex(probs, rng, greedy, epsilon);
      trace?.steps.push({ path: d.path, keys, probs, sampled, epsilon, chosen, state: this.normalize(state), rawState: state });
      return chosen;
    };
  }

  newGrads(): Map<string, Float64Array> { return new Map(); }

  accumulate(grads: Map<string, Float64Array>, step: Step, advantage: number): void {
    const c = step.chosen;
    const scale = mixtureScale(step);
    for (let j = 0; j < step.keys.length; j++) {
      const coeff = advantage * scale * ((j === c ? 1 : 0) - step.probs[j]);
      if (coeff === 0) continue;
      let g = grads.get(step.keys[j]);
      if (!g) { g = new Float64Array(STATE_DIM); grads.set(step.keys[j], g); }
      for (let i = 0; i < STATE_DIM; i++) g[i] += coeff * step.state[i];
    }
  }

  scaleGrads(grads: Map<string, Float64Array>, n: number): void {
    for (const g of grads.values()) for (let i = 0; i < g.length; i++) g[i] /= n;
  }

  /** Gradient step. L2 decay applies to every weight vector, not only those in this batch. */
  applyGradient(grads: Map<string, Float64Array>, lr: number, l2 = 0, optimizer: 'sgd' | 'adam' = 'sgd'): void {
    for (const k of grads.keys()) this.vector(k);
    this.steps++;
    const zero = new Float64Array(STATE_DIM);
    for (const [k, w] of this.weights) {
      let a = this.adam.get(k);
      if (!a) { a = new AdamState(STATE_DIM); this.adam.set(k, a); }
      a.step(w, grads.get(k) ?? zero, lr, l2, this.steps, optimizer);
    }
  }

  /**
   * Blend batch statistics into the stored normaliser (EMA), then transform
   * every weight vector so that every logit is exactly unchanged:
   *   w·((s−m)/σ) = w'·((s−m')/σ') with w'_i = w_i σ'_i/σ_i and
   *   bias' = bias + Σ_i w_i (m'_i − m_i)/σ_i.
   */
  updateNormalizer(states: Float64Array[], rate = 0.2): void {
    if (states.length === 0) return;
    const oldMean = Float64Array.from(this.mean);
    const oldScale = Float64Array.from(this.scale);
    for (let i = 1; i < STATE_DIM; i++) {
      let m = 0; for (const s of states) m += s[i]; m /= states.length;
      let v = 0; for (const s of states) v += (s[i] - m) ** 2; v /= states.length;
      const sd = Math.sqrt(v) || 1;
      this.mean[i] += rate * (m - this.mean[i]);
      this.scale[i] += rate * (sd - this.scale[i]);
    }
    for (const [k, w] of this.weights) {
      let shift = 0;
      const a = this.adam.get(k);
      for (let i = 1; i < STATE_DIM; i++) {
        const ratio = this.scale[i] / oldScale[i];
        shift += (w[i] * (this.mean[i] - oldMean[i])) / oldScale[i];
        w[i] *= ratio;
        a?.rescale(i, ratio);
      }
      w[0] += shift;
    }
  }

  toJSON(): { model: 'linear'; mean: number[]; scale: number[]; weights: Record<string, number[]> } {
    return { model: 'linear', mean: [...this.mean], scale: [...this.scale], weights: Object.fromEntries([...this.weights].map(([k, w]) => [k, [...w]])) };
  }

  static fromJSON(obj: { mean: number[]; scale: number[]; weights: Record<string, number[]> }, temperature = 1): LinearPolicy {
    const p = new LinearPolicy(temperature);
    p.mean.set(obj.mean);
    p.scale.set(obj.scale);
    for (const [k, w] of Object.entries(obj.weights)) p.weights.set(k, Float64Array.from(w));
    return p;
  }
}
