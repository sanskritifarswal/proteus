import { readFileSync } from 'node:fs';
import type { UIDocument } from '../tree.ts';
import type { Trajectory } from '../events.ts';
import type { FeedData } from '../fake-data.ts';
import { makeRng, type Rng } from '../rng.ts';
import { localUniform, sample, uniformDerivation, type Policy } from '../sample.ts';
import { sessionReward, type RewardWeights, defaultWeights } from '../reward.ts';
import { simulateSession, type SimState } from './simulate.ts';
import type { SimUser } from './users.ts';
import { newsfeed } from '../grammars/newsfeed.ts';

/**
 * Episode = one user over up to `maxSessions` sessions; it ends early when
 * the user does not return. A ScreenPolicy picks the tree for each session.
 * Baselines: a random derivation per session, or one fixed tree.
 */
export type ScreenPolicy = (user: SimUser, session: number, rng: Rng) => UIDocument;

export function randomScreenPolicy(kind: 'local' | 'uniform'): ScreenPolicy {
  return (_user, _session, rng) => {
    const p: Policy = kind === 'uniform' ? uniformDerivation(rng) : localUniform(rng);
    return sample(newsfeed, p);
  };
}

export function fixedScreenPolicy(doc: UIDocument): ScreenPolicy {
  return () => doc;
}

export function loadExample(name: string): UIDocument {
  return JSON.parse(readFileSync(`examples/valid/${name}.json`, 'utf8')) as UIDocument;
}

export interface EpisodeStats {
  users: number;
  sessions: number;
  /** Sessions whose return outcome was observed (not censored at the cap). */
  observedSessions: number;
  meanEpisodeReward: number;
  meanSessionReward: number;
  meanSessionsPerUser: number;
  returnRate: number;
  opensPerSession: number;
  completionsPerSession: number;
  dismissalsPerSession: number;
}

export function runEpisodes(
  policy: ScreenPolicy, users: SimUser[], data: FeedData, maxSessions: number, seed: number, weights: RewardWeights = defaultWeights,
): { trajectories: Trajectory[]; stats: EpisodeStats } {
  if (users.length === 0) throw new Error('runEpisodes: population is empty');
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error(`runEpisodes: maxSessions must be a positive integer (got ${maxSessions})`);
  const trajectories: Trajectory[] = [];
  let sessions = 0;
  let observed = 0;
  let totalReward = 0;
  let returns = 0;
  let opens = 0;
  let completions = 0;
  let dismissals = 0;

  users.forEach((user, ui) => {
    const rng = makeRng(seed * 1_000_003 + ui);
    const state: SimState = { seen: new Set(), sessionsSoFar: 0 };
    const traj: Trajectory = { user: user.id, sessions: [] };
    for (let s = 0; s < maxSessions; s++) {
      const doc = policy(user, s, rng);
      const rec = simulateSession(user, doc.tree, data, doc.grammar, s, state, rng);
      // The window ends at maxSessions: a return after the last session is
      // never observed, so it is censored rather than counted.
      if (s === maxSessions - 1 && rec.returned) rec.returned = null;
      traj.sessions.push(rec);
      sessions++;
      totalReward += sessionReward(rec, weights);
      if (rec.returned !== null) observed++;
      if (rec.returned) returns++;
      for (const e of rec.events) {
        if (e.type === 'open') opens++;
        if (e.type === 'complete' && (e.value ?? 0) > 0.6) completions++;
        if (e.type === 'action' && e.action === 'dismiss') dismissals++;
      }
      if (!rec.returned) break;
    }
    trajectories.push(traj);
  });

  return {
    trajectories,
    stats: {
      users: users.length,
      sessions,
      observedSessions: observed,
      meanEpisodeReward: totalReward / users.length,
      meanSessionReward: totalReward / sessions,
      meanSessionsPerUser: sessions / users.length,
      returnRate: observed ? returns / observed : 0,
      opensPerSession: opens / sessions,
      completionsPerSession: completions / sessions,
      dismissalsPerSession: dismissals / sessions,
    },
  };
}
