import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { compileSchema, grammarId } from './compile-schema.ts';
import { newsfeed } from './grammars/newsfeed.ts';

/**
 * Sanity check: every tree in examples/valid must validate, every tree in
 * examples/invalid must be rejected. Exit 1 otherwise.
 */
const schema = compileSchema(newsfeed);
writeFileSync(`schema/${newsfeed.name}.schema.json`, JSON.stringify(schema, null, 2) + '\n');

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTuples: false });
const validate = ajv.compile(schema);

let failures = 0;

function check(dir: string, expectValid: boolean) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const tree = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    // Every fixture except the two envelope negatives must carry the current
    // grammar id, so a missed bump fails loudly instead of masking the rule
    // the fixture exists to test.
    if (!['missing-envelope.json', 'wrong-grammar-version.json'].includes(f) && tree.grammar !== grammarId(newsfeed)) {
      failures++;
      console.log(`FAIL  ${dir}/${f}  envelope is '${tree.grammar}', expected '${grammarId(newsfeed)}'`);
      continue;
    }
    const ok = validate(tree);
    const pass = ok === expectValid;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${dir}/${f}  (${ok ? 'valid' : 'rejected'}, expected ${expectValid ? 'valid' : 'rejected'})`);
    if (!ok) {
      // Show the most specific errors: deepest instancePath, skipping noisy anyOf/oneOf/if wrappers.
      const errs = (validate.errors ?? [])
        .filter((e) => !['anyOf', 'oneOf', 'if', 'allOf'].includes(e.keyword))
        .sort((a, b) => b.instancePath.length - a.instancePath.length)
        .slice(0, 3);
      for (const e of errs) {
        const detail = e.keyword === 'enum' ? ` allowed: ${JSON.stringify((e.params as { allowedValues: unknown }).allowedValues)}` : '';
        console.log(`        ${e.instancePath || '/'}: ${e.message}${detail}`);
      }
    }
  }
}

check('examples/valid', true);
check('examples/invalid', false);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
