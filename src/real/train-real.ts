import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Decision } from '../sample.ts';
import { sessionReward } from '../reward.ts';
import { LinearPolicy } from '../policy/linear-policy.ts';
import { LinearValue } from '../policy/value.ts';
import type { Step } from '../policy/model.ts';
import { loadPolicyFile, SessionStore } from '../server.ts';

/**
 * Policy-gradient updates from real sessions.
 *
 * A stored session is usable when the server recorded the decision trace of
 * the screen it was served: the options offered at each decision, the
 * probabilities it was sampled from, and the choice. The reward-to-go is
 * computed from the user's later sessions (return derived from whether a
 * next session exists), a linear value baseline is fit on the real states,
 * and each decision's log-probability gradient under the *current* policy
 * is scaled by its advantage and by the importance weight
 * π_now(choice) / p_served(choice), clipped, since the policy may have moved
 * since the screen was served. Several Adam epochs over the batch.
 *
 * Sessions served greedily or without a trace are skipped and counted:
 * with no sampling probabilities there is no unbiased gradient.
 *
 * Linear policy only in this version: the MLP needs its hidden activations
 * recomputed per step, which is a small addition when it is wanted.
 */
export interface TrainRealOptions {
  store: string;
  policy: LinearPolicy;
  epochs?: number;
  lr?: number;
  l2?: number;
  /** Cap on the importance weight. */
  clip?: number;
}

export interface TrainRealReport {
  users: number;
  sessions: number;
  usable: number;
  skippedNoTrace: number;
  meanReward: number;
  /**
   * Per epoch: mean importance weight, and the surrogate objective, the
   * advantage-weighted mean log-probability of the served choices under the
   * current policy. Rising surrogate = the policy is moving toward what was
   * rewarded and away from what was not.
   */
  epochs: Array<{ meanWeight: number; surrogate: number }>;
}

export function trainReal(opts: TrainRealOptions): TrainRealReport {
  const store = new SessionStore(opts.store);
  const policy = opts.policy;
  const epochs = opts.epochs ?? 5;
  const lr = opts.lr ?? 0.02;
  const l2 = opts.l2 ?? 0.001;
  const clip = opts.clip ?? 5;

  type Item = { togo: number; rawState: Float64Array; steps: NonNullable<ReturnType<SessionStore['trace']>>['steps']; index: number };
  const items: Item[] = [];
  let sessions = 0, usable = 0, skippedNoTrace = 0, rewardSum = 0;
  const users = store.users();
  for (const user of users) {
    const list = store.sessions(user);
    const rewards = list.map((s) => sessionReward(s));
    let g = 0;
    const togo = new Array<number>(rewards.length);
    for (let s = rewards.length - 1; s >= 0; s--) { g = rewards[s] + g; togo[s] = g; }
    list.forEach((s, i) => {
      sessions++;
      rewardSum += rewards[i];
      const trace = store.trace(user, s.session);
      if (!trace || trace.steps.length === 0) { skippedNoTrace++; return; }
      usable++;
      items.push({ togo: togo[i], rawState: Float64Array.from(trace.steps[0].rawState), steps: trace.steps, index: i });
    });
  }
  const report: TrainRealReport = { users: users.length, sessions, usable, skippedNoTrace, meanReward: sessions ? rewardSum / sessions : 0, epochs: [] };
  if (items.length === 0) return report;

  const value = new LinearValue();
  value.fit(items.map((x) => x.rawState), items.map((x) => x.togo));
  const adv = items.map((x) => x.togo - value.predict(x.rawState));
  const mean = adv.reduce((a, b) => a + b, 0) / adv.length;
  const sd = Math.sqrt(adv.reduce((a, b) => a + (b - mean) ** 2, 0) / adv.length) || 1;
  const scaled = adv.map((a) => (a - mean) / sd);

  for (let e = 0; e < epochs; e++) {
    const grads = policy.newGrads();
    let wSum = 0, surrogate = 0, n = 0;
    items.forEach((item, i) => {
      for (const st of item.steps) {
        const decision: Decision = { ...st.decision, weights: [] };
        const { keys, probs } = policy.probs(decision, item.rawState);
        const served = st.sampled[st.chosen];
        const w = Math.min(clip, served > 0 ? probs[st.chosen] / served : 0);
        wSum += w; surrogate += scaled[i] * Math.log(Math.max(probs[st.chosen], 1e-12)); n++;
        const step: Step = { path: st.decision.path, keys, probs, sampled: probs, epsilon: 0, chosen: st.chosen, state: policy.normalize(item.rawState), rawState: item.rawState };
        policy.accumulate(grads, step, scaled[i] * w);
      }
    });
    policy.scaleGrads(grads, items.length);
    policy.applyGradient(grads, lr, l2, 'adam');
    report.epochs.push({ meanWeight: n ? wSum / n : 0, surrogate: n ? surrogate / n : 0 });
  }
  policy.updateNormalizer(items.filter((x) => x.index > 0).map((x) => x.rawState));
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('train-real.ts')) {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const store = opt('store', 'out/server');
  const policyFile = opt('policy-file', 'out/policy.json');
  const out = opt('out', 'out/policy-real.json');
  const epochs = Number(opt('epochs', '5'));
  const lr = Number(opt('lr', '0.02'));
  if (!existsSync(policyFile)) { console.error(`no policy at ${policyFile}`); process.exit(1); }
  if (!Number.isInteger(epochs) || epochs < 1 || !(lr > 0)) { console.error('usage: node src/real/train-real.ts [--store dir] [--policy-file f] [--out f] [--epochs <int>] [--lr <float>]'); process.exit(2); }
  const loaded = loadPolicyFile(policyFile);
  if (!(loaded instanceof LinearPolicy)) { console.error('train-real supports the linear policy in this version'); process.exit(1); }
  const report = trainReal({ store, policy: loaded, epochs, lr });
  console.log(`${report.users} users, ${report.sessions} sessions, ${report.usable} with traces (${report.skippedNoTrace} skipped: no trace), mean reward ${report.meanReward.toFixed(2)}`);
  report.epochs.forEach((e, i) => console.log(`  epoch ${i + 1}: mean importance weight ${e.meanWeight.toFixed(3)}, surrogate ${e.surrogate.toFixed(4)}`));
  if (report.usable === 0) { console.error('nothing to train on: serve with --epsilon > 0 so traces are recorded'); process.exit(1); }
  writeFileSync(out, JSON.stringify(loaded.toJSON()));
  console.log(`updated policy written to ${out}`);
}
