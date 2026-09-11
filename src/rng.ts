/** Small seeded PRNG (mulberry32) so samples are reproducible. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform bigint in [0, n). */
  bigint(n: bigint): bigint;
}

export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    bigint: (n) => {
      // Draw 64 bits more than needed and reduce; the modulo bias is < 2^-64.
      const bits = n.toString(2).length + 64;
      let r = 0n;
      for (let i = 0; i < bits; i += 32) r = (r << 32n) | BigInt(Math.floor(next() * 4294967296));
      return r % n;
    },
  };
}
