import { makeRng } from './rng.ts';
import { fakeData } from './fake-data.ts';
import { makePopulation } from './sim/users.ts';
import { randomScreenPolicy, runEpisodes } from './sim/episodes.ts';
import { choiceSummary, learnedScreenPolicy, train } from './policy/train.ts';

/**
 * Policy checks, kept short so `npm run check` stays fast: training is
 * deterministic per seed, a brief run improves on the untrained policy on a
 * held-out population, and the untrained policy behaves like per-decision
 * uniform random (its weights are zero).
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const opts = { iterations: 25, usersPerIteration: 120, maxSessions: 6, lr: 0.02, l2: 0.001, seed: 3 };
const evalPop = () => makePopulation(300, makeRng(4242));

const a = train(opts);
const b = train(opts);
report(JSON.stringify(a.policy.toJSON()) === JSON.stringify(b.policy.toJSON()), 'training is deterministic per seed');

const untrained = runEpisodes(learnedScreenPolicy(train({ ...opts, iterations: 0 }).policy), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
const uniform = runEpisodes(randomScreenPolicy('local'), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
report(Math.abs(untrained - uniform) < 1e-9, `untrained policy equals per-decision uniform random (${untrained.toFixed(2)} vs ${uniform.toFixed(2)})`);

// The value baseline must remove more return variance than the per-index one on the same batch.
{
  const one = { ...opts, iterations: 1 };
  const idx = train({ ...one, baseline: 'index' }).lastBatch;
  const val = train({ ...one, baseline: 'value' }).lastBatch;
  const ok = val.advantageVariance < idx.advantageVariance && val.advantageVariance < val.returnVariance;
  report(ok, `value baseline removes more variance than the per-index baseline (${(100 * (1 - val.advantageVariance / val.returnVariance)).toFixed(0)}% vs ${(100 * (1 - idx.advantageVariance / idx.returnVariance)).toFixed(0)}%)`);
}

const trained = runEpisodes(learnedScreenPolicy(a.policy), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
report(trained > untrained * 1.05, `25 iterations improve held-out reward by >5% (${untrained.toFixed(2)} -> ${trained.toFixed(2)})`);

// A normaliser update is logit-preserving: probabilities before and after are identical.
{
  const p = a.policy;
  const sp = learnedScreenPolicy(p);
  runEpisodes(sp, makePopulation(30, makeRng(99)), fakeData, 4, 99);
  const steps = [...sp.traces.values()].flatMap((t) => t.steps).filter((st) => st.rawState[1] > 0).slice(0, 200);
  const before = steps.map((st) => [...p.probs({ kind: 'props', path: '', component: 'Screen', context: 'screen', options: ['{"density":"compact"}', '{"density":"comfortable"}'], weights: [1n, 1n] }, st.rawState).probs]);
  p.updateNormalizer(steps.map((st) => st.rawState), 0.7);
  const after = steps.map((st) => [...p.probs({ kind: 'props', path: '', component: 'Screen', context: 'screen', options: ['{"density":"compact"}', '{"density":"comfortable"}'], weights: [1n, 1n] }, st.rawState).probs]);
  const maxDiff = Math.max(...before.map((b, i) => Math.max(...b.map((x, j) => Math.abs(x - after[i][j])))));
  report(maxDiff < 1e-9, `normaliser update preserves every decision probability (max change ${maxDiff.toExponential(1)})`);
}

// Personalisation: with history, power readers must be shown compact more
// often than browsers. This is the property the feature centring exists for;
// without it the gap sits at zero no matter how long training runs.
{
  const gap = (arch: string) => choiceSummary(learnedScreenPolicy(a.policy), makePopulation(200, makeRng(4343), arch), 6, 4343)!.compactDensity;
  const power = gap('power-reader');
  const browser = gap('browser');
  const points = (power - browser) * 100;
  report(points > 10, `learned policy conditions density on the user (compact for power readers ${(power * 100).toFixed(0)}%, browsers ${(browser * 100).toFixed(0)}%, gap ${points.toFixed(0)} points, need > 10)`);
}

console.log(failures ? `\n${failures} policy check(s) failed` : '\npolicy checks passed');
process.exit(failures ? 1 : 0);
