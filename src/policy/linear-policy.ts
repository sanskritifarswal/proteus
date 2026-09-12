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
  probs: Float64Array;
  chosen: number;
  state: Float64Array;
}

export interface Trace {
  steps: Step[];
}

export class LinearPolicy {
  readonly weights = new Map<string, Float64Array>();
  readonly temperature: number;
  constructor(temperature = 1) { this.temperature = temperature; }

  vector(key: string): Float64Array {
    let w = this.weights.get(key);
    if (!w) { w = new Float64Array(STATE_DIM); this.weights.set(key, w); }
    return w;
  }

  probs(d: Decision, state: Float64Array): { keys: string[]; probs: Float64Array } {
    const keys = d.options.map((o) => optionKey(d, o));
    const logits = keys.map((k) => {
      const w = this.weights.get(k);
      if (!w) return 0;
      let z = 0;
      for (let i = 0; i < STATE_DIM; i++) z += w[i] * state[i];
      return z / this.temperature;
    });
    const max = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(z - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return { keys, probs: Float64Array.from(exps, (e) => e / sum) };
  }

  /** A sampler Policy for one state. Decisions are appended to `trace`. */
  forState(state: Float64Array, rng: Rng, trace?: Trace, greedy = false): Policy {
    return (d: Decision) => {
      const { keys, probs } = this.probs(d, state);
      let chosen: number;
      if (greedy) {
        chosen = 0;
        for (let i = 1; i < probs.length; i++) if (probs[i] > probs[chosen]) chosen = i;
      } else {
        let r = rng.next();
        chosen = probs.length - 1;
        for (let i = 0; i < probs.length; i++) { if (r < probs[i]) { chosen = i; break; } r -= probs[i]; }
      }
      trace?.steps.push({ keys, probs, chosen, state });
      return chosen;
    };
  }

  /** Accumulate the REINFORCE gradient of log p(chosen) scaled by `advantage` into `grads`. */
  static accumulate(grads: Map<string, Float64Array>, step: Step, advantage: number): void {
    for (let j = 0; j < step.keys.length; j++) {
      const coeff = advantage * ((j === step.chosen ? 1 : 0) - step.probs[j]);
      if (coeff === 0) continue;
      let g = grads.get(step.keys[j]);
      if (!g) { g = new Float64Array(STATE_DIM); grads.set(step.keys[j], g); }
      for (let i = 0; i < STATE_DIM; i++) g[i] += coeff * step.state[i];
    }
  }

  /** Gradient step. L2 decay applies to every weight vector, not only those in this batch. */
  applyGradient(grads: Map<string, Float64Array>, lr: number, l2 = 0): void {
    for (const k of grads.keys()) this.vector(k);
    for (const [k, w] of this.weights) {
      const g = grads.get(k);
      for (let i = 0; i < STATE_DIM; i++) w[i] += lr * (g?.[i] ?? 0) - lr * l2 * w[i];
    }
  }

  toJSON(): Record<string, number[]> {
    return Object.fromEntries([...this.weights].map(([k, w]) => [k, [...w]]));
  }

  static fromJSON(obj: Record<string, number[]>, temperature = 1): LinearPolicy {
    const p = new LinearPolicy(temperature);
    for (const [k, w] of Object.entries(obj)) p.weights.set(k, Float64Array.from(w));
    return p;
  }
}
