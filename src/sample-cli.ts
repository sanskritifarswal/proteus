import { makeRng } from './rng.ts';
import { localUniform, sample, uniformDerivation } from './sample.ts';
import { newsfeed } from './grammars/newsfeed.ts';

/**
 * usage: node src/sample-cli.ts [--seed N] [--n N] [--policy local|uniform]
 * Prints a JSON array of sampled UI documents.
 */
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const seed = Number(opt('seed', '1'));
const n = Number(opt('n', '1'));
const policyName = opt('policy', 'local');

const rng = makeRng(seed);
const policy = policyName === 'uniform' ? uniformDerivation(rng) : localUniform(rng);
const docs = Array.from({ length: n }, () => sample(newsfeed, policy));
console.log(JSON.stringify(docs, null, 2));
