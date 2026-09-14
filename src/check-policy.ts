import { makeRng } from './rng.ts';
import { fakeData } from './fake-data.ts';
import { makePopulation } from './sim/users.ts';
import { randomScreenPolicy, runEpisodes } from './sim/episodes.ts';
import { choiceSummary, learnedScreenPolicy, train } from './policy/train.ts';
import { STATE_NAMES } from './policy/features.ts';

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

// The MLP: untrained equals uniform (heads start at zero), a normaliser
// update preserves every probability, and short training improves.
{
  const mlp0 = train({ ...opts, iterations: 0, model: 'mlp' }).policy;
  const u = runEpisodes(learnedScreenPolicy(mlp0), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
  report(Math.abs(u - uniform) < 1e-9, `untrained MLP equals per-decision uniform random (${u.toFixed(2)} vs ${uniform.toFixed(2)})`);
  const m = train({ ...opts, model: 'mlp' }).policy;
  const sp = learnedScreenPolicy(m);
  runEpisodes(sp, makePopulation(30, makeRng(98)), fakeData, 4, 98);
  const steps = [...sp.traces.values()].flatMap((t) => t.steps).filter((st) => st.rawState[1] > 0).slice(0, 200);
  const dec = { kind: 'props' as const, path: '', component: 'Screen', context: 'screen', options: ['{"density":"compact"}', '{"density":"comfortable"}'], weights: [1n, 1n] };
  const before = steps.map((st) => [...m.probs(dec, st.rawState).probs]);
  m.updateNormalizer(steps.map((st) => st.rawState), 0.7);
  const after = steps.map((st) => [...m.probs(dec, st.rawState).probs]);
  const maxDiff = Math.max(...before.map((b, i) => Math.max(...b.map((x, j) => Math.abs(x - after[i][j])))));
  report(maxDiff < 1e-9, `MLP normaliser update preserves every decision probability (max change ${maxDiff.toExponential(1)})`);
  const t = runEpisodes(learnedScreenPolicy(m), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
  report(t > untrained * 1.05, `25 iterations improve the MLP's held-out reward by >5% (${untrained.toFixed(2)} -> ${t.toFixed(2)})`);
}

// Within-episode experimentation: on the twins (identical engagement
// statistics, opposite density preferences) only the choice-evidence
// features can tell users apart. With them the policy shows compact to
// twin-compact far more than to twin-comfortable; with them zeroed it cannot.
{
  const TWINS = ['twin-compact', 'twin-comfortable'];
  const EVIDENCE = ['evCompactDensity', 'evCompactItems', 'evHeroLead', 'evButtons'].map((n) => STATE_NAMES.indexOf(n as typeof STATE_NAMES[number]));
  const twinGap = (mask: number[]) => {
    const { policy } = train({ iterations: 40, usersPerIteration: 120, maxSessions: 8, lr: 0.02, l2: 0.001, seed: 5, archetypes: TWINS, maskFeatures: mask });
    const c = (a: string) => choiceSummary(learnedScreenPolicy(policy, false, 0, mask), makePopulation(200, makeRng(5151), a), 8, 5151)!.compactDensity;
    return (c('twin-compact') - c('twin-comfortable')) * 100;
  };
  const full = twinGap([]);
  const ablated = twinGap(EVIDENCE);
  report(full > 20 && Math.abs(ablated) < 15 && full > ablated + 15, `evidence features let the policy tell the twins apart (gap ${full.toFixed(0)} points with them, ${ablated.toFixed(0)} without)`);
}

console.log(failures ? `\n${failures} policy check(s) failed` : '\npolicy checks passed');
process.exit(failures ? 1 : 0);
