import type { Grammar, ComponentDef, SlotDef, Constraint, Condition } from './grammar-types.ts';

type J = Record<string, unknown>;

/**
 * Compile a Grammar into a JSON Schema (draft 2020-12) for its UI trees.
 *
 * The trick that makes the data-context layer expressible in plain JSON
 * Schema: every (component, context) pair reachable from the root becomes
 * its own definition, e.g. `Text@article`, whose `bind` enum is exactly the
 * fields of that context. Position in the tree determines context, so no
 * second-pass semantic validator is needed.
 *
 * Also performs the grammar's own type check: a slot that would place a
 * component in a context it does not allow, an Image in a context with no
 * image fields, or a childProps narrowing that names an unknown prop/value
 * are all compile errors.
 */
export function compileSchema(g: Grammar): J {
  const defs: Record<string, J> = {};
  const queue: Array<[string, string]> = [[g.root, g.rootContext]];
  const seen = new Set<string>();
  const errors: string[] = [];

  while (queue.length) {
    const [name, ctx] = queue.shift()!;
    const id = `${name}@${ctx}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const comp = g.components[name];
    if (!comp) { errors.push(`unknown component '${name}'`); continue; }
    if (!g.contexts[ctx]) { errors.push(`unknown context '${ctx}'`); continue; }
    if (!comp.contexts.includes(ctx)) errors.push(`${name} is not allowed in context '${ctx}'`);
    try {
      defs[id] = compileComponent(g, name, comp, ctx, (child, cctx) => queue.push([child, cctx]));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new Error('grammar errors:\n  - ' + errors.join('\n  - '));

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `${g.name} ${g.version} UI tree`,
    description: `Generated from the '${g.name}' grammar. Root: ${g.root} in context '${g.rootContext}'.`,
    $ref: `#/$defs/${g.root}@${g.rootContext}`,
    $defs: defs,
  };
}

function compileComponent(
  g: Grammar,
  name: string,
  comp: ComponentDef,
  ctx: string,
  visit: (child: string, ctx: string) => void,
): J {
  const properties: J = { type: { const: name } };
  const required: string[] = ['type'];
  const schema: J = {
    description: comp.description,
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };

  if (comp.props) {
    const pprops: J = {};
    const preq: string[] = [];
    for (const [pname, pdef] of Object.entries(comp.props)) {
      const values = pdef.values ?? pdef.valuesByContext?.[ctx];
      if (!values || values.length === 0) {
        throw new Error(`${name}@${ctx}: prop '${pname}' has no allowed values in context '${ctx}'`);
      }
      pprops[pname] = { ...(pdef.description ? { description: pdef.description } : {}), enum: [...values] };
      preq.push(pname);
    }
    properties.props = { type: 'object', additionalProperties: false, properties: pprops, required: preq };
    required.push('props');
  }

  if (comp.slots) {
    const sprops: J = {};
    const sreq: string[] = [];
    for (const [sname, sdef] of Object.entries(comp.slots)) {
      const cctx = sdef.context ?? ctx;
      const alts = sdef.accepts.map((child) => {
        visit(child, cctx);
        return childRef(g, name, sname, child, cctx, sdef);
      });
      const item = alts.length === 1 ? alts[0] : { anyOf: alts };
      sprops[sname] = sdef.max === 1
        ? { ...(sdef.description ? { description: sdef.description } : {}), ...item }
        : { ...(sdef.description ? { description: sdef.description } : {}), type: 'array', items: item, minItems: sdef.min, maxItems: sdef.max, ...(sdef.distinct ? { uniqueItems: true } : {}) };
      if (sdef.min >= 1) sreq.push(sname);
    }
    properties.slots = { type: 'object', additionalProperties: false, properties: sprops, ...(sreq.length ? { required: sreq } : {}) };
    if (sreq.length) required.push('slots');
  }

  if (comp.content) {
    const fields = g.contexts[ctx].fields;
    const bindable = comp.content.bind
      ? Object.entries(fields).filter(([, kind]) => comp.content!.bind!.includes(kind)).map(([f]) => f)
      : [];
    const keys = comp.content.keys === true ? [...g.strings] : comp.content.keys ? [...comp.content.keys] : [];
    if (bindable.length === 0 && keys.length === 0) {
      throw new Error(`${name}@${ctx}: leaf has nothing to bind and no string keys in context '${ctx}'`);
    }
    if (bindable.length) properties.bind = { enum: bindable };
    if (keys.length) properties.key = { enum: keys };
    if (bindable.length && keys.length) {
      schema.oneOf = [{ type: 'object', required: ['bind'] }, { type: 'object', required: ['key'] }];
    } else if (bindable.length) {
      required.push('bind');
    } else {
      required.push('key');
    }
  }

  if (comp.constraints?.length) {
    schema.allOf = comp.constraints.map((c) => compileConstraint(g, name, comp, c));
  }
  return schema;
}

