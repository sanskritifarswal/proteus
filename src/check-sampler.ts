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

// distinctBy with unequal buckets: two required positions, bucket sizes 100
// (small: one label src x 100 keys) and 200 (large: two src x 100 keys).
// Both orders (small,large) and (large,small) contain 100*200 complete
// derivations, so uniformDerivation must start with the small bucket ~50%.
// Weighting by bucket size alone would start small only 100/300 = 33%.
const skew: Grammar = {
  name: 'skew', version: '0.0.1', root: 'Row', rootContext: 'c',
  contexts: { c: { description: '', fields: { t: 'text' } } },
  strings: Array.from({ length: 100 }, (_, i) => `k${i}`),
  components: {
    Row: {
      description: '', contexts: ['c'],
      slots: { cells: { accepts: ['Cell'], min: 2, max: 2, distinctBy: 'kind' } },
    },
    Cell: {
      description: '', contexts: ['c'],
      props: { kind: { values: ['small', 'large'] } },
      slots: { label: { accepts: ['Text'], min: 1, max: 1 } },
      constraints: [{ when: { prop: 'kind', is: 'small' }, childProps: { slot: 'label', prop: 'src', in: ['field'] } }],
    },
    Text: {
      description: '', contexts: ['c'],
      props: { src: { values: ['field', 'key'] } },
      content: { keys: true },
    },
  },
};
{
  const policy = uniformDerivation(makeRng(11));
  const N2 = 2000;
  let smallFirst = 0;
  const vSkew = ajv.compile(compileSchema(skew));
  let bad = 0;
  for (let i = 0; i < N2; i++) {
    const doc = sample(skew, policy);
    if (!vSkew(doc)) bad++;
    const cells = doc.tree.slots!.cells as Array<{ props?: Record<string, string> }>;
    if (cells[0].props!.kind === 'small') smallFirst++;
  }
  const frac = smallFirst / N2;
  const ok = bad === 0 && frac > 0.45 && frac < 0.55;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  distinctBy sampling is unbiased with unequal buckets (small-first ${(frac * 100).toFixed(1)}%, expect ~50%; ${bad} invalid)`);
}

// The compiler must reject distinctBy 'bind' when children may carry keys.
{
  const badGrammar: Grammar = {
    name: 'bad', version: '0.0.1', root: 'Row', rootContext: 'c',
    contexts: { c: { description: '', fields: { a: 'text', b: 'text' } } },
    strings: ['k'],
    components: {
      Row: { description: '', contexts: ['c'], slots: { cells: { accepts: ['Text'], min: 0, max: 2, distinctBy: 'bind' } } },
      Text: { description: '', contexts: ['c'], content: { bind: ['text'], keys: true } },
    },
  };
  let rejected = false;
  try { compileSchema(badGrammar); } catch (e) { rejected = /distinctBy 'bind' requires childContent/.test((e as Error).message); }
  if (!rejected) failures++;
  console.log(`${rejected ? 'PASS' : 'FAIL'}  compiler rejects distinctBy 'bind' without childContent 'bind'`);
}

const a = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(7)))));
const b = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(7)))));
const c = JSON.stringify(Array.from({ length: 5 }, () => sample(newsfeed, localUniform(makeRng(8)))));
const det = a === b && a !== c;
if (!det) failures++;
console.log(`${det ? 'PASS' : 'FAIL'}  sampling is deterministic per seed and differs across seeds`);

console.log(failures ? `\n${failures} sampler check(s) failed` : '\nsampler checks passed');
process.exit(failures ? 1 : 0);
