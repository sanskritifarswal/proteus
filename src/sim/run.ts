import { mkdirSync, writeFileSync } from 'node:fs';
import { makeRng } from '../rng.ts';
import { fakeData } from '../fake-data.ts';
import { makePopulation } from './users.ts';
import { fixedScreenPolicy, loadExample, randomScreenPolicy, runEpisodes, type ScreenPolicy } from './episodes.ts';

/**
 * usage: node src/sim/run.ts [--users N] [--sessions N] [--seed N] [--archetype name] [--out dir]
 * Runs every baseline policy on the same population and prints a comparison.
 * Writes one JSONL of trajectories per policy to --out (default out/).
 */
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const users = Number(opt('users', '200'));
const maxSessions = Number(opt('sessions', '10'));
const seed = Number(opt('seed', '1'));
const archetype = opt('archetype', '');
const outDir = opt('out', 'out');
if (![users, maxSessions, seed].every(Number.isInteger) || users < 1 || maxSessions < 1) {
  console.error('usage: node src/sim/run.ts [--users <int>] [--sessions <int>] [--seed <int>] [--archetype name] [--out dir]');
  process.exit(2);
}

const population = makePopulation(users, makeRng(seed), archetype || undefined);
const policies: Array<[string, ScreenPolicy]> = [
  ['random-local', randomScreenPolicy('local')],
  ['random-uniform', randomScreenPolicy('uniform')],
  ['fixed-editorial-home', fixedScreenPolicy(loadExample('editorial-home'))],
  ['fixed-dense-list', fixedScreenPolicy(loadExample('dense-list'))],
  ['fixed-visual-grid', fixedScreenPolicy(loadExample('visual-grid'))],
];

mkdirSync(outDir, { recursive: true });
const mix = population.reduce<Record<string, number>>((m, u) => ((m[u.archetype] = (m[u.archetype] ?? 0) + 1), m), {});
console.log(`population: ${users} users, seed ${seed}${archetype ? `, archetype ${archetype}` : ''} (${Object.entries(mix).map(([k, v]) => `${k} ${v}`).join(', ')}); up to ${maxSessions} sessions each\n`);
console.log(`${'policy'.padEnd(22)} ${'ep.reward'.padStart(9)} ${'sess/user'.padStart(9)} ${'return'.padStart(7)} ${'opens'.padStart(6)} ${'compl'.padStart(6)} ${'dismiss'.padStart(7)}`);
for (const [name, policy] of policies) {
  const { trajectories, stats: s } = runEpisodes(policy, population, fakeData, maxSessions, seed);
  writeFileSync(`${outDir}/sim-${name}.jsonl`, trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log(`${name.padEnd(22)} ${s.meanEpisodeReward.toFixed(2).padStart(9)} ${s.meanSessionsPerUser.toFixed(2).padStart(9)} ${(s.returnRate * 100).toFixed(0).padStart(6)}% ${s.opensPerSession.toFixed(2).padStart(6)} ${s.completionsPerSession.toFixed(2).padStart(6)} ${s.dismissalsPerSession.toFixed(2).padStart(7)}`);
}
console.log(`\ntrajectories written to ${outDir}/sim-*.jsonl`);
