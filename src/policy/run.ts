import { mkdirSync, writeFileSync } from 'node:fs';
import { makeRng } from '../rng.ts';
import { fakeData } from '../fake-data.ts';
import { makePopulation } from '../sim/users.ts';
import { fixedScreenPolicy, loadExample, randomScreenPolicy, runEpisodes, type ScreenPolicy } from '../sim/episodes.ts';
import { choiceSummary, learnedScreenPolicy, train } from './train.ts';
import { STATE_NAMES } from './features.ts';

/**
 * usage: node src/policy/run.ts [--iterations N] [--users N] [--sessions N] [--lr X] [--seed N] [--out dir]
 * Trains the linear policy, then evaluates it against the baselines on a
 * held-out population (different seed) and prints what it learned to do
 * for each archetype.
 */
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const iterations = Number(opt('iterations', '80'));
const usersPerIteration = Number(opt('users', '150'));
const maxSessions = Number(opt('sessions', '10'));
const lr = Number(opt('lr', '0.15'));
const seed = Number(opt('seed', '1'));
const outDir = opt('out', 'out');
if (![iterations, usersPerIteration, maxSessions, seed].every(Number.isInteger)
  || iterations < 1 || usersPerIteration < 1 || maxSessions < 1
  || !Number.isFinite(lr) || !(lr > 0)) {
  console.error('usage: node src/policy/run.ts [--iterations <int>] [--users <int>] [--sessions <int>] [--lr <float>] [--seed <int>] [--out dir]');
  process.exit(2);
}

console.log(`training: ${iterations} iterations x ${usersPerIteration} users x up to ${maxSessions} sessions, lr ${lr}, seed ${seed}`);
const t0 = Date.now();
const { policy, history } = train({
  iterations, usersPerIteration, maxSessions, lr, l2: 0.001, seed,
  onIteration: (i, r) => { if (i % 10 === 0 || i === iterations - 1) console.log(`  iter ${String(i).padStart(3)}  train mean episode reward ${r.toFixed(2)}`); },
});
console.log(`trained in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${policy.weights.size} option keys x ${STATE_NAMES.length} state features\n`);

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/policy.json`, JSON.stringify(policy.toJSON()));

// Held-out evaluation: a population the trainer never saw.
const evalSeed = 999_001;
const evalPop = makePopulation(400, makeRng(evalSeed));
const policies: Array<[string, ScreenPolicy]> = [
  ['random-local', randomScreenPolicy('local')],
  ['random-uniform', randomScreenPolicy('uniform')],
  ['fixed-editorial-home', fixedScreenPolicy(loadExample('editorial-home'))],
  ['fixed-dense-list', fixedScreenPolicy(loadExample('dense-list'))],
  ['fixed-visual-grid', fixedScreenPolicy(loadExample('visual-grid'))],
  ['learned (sampled)', learnedScreenPolicy(policy)],
  ['learned (greedy)', learnedScreenPolicy(policy, true)],
];
console.log(`held-out evaluation: 400 mixed users, seed ${evalSeed}\n`);
console.log(`${'policy'.padEnd(22)} ${'ep.reward'.padStart(9)} ${'sess/user'.padStart(9)} ${'return'.padStart(7)} ${'opens'.padStart(6)} ${'compl'.padStart(6)} ${'dismiss'.padStart(7)}`);
for (const [name, sp] of policies) {
  const s = runEpisodes(sp, evalPop, fakeData, maxSessions, evalSeed).stats;
  console.log(`${name.padEnd(22)} ${s.meanEpisodeReward.toFixed(2).padStart(9)} ${s.meanSessionsPerUser.toFixed(2).padStart(9)} ${(s.returnRate * 100).toFixed(0).padStart(6)}% ${s.opensPerSession.toFixed(2).padStart(6)} ${s.completionsPerSession.toFixed(2).padStart(6)} ${s.dismissalsPerSession.toFixed(2).padStart(7)}`);
}

// What did it learn to do for whom? Choices at sessions >= 2, when history exists.
console.log(`\nlearned policy (sampled), choices from session 2 on, by archetype:\n`);
console.log(`${'archetype'.padEnd(16)} ${'reward'.padStart(7)} ${'compact'.padStart(8)} ${'sections'.padStart(9)} ${'heroLead'.padStart(9)} ${'compactItems'.padStart(13)} ${'btns/card'.padStart(10)}`);
for (const a of ['power-reader', 'browser', 'local-loyalist', 'casual']) {
  const pop = makePopulation(200, makeRng(evalSeed + 7), a);
  const sp = learnedScreenPolicy(policy);
  const r = runEpisodes(sp, pop, fakeData, maxSessions, evalSeed + 7).stats.meanEpisodeReward;
  const c = choiceSummary(learnedScreenPolicy(policy), pop, maxSessions, evalSeed + 7)!;
  console.log(`${a.padEnd(16)} ${r.toFixed(1).padStart(7)} ${(c.compactDensity * 100).toFixed(0).padStart(7)}% ${c.sectionsPerScreen.toFixed(1).padStart(9)} ${c.heroLeadPerScreen.toFixed(2).padStart(9)} ${(c.compactItemShare * 100).toFixed(0).padStart(12)}% ${c.buttonsPerItemCard.toFixed(2).padStart(10)}`);
}
console.log(`\npolicy weights written to ${outDir}/policy.json`);
