import Ajv2020 from 'ajv/dist/2020.js';
import { compileSchema } from './compile-schema.ts';
import { makeRng } from './rng.ts';
import { localUniform, sample, uniformDerivation, type Policy } from './sample.ts';
import { newsfeed } from './grammars/newsfeed.ts';

/**
 * Sanity check for the sampler: every sampled tree must validate against the
 * compiled schema under both policies, and sampling must be deterministic
 * for a given seed.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(compileSchema(newsfeed));
const N = 200;
let failures = 0;

for (const [name, make] of [['local', localUniform], ['uniform', uniformDerivation]] as Array<[string, (r: ReturnType<typeof makeRng>) => Policy]>) {
  const policy = make(makeRng(42));
  let bad = 0;
  let nodes = 0;
  for (let i = 0; i < N; i++) {
    const doc = sample(newsfeed, policy);
    nodes += JSON.stringify(doc).split('"type":').length - 1;
    if (!validate(doc)) {
      bad++;
      if (bad <= 3) console.log(`  ${name} sample ${i} invalid:`, validate.errors?.slice(0, 2).map((e) => `${e.instancePath}: ${e.message}`).join('; '));
    }
  }
  failures += bad;
  console.log(`${bad ? 'FAIL' : 'PASS'}  policy=${name}: ${N - bad}/${N} samples valid, mean ${(nodes / N).toFixed(1)} nodes per tree`);
}

const a = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(7)))));
const b = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(7)))));
const c = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(8)))));
const det = a === b && a !== c;
if (!det) failures++;
console.log(`${det ? 'PASS' : 'FAIL'}  sampling is deterministic per seed and differs across seeds`);

console.log(failures ? `\n${failures} sampler check(s) failed` : '\nsampler checks passed');
process.exit(failures ? 1 : 0);
