import { count, type Restrict } from './count.ts';
import { newsfeed } from './grammars/newsfeed.ts';

/**
 * Prints derivation counts for the newsfeed grammar. The arithmetic lives in
 * count.ts so the sampler can share it.
 */
function fmt(n: bigint): string {
  const s = n.toString();
  return s.length > 9 ? `${s[0]}.${s.slice(1, 3)}e${s.length - 1}` : n.toLocaleString('en-US');
}

const g = newsfeed;
const rows: Array<[string, string, Restrict, 'bind' | 'key' | undefined]> = [
  ['Text', 'article', { role: ['title'] }, 'bind'],
  ['Button', 'article', {}, undefined],
  ['Image', 'article', {}, undefined],
  ['Card', 'article', {}, undefined],
  ['Card', 'article', { variant: ['compact'] }, undefined],
  ['Collection', 'feed', {}, undefined],
  ['Section', 'screen', {}, undefined],
  ['Header', 'screen', {}, undefined],
  ['Screen', 'screen', {}, undefined],
];
console.log(`derivation counts for grammar '${g.name}' ${g.version}\n`);
for (const [name, ctx, restrict, mode] of rows) {
  const label = `${name}@${ctx}${Object.keys(restrict).length ? ' ' + JSON.stringify(restrict) : ''}${mode ? ` (${mode})` : ''}`;
  console.log(`${label.padEnd(44)} ${fmt(count(g, name, ctx, restrict, mode))}`);
}
