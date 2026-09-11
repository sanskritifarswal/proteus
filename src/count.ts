import type { Grammar, ComponentDef, SlotDef } from './grammar-types.ts';
import { distinctByValues } from './compile-schema.ts';

/**
 * Shared derivation-space arithmetic used by the counter and the sampler.
 *
 * Everything here is pure and memoised. "How many derivations complete this
 * choice" is exactly the weight a uniform-over-derivations sampler needs, so
 * the sampler reuses these functions instead of re-deriving the constraint
 * logic.
 */
export type Restrict = Record<string, readonly string[]>;
export type ContentMode = 'bind' | 'key' | undefined;
export type Assignment = Record<string, string>;

export interface SlotBounds {
  min: number;
  max: number;
  restrict: Restrict;
}

function propValues(comp: ComponentDef, ctx: string, p: string, restrict: Restrict): string[] {
  const def = comp.props![p];
  let vals = [...(def.values ?? def.valuesByContext?.[ctx] ?? [])];
  if (restrict[p]) vals = vals.filter((v) => restrict[p].includes(v));
  return vals;
}

/** Every prop assignment that satisfies the restriction and the component's propIn constraints. */
export function validAssignments(comp: ComponentDef, ctx: string, restrict: Restrict): Assignment[] {
  let acc: Assignment[] = [{}];
  for (const p of Object.keys(comp.props ?? {})) {
    const vals = propValues(comp, ctx, p, restrict);
    acc = acc.flatMap((a) => vals.map((v) => ({ ...a, [p]: v })));
  }
  return acc.filter((a) => {
    const active = (comp.constraints ?? []).filter((c) => a[c.when.prop] === c.when.is);
    return !active.some((c) => 'propIn' in c && !c.propIn.in.includes(a[c.propIn.prop]));
  });
}

/** Cardinality and child-prop restriction for one slot, given the parent's prop assignment. */
export function slotBounds(comp: ComponentDef, a: Assignment, sname: string, sdef: SlotDef): SlotBounds {
  let min = sdef.min;
  let max = sdef.max;
  const restrict: Restrict = { ...(sdef.childProps ?? {}) };
  for (const c of (comp.constraints ?? []).filter((c) => a[c.when.prop] === c.when.is)) {
    if ('requireSlot' in c && c.requireSlot === sname) min = Math.max(min, 1);
    if ('forbidSlot' in c && c.forbidSlot === sname) max = 0;
    if ('childProps' in c && c.childProps.slot === sname) {
      const prev = restrict[c.childProps.prop];
      restrict[c.childProps.prop] = prev ? prev.filter((v) => c.childProps.in.includes(v)) : c.childProps.in;
    }
  }
  return { min, max, restrict };
}

/** Field bindings and string keys a leaf may use in this context. */
export function contentOptions(g: Grammar, comp: ComponentDef, ctx: string, mode: ContentMode, bindRestrict?: readonly string[]) {
  const c = comp.content;
  if (!c) return { binds: [] as string[], keys: [] as string[] };
  const fields = g.contexts[ctx].fields;
  const binds = c.bind && mode !== 'key'
    ? Object.entries(fields).filter(([f, kd]) => c.bind!.includes(kd) && (!bindRestrict || bindRestrict.includes(f))).map(([f]) => f)
    : [];
  const keys = mode !== 'bind' ? (c.keys === true ? [...g.strings] : c.keys ? [...c.keys] : []) : [];
  return { binds, keys };
}

/** Number of ordered child sequences of length n for a slot, given `per` distinct single children. */
export function arityWays(per: bigint, n: number, distinct: boolean): bigint {
  let ways = 1n;
  for (let i = 0n; i < BigInt(n); i++) ways *= distinct ? per - i : per;
  return ways;
}

const memo = new Map<string, bigint>();

/**
 * For a distinctBy slot: number of child derivations per value of the field.
 * The order of values is stable so the sampler can reuse it.
 */
