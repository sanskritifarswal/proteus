import type { Decision, Policy } from '../sample.ts';
import type { Rng } from '../rng.ts';
import { STATE_DIM, optionKey } from './features.ts';
import { AdamState, chooseIndex, mixtureScale, type PolicyModel, type Step, type Trace } from './model.ts';

/**
 * Two-layer policy: a hidden layer shared across every decision, and one
 * small linear head per option key.
 *
 *   h = tanh(W1 · z + b1)          shared, H units
 *   logit_k = v_k · h + c_k        per option key
 *
 * The shared layer can form combinations a linear policy cannot ("compact
 * worked for this user AND completion is high"); the per-key heads keep
 * the factored structure of the action space. Heads start at zero, so the
 * untrained network is exactly uniform, the same as the linear policy.
 * Backpropagation is written out by hand: the sizes are tiny.
 */
export interface MlpGrads {
  W1: Float64Array;
  b1: Float64Array;
  heads: Map<string, Float64Array>;
}

export class MlpPolicy implements PolicyModel {
  readonly name = 'mlp';
  readonly H: number;
  readonly W1: Float64Array; // H x STATE_DIM, row-major
  readonly b1: Float64Array; // H
  readonly heads = new Map<string, Float64Array>(); // H + 1 (last is the head bias)
  readonly mean = new Float64Array(STATE_DIM);
  readonly scale = new Float64Array(STATE_DIM).fill(1);
  private readonly adamW1: AdamState;
  private readonly adamB1: AdamState;
  private readonly adamHeads = new Map<string, AdamState>();
  private steps = 0;

  constructor(hidden = 32, rng?: Rng) {
    this.H = hidden;
    this.W1 = new Float64Array(hidden * STATE_DIM);
    this.b1 = new Float64Array(hidden);
    // Small deterministic init so hidden units differ; seeded, so training is reproducible.
    const r = rng ?? { next: () => 0.5, int: () => 0, bigint: () => 0n };
    const bound = Math.sqrt(6 / (STATE_DIM + hidden)) * 0.5;
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (2 * r.next() - 1) * bound;
    this.adamW1 = new AdamState(this.W1.length);
    this.adamB1 = new AdamState(hidden);
  }

  parameterCount(): number { return this.W1.length + this.b1.length + this.heads.size * (this.H + 1); }

  normalize(state: Float64Array): Float64Array {
    const z = new Float64Array(STATE_DIM);
    z[0] = 1;
    for (let i = 1; i < STATE_DIM; i++) z[i] = (state[i] - this.mean[i]) / this.scale[i];
    return z;
  }

  hidden(z: Float64Array): Float64Array {
    const h = new Float64Array(this.H);
    for (let u = 0; u < this.H; u++) {
      let a = this.b1[u];
      const row = u * STATE_DIM;
      for (let i = 0; i < STATE_DIM; i++) a += this.W1[row + i] * z[i];
      h[u] = Math.tanh(a);
    }
    return h;
  }

  head(key: string): Float64Array {
    let v = this.heads.get(key);
    if (!v) { v = new Float64Array(this.H + 1); this.heads.set(key, v); }
    return v;
  }

  private logits(keys: string[], h: Float64Array): number[] {
    return keys.map((k) => {
      const v = this.heads.get(k);
      if (!v) return 0;
      let acc = v[this.H];
      for (let u = 0; u < this.H; u++) acc += v[u] * h[u];
      return acc;
    });
  }

  private softmax(logits: number[]): Float64Array {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return Float64Array.from(exps, (e) => e / sum);
  }

  probs(d: Decision, state: Float64Array): { keys: string[]; probs: Float64Array } {
    const keys = d.options.map((o) => optionKey(d, o));
    return { keys, probs: this.softmax(this.logits(keys, this.hidden(this.normalize(state)))) };
  }

  forState(state: Float64Array, rng: Rng, trace?: Trace, greedy = false, epsilon = 0): Policy {
    const z = this.normalize(state);
    const h = this.hidden(z);
    return (d: Decision) => {
      const keys = d.options.map((o) => optionKey(d, o));
      const probs = this.softmax(this.logits(keys, h));
      const { chosen, sampled } = chooseIndex(probs, rng, greedy, epsilon);
      trace?.steps.push({ path: d.path, keys, probs, sampled, epsilon, chosen, state: z, rawState: state, cache: h });
      return chosen;
    };
  }

