import { writeFileSync } from 'node:fs';
import { grammarId } from './compile-schema.ts';
import { newsfeed } from './grammars/newsfeed.ts';

/**
 * Dumps the grammar spec as JSON so non-TypeScript consumers (the Python RL
 * side) read the same source of truth the schema compiler and sampler use.
 */
const out = `schema/${newsfeed.name}.grammar.json`;
writeFileSync(out, JSON.stringify({ $id: grammarId(newsfeed), ...newsfeed }, null, 2) + '\n');
console.log(`wrote ${out}`);
