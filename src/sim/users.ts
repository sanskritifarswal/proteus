import type { Rng } from '../rng.ts';

/**
 * Synthetic readers. Each has latent preferences the policy never sees
 * directly; it only sees their behaviour through events. Archetypes give
 * the population structure a policy could plausibly learn; per-user noise
 * keeps it from being four users in disguise.
 *
 * Everything here is deliberately crude and hand-designed. Fidelity is an
 * open-ended problem (the sim-to-real gap); the point of v1 is to have a
 * population whose preferences visibly move the reward, so that policies
 * can be told apart at all.
 */
export interface SimUser {
  id: string;
  archetype: string;
  /** -1 prefers compact spacing, +1 prefers comfortable. */
  densityPref: number;
  /** -1 prefers text rows, +1 prefers big images. */
  visualPref: number;
  /** Topic affinity, -1..1. Missing topic = 0. */
  topics: Record<string, number>;
  /** Roughly how many items they look at before leaving. */
  patience: number;
  /** Base log-odds of opening a relevant item. */
  curiosity: number;
  /** Typical fraction of an article they read. */
  readDepth: number;
  /** Propensity to save / share / follow. */
  social: number;
  /** Baseline probability of coming back next session. */
  returnBase: number;
}

export const TOPICS = ['Local', 'Economy', 'Sport', 'Science', 'Culture', 'Work', 'Weather', 'Money', 'Food', 'Tech', 'Health', 'Design', 'Education'];

interface Archetype {
  name: string;
  weight: number;
  base: Omit<SimUser, 'id' | 'archetype' | 'topics'>;
  likes: string[];
  dislikes: string[];
}

export const ARCHETYPES: Archetype[] = [
  {
    name: 'power-reader', weight: 0.25,
    base: { densityPref: -0.9, visualPref: -0.8, patience: 22, curiosity: 0.2, readDepth: 0.8, social: 0.4, returnBase: 0.8 },
    likes: ['Economy', 'Tech', 'Science', 'Money'], dislikes: ['Sport'],
  },
  {
    name: 'browser', weight: 0.35,
    base: { densityPref: 0.8, visualPref: 0.9, patience: 8, curiosity: -0.4, readDepth: 0.35, social: 0.6, returnBase: 0.55 },
    likes: ['Culture', 'Food', 'Design', 'Sport'], dislikes: ['Economy'],
  },
  {
    name: 'local-loyalist', weight: 0.2,
    base: { densityPref: 0.2, visualPref: 0.1, patience: 12, curiosity: -0.1, readDepth: 0.6, social: 0.3, returnBase: 0.7 },
    likes: ['Local', 'Weather', 'Education'], dislikes: ['Tech'],
  },
  {
    name: 'casual', weight: 0.2,
    base: { densityPref: 0.3, visualPref: 0.4, patience: 6, curiosity: -0.8, readDepth: 0.3, social: 0.15, returnBase: 0.4 },
    likes: ['Health', 'Food'], dislikes: [],
  },
];

function normal(rng: Rng): number {
  const u = 1 - rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function makeUser(id: string, rng: Rng, archetype?: Archetype): SimUser {
  let a = archetype;
  if (!a) {
    let r = rng.next() * ARCHETYPES.reduce((s, x) => s + x.weight, 0);
    a = ARCHETYPES[ARCHETYPES.length - 1];
    for (const x of ARCHETYPES) { if (r < x.weight) { a = x; break; } r -= x.weight; }
  }
  const b = a.base;
  const topics: Record<string, number> = {};
  for (const t of TOPICS) topics[t] = clamp(0.15 * normal(rng), -1, 1);
  for (const t of a.likes) topics[t] = clamp(0.7 + 0.2 * normal(rng), -1, 1);
  for (const t of a.dislikes) topics[t] = clamp(-0.7 + 0.2 * normal(rng), -1, 1);
  return {
    id, archetype: a.name, topics,
    densityPref: clamp(b.densityPref + 0.25 * normal(rng), -1, 1),
    visualPref: clamp(b.visualPref + 0.25 * normal(rng), -1, 1),
    patience: Math.max(2, b.patience * Math.exp(0.3 * normal(rng))),
    curiosity: b.curiosity + 0.3 * normal(rng),
    readDepth: clamp(b.readDepth + 0.12 * normal(rng), 0.05, 1),
    social: clamp(b.social + 0.15 * normal(rng), 0, 1),
    returnBase: clamp(b.returnBase + 0.1 * normal(rng), 0.05, 0.98),
  };
}

export function makePopulation(n: number, rng: Rng, archetype?: string): SimUser[] {
  const a = archetype ? ARCHETYPES.find((x) => x.name === archetype) : undefined;
  if (archetype && !a) throw new Error(`unknown archetype '${archetype}'`);
  return Array.from({ length: n }, (_, i) => makeUser(`u${i}`, rng, a));
}