function childRef(g: Grammar, parent: string, slot: string, child: string, cctx: string, sdef: SlotDef): J {
  const ref: J = { $ref: `#/$defs/${child}@${cctx}` };
  const narrow: J = {};
  if (sdef.childProps) {
    const childComp = g.components[child];
    const narrowed: J = {};
    for (const [p, vals] of Object.entries(sdef.childProps)) {
      checkPropValues(g, childComp, child, cctx, p, vals, `${parent}.${slot}`);
      narrowed[p] = { enum: [...vals] };
    }
    narrow.type = 'object';
    narrow.properties = { props: { type: 'object', properties: narrowed } };
  }
  if (sdef.childContent) { narrow.type = 'object'; narrow.required = [sdef.childContent]; }
  if (sdef.childBind) {
    const fields = g.contexts[cctx].fields;
    for (const f of sdef.childBind) {
      if (!(f in fields)) throw new Error(`${parent}.${slot}: childBind names unknown field '${f}' in context '${cctx}'`);
    }
    narrow.type = 'object';
    narrow.properties = { ...((narrow.properties as J) ?? {}), bind: { enum: [...sdef.childBind] } };
  }
  return Object.keys(narrow).length ? { allOf: [ref, narrow] } : ref;
}

function checkPropValues(g: Grammar, comp: ComponentDef | undefined, name: string, ctx: string, p: string, vals: readonly string[], where: string) {
  const def = comp?.props?.[p];
  if (!def) throw new Error(`${where}: narrows unknown prop '${p}' on ${name}`);
  const allowed = def.values ?? def.valuesByContext?.[ctx] ?? [];
  for (const v of vals) {
    if (!allowed.includes(v)) throw new Error(`${where}: value '${v}' is not a legal ${name}.${p} in context '${ctx}'`);
  }
}

function cond(c: Condition): J {
  return { type: 'object', properties: { props: { type: 'object', properties: { [c.prop]: { const: c.is } }, required: [c.prop] } }, required: ['props'] };
}

function compileConstraint(g: Grammar, name: string, comp: ComponentDef, c: Constraint): J {
  let then: J;
  if ('requireSlot' in c) {
    then = { type: 'object', properties: { slots: { type: 'object', required: [c.requireSlot] } }, required: ['slots'] };
  } else if ('forbidSlot' in c) {
    then = { type: 'object', properties: { slots: { type: 'object', not: { type: 'object', required: [c.forbidSlot] } } } };
  } else if ('propIn' in c) {
    then = { type: 'object', properties: { props: { type: 'object', properties: { [c.propIn.prop]: { enum: [...c.propIn.in] } } } } };
  } else {
    const sdef = comp.slots?.[c.childProps.slot];
    if (!sdef) throw new Error(`${name}: constraint names unknown slot '${c.childProps.slot}'`);
    const inner: J = { type: 'object', properties: { props: { type: 'object', properties: { [c.childProps.prop]: { enum: [...c.childProps.in] } } } } };
    then = { type: 'object', properties: { slots: { type: 'object', properties: { [c.childProps.slot]: sdef.max === 1 ? inner : { type: 'array', items: inner } } } } };
  }
  return { if: cond(c.when), then };
}
