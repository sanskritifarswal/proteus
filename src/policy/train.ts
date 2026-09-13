import { mkdirSync, writeFileSync } from 'node:fs';
import type { UIDocument } from '../tree.ts';
import type { Rng } from '../rng.ts';
import { makeRng } from '../rng.ts';
import { sample } from '../sample.ts';
import { newsfeed } from '../grammars/newsfeed.ts';
import { fakeData } from '../fake-data.ts';
import { sessionReward } from '../reward.ts';
import { makePopulation, type SimUser } from '../sim/users.ts';
import { fixedScreenPolicy, loadExample, randomScreenPolicy, runEpisodes, type ScreenPolicy } from '../sim/episodes.ts';
import { stateFromHistory } from './features.ts';
import { LinearPolicy, type Trace } from './linear-policy.ts';

/**
 * REINFORCE over the factored policy.
 *
 * Each iteration: a fresh population runs one episode each under the current
 * policy, every decision is recorded with its state and probabilities, the
 * reward-to-go from each session is compared with a per-session-index
 * baseline, and the log-probability gradient of every decision is scaled by
 * that advantage. Plain policy gradient with a moving baseline; no value
 * network, no PyTorch. It is enough to show the loop closes.
 */
export interface TrainOptions {
  iterations: number;
  usersPerIteration: number;
  maxSessions: number;
  lr: number;
  l2: number;
  seed: number;
  /** Called after each iteration with the mean episode reward on the training batch. */
  onIteration?: (i: number, meanReward: number, policy: LinearPolicy) => void;
}

/** Wraps a LinearPolicy as a ScreenPolicy and keeps the trace of every session it produced. */
export function learnedScreenPolicy(policy: LinearPolicy, greedy = false): ScreenPolicy & { traces: Map<string, Trace> } {
  const traces = new Map<string, Trace>();
  const sp = ((user: SimUser, session: number, rng: Rng, history, rewards): UIDocument => {
    const state = stateFromHistory(history, rewards);
    const trace: Trace = { steps: [] };
    traces.set(`${user.id}:${session}`, trace);
    return sample(newsfeed, policy.forState(state, rng, trace, greedy));
  }) as ScreenPolicy & { traces: Map<string, Trace> };
  sp.traces = traces;
  return sp;
}

export function train(opts: TrainOptions): { policy: LinearPolicy; history: number[] } {
  const policy = new LinearPolicy();
  const baseline = new Float64Array(opts.maxSessions); // per session index
  const baselineN = new Float64Array(opts.maxSessions);
  const history: number[] = [];

  for (let it = 0; it < opts.iterations; it++) {
    const popSeed = opts.seed * 7919 + it;
    const users = makePopulation(opts.usersPerIteration, makeRng(popSeed));
    const sp = learnedScreenPolicy(policy);
    const { trajectories, stats } = runEpisodes(sp, users, fakeData, opts.maxSessions, popSeed);

    // Reward-to-go per session and advantages against the per-index baseline.
    type Item = { key: string; adv: number };
    const items: Item[] = [];
    for (const t of trajectories) {
      const rewards = t.sessions.map((s) => sessionReward(s));
      let g = 0;
      const togo = new Array<number>(rewards.length);
      for (let s = rewards.length - 1; s >= 0; s--) { g += rewards[s]; togo[s] = g; }
      for (let s = 0; s < rewards.length; s++) {
        items.push({ key: `${t.user}:${s}`, adv: togo[s] - baseline[s] });
        // Update the baseline after use, as a running mean.
        baselineN[s] += 1;
        baseline[s] += (togo[s] - baseline[s]) / baselineN[s];
      }
    }
    const mean = items.reduce((a, x) => a + x.adv, 0) / items.length;
    const sd = Math.sqrt(items.reduce((a, x) => a + (x.adv - mean) ** 2, 0) / items.length) || 1;

    const grads = new Map<string, Float64Array>();
    for (const { key, adv } of items) {
      const trace = sp.traces.get(key);
      if (!trace) continue;
      const a = (adv - mean) / sd;
      for (const step of trace.steps) LinearPolicy.accumulate(grads, step, a);
    }
    policy.applyGradient(grads, opts.lr / users.length, opts.l2);

    history.push(stats.meanEpisodeReward);
    opts.onIteration?.(it, stats.meanEpisodeReward, policy);
  }
  return { policy, history };
}

/** Frequency of some readable choices a policy makes for a population, at sessions >= `fromSession`. */
export function choiceSummary(sp: ScreenPolicy, users: SimUser[], maxSessions: number, seed: number, fromSession = 2) {
  const { trajectories } = runEpisodes(sp, users, fakeData, maxSessions, seed);
  let n = 0, compact = 0, sections = 0, heroLead = 0, compactItems = 0, items = 0, buttons = 0;
  for (const t of trajectories) for (const s of t.sessions) {
    if (s.session < fromSession) continue;
    n++;
    if (s.tree.props!.density === 'compact') compact++;
    const secs = (s.tree.slots!.sections as Array<{ slots: Record<string, unknown> }>);
    sections += secs.length;
    for (const sec of secs) {
      const coll = sec.slots.content as { slots: Record<string, { props: Record<string, string>; slots?: Record<string, unknown> }> };
      if (coll.slots.lead?.props.variant === 'hero') heroLead++;
      items++;
      if (coll.slots.item.props.variant === 'compact') compactItems++;
      buttons += ((coll.slots.item.slots?.actions as unknown[] | undefined)?.length ?? 0);
    }
  }
  return n === 0 ? null : {
    sessions: n,
    compactDensity: compact / n,
    sectionsPerScreen: sections / n,
    heroLeadPerScreen: heroLead / n,
    compactItemShare: compactItems / items,
    buttonsPerItemCard: buttons / items,
  };
}
