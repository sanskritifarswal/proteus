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
import { LinearValue } from './value.ts';

/**
 * REINFORCE over the factored policy.
 *
 * Each iteration: a fresh population runs one episode each under the current
 * policy, every decision is recorded with its state and probabilities, the
 * (discounted) reward-to-go from each session is compared with a baseline,
 * and the log-probability gradient of every decision is scaled by that
 * advantage. Two baselines: a running mean per session index, or a linear
 * value function of the state (ridge-fit on each batch), which removes the
 * part of the return the state already predicts and leaves the gradient
 * only what the decisions changed.
 */
export interface TrainOptions {
  iterations: number;
  usersPerIteration: number;
  maxSessions: number;
  lr: number;
  l2: number;
  seed: number;
  /** Discount on future sessions when computing reward-to-go. 1 = undiscounted. */
  gamma?: number;
  /** 'index': running mean per session index. 'value': linear V(state) fit per batch. */
  baseline?: 'index' | 'value';
  /** Uniform exploration mixed into every decision while training. 0 = pure policy. */
  epsilon?: number;
  /** Standardise advantages over the whole batch, or separately per session index. */
  standardize?: 'batch' | 'index';
  /** 'sgd' scales the summed gradient by lr / users; 'adam' normalises per weight. */
  optimizer?: 'sgd' | 'adam';
  /** Called after each iteration with the mean episode reward on the training batch. */
  onIteration?: (i: number, meanReward: number, policy: LinearPolicy) => void;
}

/** Wraps a LinearPolicy as a ScreenPolicy and keeps the trace of every session it produced. */
export function learnedScreenPolicy(policy: LinearPolicy, greedy = false, epsilon = 0): ScreenPolicy & { traces: Map<string, Trace> } {
  const traces = new Map<string, Trace>();
  const sp = ((user: SimUser, session: number, rng: Rng, history, rewards): UIDocument => {
    const state = stateFromHistory(history, rewards);
    const trace: Trace = { steps: [] };
    traces.set(`${user.id}:${session}`, trace);
    return sample(newsfeed, policy.forState(state, rng, trace, greedy, epsilon));
  }) as ScreenPolicy & { traces: Map<string, Trace> };
  sp.traces = traces;
  return sp;
}

export interface TrainResult {
  policy: LinearPolicy;
  value: LinearValue;
  history: number[];
  /** Variance of the raw and baselined returns on the last batch, to see what the baseline bought. */
  lastBatch: { returnVariance: number; advantageVariance: number };
}

export function train(opts: TrainOptions): TrainResult {
  const gamma = opts.gamma ?? 1;
  const mode = opts.baseline ?? 'value';
  const epsilon = opts.epsilon ?? 0.1;
  const standardize = opts.standardize ?? 'index';
  const optimizer = opts.optimizer ?? 'adam';
  const policy = new LinearPolicy();
  const value = new LinearValue();
  const indexBaseline = new Float64Array(opts.maxSessions);
  const indexN = new Float64Array(opts.maxSessions);
  const history: number[] = [];
  let lastBatch = { returnVariance: 0, advantageVariance: 0 };

  for (let it = 0; it < opts.iterations; it++) {
    const popSeed = opts.seed * 7919 + it;
    const users = makePopulation(opts.usersPerIteration, makeRng(popSeed));
    const sp = learnedScreenPolicy(policy, false, epsilon);
    const { trajectories, stats } = runEpisodes(sp, users, fakeData, opts.maxSessions, popSeed);

    // Discounted reward-to-go per session, then advantages against the baseline.
    type Item = { key: string; togo: number; state: Float64Array; index: number };
    const items: Item[] = [];
    for (const t of trajectories) {
      const rewards = t.sessions.map((s) => sessionReward(s));
      let g = 0;
      const togo = new Array<number>(rewards.length);
      for (let s = rewards.length - 1; s >= 0; s--) { g = rewards[s] + gamma * g; togo[s] = g; }
      for (let s = 0; s < rewards.length; s++) {
        const key = `${t.user}:${s}`;
        const trace = sp.traces.get(key);
        if (!trace || trace.steps.length === 0) continue;
        items.push({ key, togo: togo[s], state: trace.steps[0].rawState, index: s });
      }
    }
    // Normaliser statistics come from sessions with history; session 0 is
    // all zeros and would only drag the means down.
    policy.updateNormalizer(items.filter((x) => x.index > 0).map((x) => x.state));

    let advantages: number[];
    if (mode === 'value') {
      value.fit(items.map((x) => x.state), items.map((x) => x.togo));
      advantages = items.map((x) => x.togo - value.predict(x.state));
    } else {
      advantages = items.map((x) => x.togo - indexBaseline[x.index]);
      for (const x of items) {
        indexN[x.index] += 1;
        indexBaseline[x.index] += (x.togo - indexBaseline[x.index]) / indexN[x.index];
      }
    }
    const variance = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length; };
    lastBatch = { returnVariance: variance(items.map((x) => x.togo)), advantageVariance: variance(advantages) };
    // Standardise. Session 0 is cold for everyone, so its returns carry the
    // whole hidden-type variance; standardising per index keeps that from
    // shrinking every later session's signal.
    const groups = new Map<number, number[]>();
    items.forEach((x, i) => { const k = standardize === 'index' ? x.index : 0; (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); });
    const scaled = new Array<number>(advantages.length);
    for (const idx of groups.values()) {
      const vals = idx.map((i) => advantages[i]);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(variance(vals)) || 1;
      for (const i of idx) scaled[i] = (advantages[i] - m) / sd;
    }

    const grads = new Map<string, Float64Array>();
    items.forEach(({ key }, i) => {
      const trace = sp.traces.get(key)!;
      for (const step of trace.steps) LinearPolicy.accumulate(grads, step, scaled[i]);
    });
    // Adam is scale-free, so it gets the mean gradient at lr; SGD keeps lr / users.
    if (optimizer === 'adam') for (const g of grads.values()) for (let i = 0; i < g.length; i++) g[i] /= users.length;
    policy.applyGradient(grads, optimizer === 'adam' ? opts.lr : opts.lr / users.length, opts.l2, optimizer);

    history.push(stats.meanEpisodeReward);
    opts.onIteration?.(it, stats.meanEpisodeReward, policy);
  }
  return { policy, value, history, lastBatch };
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