  newGrads(): MlpGrads { return { W1: new Float64Array(this.W1.length), b1: new Float64Array(this.H), heads: new Map() }; }

  accumulate(grads: MlpGrads, step: Step, advantage: number): void {
    const h = step.cache!;
    const scale = mixtureScale(step);
    const dh = new Float64Array(this.H);
    for (let j = 0; j < step.keys.length; j++) {
      const coeff = advantage * scale * ((j === step.chosen ? 1 : 0) - step.probs[j]);
      if (coeff === 0) continue;
      const key = step.keys[j];
      let g = grads.heads.get(key);
      if (!g) { g = new Float64Array(this.H + 1); grads.heads.set(key, g); }
      const v = this.heads.get(key);
      for (let u = 0; u < this.H; u++) {
        g[u] += coeff * h[u];
        if (v) dh[u] += coeff * v[u];
      }
      g[this.H] += coeff;
    }
    // Through tanh: da = dh * (1 - h^2); dW1 += da z^T; db1 += da.
    for (let u = 0; u < this.H; u++) {
      const da = dh[u] * (1 - h[u] * h[u]);
      if (da === 0) continue;
      grads.b1[u] += da;
      const row = u * STATE_DIM;
      for (let i = 0; i < STATE_DIM; i++) grads.W1[row + i] += da * step.state[i];
    }
  }

  scaleGrads(grads: MlpGrads, n: number): void {
    for (let i = 0; i < grads.W1.length; i++) grads.W1[i] /= n;
    for (let i = 0; i < grads.b1.length; i++) grads.b1[i] /= n;
    for (const g of grads.heads.values()) for (let i = 0; i < g.length; i++) g[i] /= n;
  }

  applyGradient(grads: MlpGrads, lr: number, l2 = 0, optimizer: 'sgd' | 'adam' = 'adam'): void {
    for (const k of grads.heads.keys()) this.head(k);
    this.steps++;
    this.adamW1.step(this.W1, grads.W1, lr, l2, this.steps, optimizer);
    this.adamB1.step(this.b1, grads.b1, lr, 0, this.steps, optimizer);
    const zero = new Float64Array(this.H + 1);
    for (const [k, v] of this.heads) {
      let a = this.adamHeads.get(k);
      if (!a) { a = new AdamState(this.H + 1); this.adamHeads.set(k, a); }
      // No decay on the head bias (last entry). Both parts step every
      // iteration, with a zero gradient when the key was absent from the
      // batch, so the Adam moments never fall out of sync with the timestep.
      const g = grads.heads.get(k) ?? zero;
      a.step(v, g, lr, l2, this.steps, optimizer, (i) => i < this.H);
      a.step(v, g, lr, 0, this.steps, optimizer, (i) => i === this.H);
    }
  }

  /**
   * Logit-preserving normaliser update. The input transform is affine, so
   * W1'_{ui} = W1_{ui} σ'_i/σ_i and b1'_u = b1_u + Σ_i W1_{ui}(m'_i − m_i)/σ_i
   * leave every hidden activation, and so every logit, unchanged.
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
    for (let u = 0; u < this.H; u++) {
      const row = u * STATE_DIM;
      let shift = 0;
      for (let i = 1; i < STATE_DIM; i++) {
        const ratio = this.scale[i] / oldScale[i];
        shift += (this.W1[row + i] * (this.mean[i] - oldMean[i])) / oldScale[i];
        this.W1[row + i] *= ratio;
        this.adamW1.rescale(row + i, ratio);
      }
      this.b1[u] += shift;
    }
  }

  toJSON(): { model: 'mlp'; hidden: number; mean: number[]; scale: number[]; W1: number[]; b1: number[]; heads: Record<string, number[]> } {
    return { model: 'mlp', hidden: this.H, mean: [...this.mean], scale: [...this.scale], W1: [...this.W1], b1: [...this.b1], heads: Object.fromEntries([...this.heads].map(([k, v]) => [k, [...v]])) };
  }

  static fromJSON(obj: ReturnType<MlpPolicy['toJSON']>): MlpPolicy {
    const p = new MlpPolicy(obj.hidden);
    p.mean.set(obj.mean); p.scale.set(obj.scale); p.W1.set(obj.W1); p.b1.set(obj.b1);
    for (const [k, v] of Object.entries(obj.heads)) p.heads.set(k, Float64Array.from(v));
    return p;
  }
}
