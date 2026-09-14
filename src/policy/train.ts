import { mkdirSync, writeFileSync } from 'node:fs';
import type { UIDocument } from '../tree.ts';
import type { Rng } from '../rng.ts';
import { makeRng } from '../rng.ts';
import { sample } from '../sample.ts';
import { newsfeed } from '../grammars/newsfeed.ts';
import { fakeData } from '../fake-data.ts';
import { attributeReward, sessionReward } from '../reward.ts';
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
  /**
   * 'session': every decision in a session shares the session's advantage.
   * 'path': a decision is credited with the reward attributed to event paths
   * related to its own path (its subtree, or an ancestor), plus the shared
   * session-level part; the local part is baselined per decision key.
   */
  credit?: 'session' | 'path';
  /** Called after each iteration with the mean episode reward on the training batch. */
  onIteration?: (i: number, meanReward: number, policy: LinearPolicy) => void;
}

/** Wraps a LinearPolicy as a ScreenPolicy and keeps the trace of every session it produced. */
const topicByTitle = new Map<string, string>();
for (const feed of Object.values(fakeData.feeds)) for (const a of feed.articles) topicByTitle.set(a.title, a.topic);
const topicOf = (title: string) => topicByTitle.get(title);

export function learnedScreenPolicy(policy: LinearPolicy, greedy = false, epsilon = 0): ScreenPolicy & { traces: Map<string, Trace> } {
  const traces = new Map<string, Trace>();
  const sp = ((user: SimUser, session: number, rng: Rng, history, rewards): UIDocument => {
    const state = stateFromHistory(history, rewards, topicOf);
    const trace: Trace = { steps: [] };
    traces.set(`${user.id}:${session}`, trace);
    return sample(newsfeed, policy.forState(state, rng, trace, greedy, epsilon));
  }) as ScreenPolicy & { traces: Map<string, Trace> };
  sp.traces = traces;
  return sp;
}

/** Segment-aware: is one path an ancestor-or-self of the other? The root ('') relates to everything. */
export function related(decisionPath: string, eventPath: string): boolean {
  const pre = (a: string, b: string) => a === '' || b === a || b.startsWith(a + '.') || b.startsWith(a + '[');
  return pre(decisionPath, eventPath) || pre(eventPath, decisionPath);
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
  const credit = opts.credit ?? 'session';
  const localBaseline = new Map<string, { mean: number; n: number }>();
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
    // With path credit the session-level part is the shared remainder of this
    // session plus all later sessions; the local part is what happened under
    // the decision's own subtree this session.
    type Item = { key: string; togo: number; state: Float64Array; index: number; local: number[] };
    const items: Item[] = [];
    for (const t of trajectories) {
      const rewards = t.sessions.map((s) => sessionReward(s));
      const attributed = credit === 'path' ? t.sessions.map((s) => attributeReward(s)) : [];
      let g = 0;
      const togo = new Array<number>(rewards.length);
      for (let s = rewards.length - 1; s >= 0; s--) { g = rewards[s] + gamma * g; togo[s] = g; }
      for (let s = 0; s < rewards.length; s++) {
        const key = `${t.user}:${s}`;
        const trace = sp.traces.get(key);
        if (!trace || trace.steps.length === 0) continue;
        if (credit === 'path') {
          const { byPath, shared } = attributed[s];
          const futureTogo = togo[s] - rewards[s];
          const local = trace.steps.map((step) => {
            let sum = 0;
            for (const [ep, v] of byPath) if (related(step.path, ep)) sum += v;
            return sum;
          });
          items.push({ key, togo: shared + futureTogo, state: trace.steps[0].rawState, index: s, local });
        } else {
          items.push({ key, togo: togo[s], state: trace.steps[0].rawState, index: s, local: [] });
        }
      }
    }
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
    const groupSd = new Array<number>(advantages.length);
    for (const idx of groups.values()) {
      const vals = idx.map((i) => advantages[i]);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(variance(vals)) || 1;
      for (const i of idx) { scaled[i] = (advantages[i] - m) / sd; groupSd[i] = sd; }
    }

    // Local (path) advantages: baselined by a running mean per decision key,
    // then divided by the same spread that standardised this item's
    // session-level advantage (its own group's), so the two parts are
    // commensurate at every session index.
    const grads = new Map<string, Float64Array>();
    items.forEach(({ key, local }, i) => {
      const trace = sp.traces.get(key)!;
      trace.steps.forEach((step, j) => {
        let a = scaled[i];
        if (credit === 'path') {
          const k = step.keys[step.chosen].split('|').slice(0, 3).join('|');
          const b = localBaseline.get(k) ?? { mean: 0, n: 0 };
          a += (local[j] - b.mean) / groupSd[i];
          b.n += 1; b.mean += (local[j] - b.mean) / b.n; localBaseline.set(k, b);
        }
        LinearPolicy.accumulate(grads, step, a);
      });
    });
    // Adam is scale-free, so it gets the mean gradient at lr; SGD keeps lr / users.
    if (optimizer === 'adam') for (const g of grads.values()) for (let i = 0; i < g.length; i++) g[i] /= users.length;
    policy.applyGradient(grads, optimizer === 'adam' ? opts.lr : opts.lr / users.length, opts.l2, optimizer);

    // Normaliser statistics come from sessions with history (session 0 is all
    // zeros). Updated after the step so the gradient was applied in the same
    // coordinates that produced its samples; the update itself is logit-
    // preserving, so it changes nothing the optimizer did not.
    policy.updateNormalizer(items.filter((x) => x.index > 0).map((x) => x.state));

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
