import { writeFileSync } from 'node:fs';
import { compileSchema } from './compile-schema.ts';
import { newsfeed } from './grammars/newsfeed.ts';

const schema = compileSchema(newsfeed);
const out = `schema/${newsfeed.name}.schema.json`;
writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys(schema.$defs as object).length} definitions)`);
