import type { Decision, Policy } from '../sample.ts';
import type { Rng } from '../rng.ts';

/**
 * What the trainer needs from a policy model. Both the linear policy and the
 * MLP implement it, so the training loop, the evaluation and the checks do
 * not care which one they are driving.
 */
export interface Step {
  /** Tree path of the decision, for path-based credit. */
  path: string;
  keys: string[];
  /** Softmax probabilities of the policy itself. */
  probs: Float64Array;
  /** Probabilities actually sampled from: (1-ε)·probs + ε/n. Equal to probs when ε = 0. */
  sampled: Float64Array;
  epsilon: number;
  chosen: number;
  /** Normalised state, as fed to the model. */
  state: Float64Array;
  /** Raw state, for fitting the value baseline and the normaliser. */
  rawState: Float64Array;
  /** Model-specific cache for backpropagation (the MLP keeps its hidden activations here). */
  cache?: Float64Array;
}

export interface Trace {
  steps: Step[];
}

export interface PolicyModel {
  readonly name: string;
  /** Number of learnable parameters currently allocated. */
  parameterCount(): number;
  probs(d: Decision, rawState: Float64Array): { keys: string[]; probs: Float64Array };
  forState(state: Float64Array, rng: Rng, trace?: Trace, greedy?: boolean, epsilon?: number): Policy;
  /** A fresh, empty gradient accumulator of this model's shape. */
  newGrads(): unknown;
  /** Accumulate d log p_sampled(chosen) · advantage into grads. */
  accumulate(grads: unknown, step: Step, advantage: number): void;
  /** Divide every accumulated gradient by n (mean over the batch). */
  scaleGrads(grads: unknown, n: number): void;
  applyGradient(grads: unknown, lr: number, l2: number, optimizer: 'sgd' | 'adam'): void;
  /** Blend batch statistics into the input normaliser, preserving every logit. */
  updateNormalizer(states: Float64Array[], rate?: number): void;
  toJSON(): unknown;
}

/** Shared: the ε-mixture gradient scale, (1-ε)·π_c / p_mix(c); 1 when ε = 0. */
export function mixtureScale(step: Step): number {
  return step.epsilon > 0 ? ((1 - step.epsilon) * step.probs[step.chosen]) / step.sampled[step.chosen] : 1;
}

/** Shared: sample or argmax an index from `probs`, mixing in ε-uniform when sampling. */
export function chooseIndex(probs: Float64Array, rng: Rng, greedy: boolean, epsilon: number): { chosen: number; sampled: Float64Array } {
  const n = probs.length;
  const sampled = epsilon > 0 ? Float64Array.from(probs, (p) => (1 - epsilon) * p + epsilon / n) : probs;
  if (greedy) {
    let c = 0;
    for (let i = 1; i < n; i++) if (probs[i] > probs[c]) c = i;
    return { chosen: c, sampled };
  }
  let r = rng.next();
  for (let i = 0; i < n; i++) { if (r < sampled[i]) return { chosen: i, sampled }; r -= sampled[i]; }
  return { chosen: n - 1, sampled };
}

/** Shared Adam state for one parameter tensor. */
export class AdamState {
  m: Float64Array;
  v: Float64Array;
  constructor(size: number) { this.m = new Float64Array(size); this.v = new Float64Array(size); }
  /** In-place update of `w` given gradient `g`; `t` is the global step count. */
  step(w: Float64Array, g: Float64Array, lr: number, l2: number, t: number, optimizer: 'sgd' | 'adam', mask?: (i: number) => boolean): void {
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const c1 = 1 - b1 ** t, c2 = 1 - b2 ** t;
    for (let i = 0; i < w.length; i++) {
      if (mask && !mask(i)) continue;
      const gi = g[i];
      if (optimizer === 'adam') {
        this.m[i] = b1 * this.m[i] + (1 - b1) * gi;
        this.v[i] = b2 * this.v[i] + (1 - b2) * gi * gi;
        w[i] += lr * (this.m[i] / c1) / (Math.sqrt(this.v[i] / c2) + eps) - lr * l2 * w[i];
      } else {
        w[i] += lr * gi - lr * l2 * w[i];
      }
    }
  }
  /** Rescale moments when the parameter's coordinates change (normaliser updates). */
  rescale(i: number, ratio: number): void { this.m[i] *= ratio; this.v[i] *= ratio * ratio; }
}
