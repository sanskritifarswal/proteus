import type { Grammar, ComponentDef } from './grammar-types.ts';
import { newsfeed } from './grammars/newsfeed.ts';

/**
 * Exact count of distinct derivations (valid UI trees) the grammar admits,
 * honouring cardinalities, context-dependent prop values, slot narrowing and
 * cross-node constraints. Ordered sequences in array slots count as distinct.
 *
 * Useful for two things: spotting slots that are far looser than they look,
 * and sizing the action space the bandit will eventually have to search.
 */
type Restrict = Record<string, readonly string[]>;
const memo = new Map<string, bigint>();

function propValues(comp: ComponentDef, ctx: string, p: string, restrict: Restrict): string[] {
  const def = comp.props![p];
  let vals = [...(def.values ?? def.valuesByContext?.[ctx] ?? [])];
  if (restrict[p]) vals = vals.filter((v) => restrict[p].includes(v));
  return vals;
}

function assignments(comp: ComponentDef, ctx: string, restrict: Restrict): Array<Record<string, string>> {
  let acc: Array<Record<string, string>> = [{}];
  for (const p of Object.keys(comp.props ?? {})) {
    const vals = propValues(comp, ctx, p, restrict);
    acc = acc.flatMap((a) => vals.map((v) => ({ ...a, [p]: v })));
  }
  return acc;
}

export function count(g: Grammar, name: string, ctx: string, restrict: Restrict = {}, mode?: 'bind' | 'key', bindRestrict?: readonly string[]): bigint {
  const k = JSON.stringify([name, ctx, restrict, mode, bindRestrict]);
  if (memo.has(k)) return memo.get(k)!;
  const comp = g.components[name];
  let total = 0n;

  for (const a of assignments(comp, ctx, restrict)) {
    const active = (comp.constraints ?? []).filter((c) => a[c.when.prop] === c.when.is);
    if (active.some((c) => 'propIn' in c && !c.propIn.in.includes(a[c.propIn.prop]))) continue;

    let prod = 1n;
    for (const [sname, sdef] of Object.entries(comp.slots ?? {})) {
      let min = sdef.min;
      let max = sdef.max;
      const r: Restrict = { ...(sdef.childProps ?? {}) };
      for (const c of active) {
        if ('requireSlot' in c && c.requireSlot === sname) min = Math.max(min, 1);
        if ('forbidSlot' in c && c.forbidSlot === sname) max = 0;
        if ('childProps' in c && c.childProps.slot === sname) {
          const prev = r[c.childProps.prop];
          r[c.childProps.prop] = prev ? prev.filter((v) => c.childProps.in.includes(v)) : c.childProps.in;
        }
      }
      const cctx = sdef.context ?? ctx;
      let per = 0n;
      for (const child of sdef.accepts) per += count(g, child, cctx, r, sdef.childContent, sdef.childBind);
      let slotTotal = 0n;
      for (let n = min; n <= max; n++) {
        // distinct: ordered selections without repetition (falling factorial); otherwise per^n.
        let ways = 1n;
        for (let i = 0n; i < BigInt(n); i++) ways *= sdef.distinct ? per - i : per;
        slotTotal += ways;
      }
      prod *= slotTotal;
    }

    if (comp.content) {
      const fields = g.contexts[ctx].fields;
      const b = comp.content.bind
        ? Object.entries(fields).filter(([f, kd]) => comp.content!.bind!.includes(kd) && (!bindRestrict || bindRestrict.includes(f))).length
        : 0;
      const kk = comp.content.keys === true ? g.strings.length : (comp.content.keys?.length ?? 0);
      prod *= BigInt(mode === 'bind' ? b : mode === 'key' ? kk : b + kk);
    }
    total += prod;
  }

  memo.set(k, total);
  return total;
}

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