export function distinctByCounts(g: Grammar, ctx: string, sdef: SlotDef, b: SlotBounds): Array<[string, bigint]> {
  const cctx = sdef.context ?? ctx;
  const field = sdef.distinctBy!;
  const values = distinctByValues(g, '?', '?', sdef, cctx);
  return values.map((v) => {
    let c = 0n;
    for (const child of sdef.accepts) {
      c += field === 'bind'
        ? count(g, child, cctx, b.restrict, sdef.childContent, [v].filter((f) => !sdef.childBind || sdef.childBind.includes(f)))
        : count(g, child, cctx, { ...b.restrict, [field]: (b.restrict[field] ?? [v]).filter((x) => x === v) }, sdef.childContent, sdef.childBind);
    }
    return [v, c];
  });
}

/** Ordered n-tuples drawing each element from a different bucket: n! * e_n(bucket sizes). */
export function distinctTupleWays(buckets: bigint[], n: number): bigint {
  // e[k] = elementary symmetric polynomial of degree k over the bucket sizes.
  const e: bigint[] = Array.from({ length: n + 1 }, (_, k) => (k === 0 ? 1n : 0n));
  for (const c of buckets) for (let k = n; k >= 1; k--) e[k] += e[k - 1] * c;
  let fact = 1n;
  for (let k = 2; k <= n; k++) fact *= BigInt(k);
  return e[n] * fact;
}

/** Derivations of one slot: sum over legal arities of the ways to fill it. */
export function countSlot(g: Grammar, ctx: string, sdef: SlotDef, b: SlotBounds): bigint {
  let total = 0n;
  if (sdef.distinctBy) {
    const buckets = distinctByCounts(g, ctx, sdef, b).map(([, c]) => c);
    for (let n = b.min; n <= b.max; n++) total += distinctTupleWays(buckets, n);
    return total;
  }
  const per = countSlotChild(g, ctx, sdef, b);
  for (let n = b.min; n <= b.max; n++) total += arityWays(per, n, !!sdef.distinct);
  return total;
}

/** Derivations of a single child of a slot, summed over the types it accepts. */
export function countSlotChild(g: Grammar, ctx: string, sdef: SlotDef, b: SlotBounds): bigint {
  const cctx = sdef.context ?? ctx;
  let per = 0n;
  for (const child of sdef.accepts) per += count(g, child, cctx, b.restrict, sdef.childContent, sdef.childBind);
  return per;
}

/** Derivations of a component given a fixed prop assignment. */
export function countAssignment(g: Grammar, name: string, ctx: string, a: Assignment, mode: ContentMode, bindRestrict?: readonly string[]): bigint {
  const comp = g.components[name];
  let prod = 1n;
  for (const [sname, sdef] of Object.entries(comp.slots ?? {})) {
    prod *= countSlot(g, ctx, sdef, slotBounds(comp, a, sname, sdef));
  }
  if (comp.content) {
    const { binds, keys } = contentOptions(g, comp, ctx, mode, bindRestrict);
    prod *= BigInt(binds.length + keys.length);
  }
  return prod;
}

/**
 * Exact count of distinct derivations of `name` in context `ctx`, honouring
 * cardinalities, context-dependent prop values, slot narrowing and
 * cross-node constraints. Ordered sequences in array slots count as distinct.
 */
export function count(g: Grammar, name: string, ctx: string, restrict: Restrict = {}, mode?: ContentMode, bindRestrict?: readonly string[]): bigint {
  const k = JSON.stringify([g.name, g.version, name, ctx, restrict, mode, bindRestrict]);
  const hit = memo.get(k);
  if (hit !== undefined) return hit;
  const comp = g.components[name];
  let total = 0n;
  for (const a of validAssignments(comp, ctx, restrict)) total += countAssignment(g, name, ctx, a, mode, bindRestrict);
  memo.set(k, total);
  return total;
}
