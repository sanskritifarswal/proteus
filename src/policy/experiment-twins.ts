import { makeRng } from '../rng.ts';
import { fakeData } from '../fake-data.ts';
import { makePopulation } from '../sim/users.ts';
import { fixedScreenPolicy, loadExample, randomScreenPolicy, runEpisodes } from '../sim/episodes.ts';
import { choiceSummary, learnedScreenPolicy, train } from './train.ts';
import { STATE_NAMES } from './features.ts';

/**
 * Does within-episode experimentation pay when it is the only way to tell
 * users apart? Train on the twins (identical engagement statistics,
 * opposite density preferences) with the full state and with the four
 * choice-evidence features zeroed, and compare held-out reward and the
 * twin gap (compact shown to twin-compact minus to twin-comfortable).
 *
 * usage: node src/policy/experiment-twins.ts [--iterations N] [--users N] [--seeds a,b]
 */
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const iterations = Number(opt('iterations', '150'));
const users = Number(opt('users', '200'));
const seeds = opt('seeds', '1,2').split(',').map(Number);
const model = opt('model', 'linear') as 'linear' | 'mlp';
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(users) || users < 2
  || seeds.length === 0 || !seeds.every(Number.isInteger) || !['linear', 'mlp'].includes(model)) {
  console.error('usage: node src/policy/experiment-twins.ts [--iterations <int>=1] [--users <int>=2] [--seeds a,b,...] [--model linear|mlp]');
  process.exit(2);
}
const TWINS = ['twin-compact', 'twin-comfortable'];
const EVIDENCE = ['evCompactDensity', 'evCompactItems', 'evHeroLead', 'evButtons'].map((n) => STATE_NAMES.indexOf(n as typeof STATE_NAMES[number]));
const maxSessions = 10;
const evalSeed = 424_242;

function evaluate(sp: ReturnType<typeof learnedScreenPolicy> | ReturnType<typeof fixedScreenPolicy>, label: string) {
  const pop = makePopulation(400, makeRng(evalSeed), TWINS);
  const s = runEpisodes(sp, pop, fakeData, maxSessions, evalSeed).stats;
  const c = (a: string) => choiceSummary(sp, makePopulation(200, makeRng(evalSeed + 1), a), maxSessions, evalSeed + 1)!.compactDensity;
  const gap = (c('twin-compact') - c('twin-comfortable')) * 100;
  console.log(`${label.padEnd(34)} ${s.meanEpisodeReward.toFixed(2).padStart(8)} ${(s.returnRate * 100).toFixed(0).padStart(6)}% ${gap.toFixed(0).padStart(6)}`);
  return { reward: s.meanEpisodeReward, gap };
}

console.log(`twins experiment: ${iterations} iterations x ${users} users, seeds ${seeds.join(',')}, model ${model}; held-out 400 twins\n`);
console.log(`${'policy'.padEnd(34)} ${'reward'.padStart(8)} ${'return'.padStart(7)} ${'gap'.padStart(6)}`);
evaluate(randomScreenPolicy('local'), 'random-local');
evaluate(fixedScreenPolicy(loadExample('dense-list')), 'fixed-dense-list (compact)');
evaluate(fixedScreenPolicy(loadExample('editorial-home')), 'fixed-editorial-home (comfortable)');
// Sampled and greedy. Greedy is where discrimination has to show: a policy
// that cannot tell the twins apart must pick one density for everyone.
const results: Record<string, { reward: number[]; gap: number[] }> = {};
const rec = (k: string, r: { reward: number; gap: number }) => { (results[k] ??= { reward: [], gap: [] }).reward.push(r.reward); results[k].gap.push(r.gap); };
for (const seed of seeds) {
  for (const [label, mask] of [['full', []], ['ablated', EVIDENCE]] as Array<[string, number[]]>) {
    const { policy } = train({ iterations, usersPerIteration: users, maxSessions, lr: 0.02, l2: 0.001, seed, archetypes: TWINS, maskFeatures: mask, model });
    rec(`${label} sampled`, evaluate(learnedScreenPolicy(policy, false, 0, mask), `learned ${label}, sampled, seed ${seed}`));
    rec(`${label} greedy`, evaluate(learnedScreenPolicy(policy, true, 0, mask), `learned ${label}, greedy, seed ${seed}`));
  }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('\nmeans over seeds:');
for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(16)} reward ${mean(v.reward).toFixed(2).padStart(7)}   gap ${mean(v.gap).toFixed(0).padStart(4)}`);
