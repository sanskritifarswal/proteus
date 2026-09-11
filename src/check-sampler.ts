import Ajv2020 from 'ajv/dist/2020.js';
import { compileSchema } from './compile-schema.ts';
import { makeRng } from './rng.ts';
import { localUniform, sample, uniformDerivation, type Policy } from './sample.ts';
import { newsfeed } from './grammars/newsfeed.ts';
import type { Grammar } from './grammar-types.ts';

/**
 * Sanity check for the sampler: every sampled tree must validate against the
 * compiled schema under both policies, and sampling must be deterministic
 * for a given seed.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTuples: false });
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

// A deterministic policy (always the first option) must still yield a valid
// tree: distinct slots truncate instead of retry-looping.
try {
  const doc = sample(newsfeed, () => 0);
  const ok = validate(doc);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  deterministic policy yields a valid tree`);
} catch (e) {
  failures++;
  console.log(`FAIL  deterministic policy threw: ${(e as Error).message}`);
}

// A grammar where one branch has zero completions: the sampler must never
// offer it. Here `grid` narrows the item to a variant the slot forbids.
const trap: Grammar = {
  name: 'trap', version: '0.0.1', root: 'List', rootContext: 'c',
  contexts: { c: { description: '', fields: { t: 'text' } } },
  strings: [],
  components: {
    List: {
      description: '', contexts: ['c'],
      props: { layout: { values: ['stack', 'grid'] } },
      slots: { item: { accepts: ['Card'], min: 1, max: 1, childProps: { variant: ['compact'] } } },
      constraints: [{ when: { prop: 'layout', is: 'grid' }, childProps: { slot: 'item', prop: 'variant', in: ['standard'] } }],
    },
    Card: {
      description: '', contexts: ['c'],
      props: { variant: { values: ['standard', 'compact'] } },
      slots: { title: { accepts: ['Text'], min: 1, max: 1 } },
    },
    Text: { description: '', contexts: ['c'], content: { bind: ['text'] } },
  },
};
{
  const vTrap = ajv.compile(compileSchema(trap));
  let bad = 0;
  for (const make of [localUniform, uniformDerivation]) {
    const policy = make(makeRng(1));
    for (let i = 0; i < 50; i++) {
      try { if (!vTrap(sample(trap, policy))) bad++; } catch { bad++; }
    }
  }
  if (bad) failures++;
  console.log(`${bad ? 'FAIL' : 'PASS'}  zero-completion options are never offered (${100 - bad}/100 trap samples valid)`);
}

const a = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(7)))));
const b = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(7)))));
const c = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(8)))));
const det = a === b && a !== c;
if (!det) failures++;
console.log(`${det ? 'PASS' : 'FAIL'}  sampling is deterministic per seed and differs across seeds`);

console.log(failures ? `\n${failures} sampler check(s) failed` : '\nsampler checks passed');
process.exit(failures ? 1 : 0);
