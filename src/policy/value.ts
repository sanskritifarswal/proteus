import { STATE_DIM } from './features.ts';

/**
 * Linear state-value baseline V(s) = v · s, fit by ridge regression on a
 * batch of (state, reward-to-go) pairs. Subtracting V(s) from the
 * reward-to-go removes the part of the return that the state already
 * predicts, so the policy gradient only sees what the decisions changed.
 * That is where the variance reduction comes from.
 */
export class LinearValue {
  readonly v = new Float64Array(STATE_DIM);

  predict(state: Float64Array): number {
    let y = 0;
    for (let i = 0; i < STATE_DIM; i++) y += this.v[i] * state[i];
    return y;
  }

  /** Closed-form ridge fit: (XᵀX + λI) v = Xᵀy, solved by Gaussian elimination. */
  fit(states: Float64Array[], targets: number[], lambda = 1e-3): void {
    const n = STATE_DIM;
    const a: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? lambda : 0)));
    const b = new Array<number>(n).fill(0);
    for (let k = 0; k < states.length; k++) {
      const s = states[k];
      for (let i = 0; i < n; i++) {
        if (s[i] === 0) continue;
        b[i] += s[i] * targets[k];
        for (let j = 0; j < n; j++) a[i][j] += s[i] * s[j];
      }
    }
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      [b[c], b[p]] = [b[p], b[c]];
      const d = a[c][c];
      if (Math.abs(d) < 1e-12) continue;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c] / d;
        if (f === 0) continue;
        for (let j = c; j < n; j++) a[r][j] -= f * a[c][j];
        b[r] -= f * b[c];
      }
    }
    for (let i = 0; i < n; i++) this.v[i] = Math.abs(a[i][i]) < 1e-12 ? 0 : b[i] / a[i][i];
  }
}
