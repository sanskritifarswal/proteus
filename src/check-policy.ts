import { makeRng } from './rng.ts';
import { fakeData } from './fake-data.ts';
import { makePopulation } from './sim/users.ts';
import { randomScreenPolicy, runEpisodes } from './sim/episodes.ts';
import { learnedScreenPolicy, train } from './policy/train.ts';

/**
 * Policy checks, kept short so `npm run check` stays fast: training is
 * deterministic per seed, a brief run improves on the untrained policy on a
 * held-out population, and the untrained policy behaves like per-decision
 * uniform random (its weights are zero).
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const opts = { iterations: 25, usersPerIteration: 120, maxSessions: 6, lr: 0.15, l2: 0.001, seed: 3 };
const evalPop = () => makePopulation(300, makeRng(4242));

const a = train(opts);
const b = train(opts);
report(JSON.stringify(a.policy.toJSON()) === JSON.stringify(b.policy.toJSON()), 'training is deterministic per seed');

const untrained = runEpisodes(learnedScreenPolicy(train({ ...opts, iterations: 0 }).policy), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
const uniform = runEpisodes(randomScreenPolicy('local'), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
report(Math.abs(untrained - uniform) < 1e-9, `untrained policy equals per-decision uniform random (${untrained.toFixed(2)} vs ${uniform.toFixed(2)})`);

const trained = runEpisodes(learnedScreenPolicy(a.policy), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
report(trained > untrained * 1.05, `25 iterations improve held-out reward by >5% (${untrained.toFixed(2)} -> ${trained.toFixed(2)})`);

console.log(failures ? `\n${failures} policy check(s) failed` : '\npolicy checks passed');
process.exit(failures ? 1 : 0);
