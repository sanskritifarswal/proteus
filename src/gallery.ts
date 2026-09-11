import { writeFileSync } from 'node:fs';
import { makeRng } from './rng.ts';
import { localUniform, sample, uniformDerivation } from './sample.ts';
import { renderDocument, screenCss } from './render-html.ts';
import { fakeData } from './fake-data.ts';
import { newsfeed } from './grammars/newsfeed.ts';
import type { UINode } from './tree.ts';

/**
 * usage: node src/gallery.ts [--seed N] [--n N] [--policy local|uniform] [--out gallery/index.html]
 * Samples N trees and renders them side by side so the grammar's output can
 * be judged by eye. The point is to find what the grammar allows that a
 * designer would never ship, and turn each into a constraint.
 */
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const seed = Number(opt('seed', '1'));
const n = Number(opt('n', '20'));
const policyName = opt('policy', 'local');
const out = opt('out', 'gallery/index.html');
if (!['local', 'uniform'].includes(policyName) || !Number.isInteger(seed) || !Number.isInteger(n) || n < 1) {
  console.error('usage: node src/gallery.ts [--seed <int>] [--n <int>] [--policy local|uniform] [--out <file>]');
  process.exit(2);
}

const rng = makeRng(seed);
const policy = policyName === 'uniform' ? uniformDerivation(rng) : localUniform(rng);

function outline(node: UINode, indent = 0): string {
  const props = Object.entries(node.props ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const content = node.bind ? `bind=${node.bind}` : node.key ? `key=${node.key}` : '';
  let s = `${' '.repeat(indent)}${node.type} ${props} ${content}`.trimEnd() + '\n';
  for (const [slot, v] of Object.entries(node.slots ?? {})) {
    for (const child of Array.isArray(v) ? v : [v]) s += `${' '.repeat(indent + 2)}${slot}: ` + outline(child, indent + 4).trimStart();
  }
  return s;
}

function summary(tree: UINode): string {
  const sections = ((tree.slots?.sections as UINode[]) ?? []).map((s) => {
    const c = s.slots?.content as UINode;
    const item = c.slots?.item as UINode;
    const lead = c.slots?.lead as UINode | undefined;
    return `${s.props!.source} · ${c.props!.layout}×${c.props!.limit} · ${lead ? `lead ${lead.props!.variant} + ` : ''}${item.props!.variant}`;
  });
  return `${tree.props!.density}${tree.slots?.header ? ' · header' : ''}<br>${sections.join('<br>')}`;
}

const cards: string[] = [];
for (let i = 0; i < n; i++) {
  const doc = sample(newsfeed, policy);
  cards.push(`<figure class="sample">
  <figcaption><b>#${i + 1}</b> <span class="sum">${summary(doc.tree)}</span></figcaption>
  <div class="frame">${renderDocument(doc, fakeData)}</div>
  <details><summary>tree</summary><pre>${outline(doc.tree).replace(/</g, '&lt;')}</pre></details>
</figure>`);
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>Proteus gallery · ${newsfeed.name}@${newsfeed.version} · ${policyName} seed ${seed}</title>
<style>
body { margin: 0; padding: 24px; background: #e9e9ee; font-family: -apple-system, system-ui, sans-serif; color: #222; }
h1 { font-size: 18px; margin: 0 0 4px; } .lede { color: #555; margin: 0 0 20px; font-size: 14px; }
.grid { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.sample { margin: 0; width: 390px; }
.sample figcaption { font-size: 12px; color: #444; margin-bottom: 6px; line-height: 1.4; }
.sample .sum { color: #666; }
.frame { border-radius: 18px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.15); max-height: 720px; overflow-y: auto; }
details { font-size: 12px; margin-top: 6px; } pre { font-size: 11px; background: #fff; padding: 8px; border-radius: 6px; overflow-x: auto; }
${screenCss}
</style>
<h1>Proteus gallery</h1>
<p class="lede">${n} derivations of <code>${newsfeed.name}@${newsfeed.version}</code>, policy <code>${policyName}</code>, seed ${seed}. Rendered with fake content; every element carries its tree path in <code>data-path</code>.</p>
<div class="grid">
${cards.join('\n')}
</div>
`;
writeFileSync(out, html);
console.log(`wrote ${out} (${n} samples, ${(html.length / 1024).toFixed(0)} KB)`);
