import type { Grammar, ComponentDef } from './grammar-types.ts';
import type { UIDocument, UINode } from './tree.ts';
import {
  arityWays, contentOptions, count, countAssignment, countSlotChild, slotBounds, validAssignments,
  type Assignment, type ContentMode, type Restrict,
} from './count.ts';
import { grammarId } from './compile-schema.ts';
import type { Rng } from './rng.ts';

/**
 * Derivation sampler, structured as a policy walking the grammar.
 *
 * Building a tree is a sequence of decisions, each at a path in the tree:
 *
 *   props    which prop assignment a node takes (one joint choice per node)
 *   arity    how many children a slot gets
 *   type     which component type fills a child position
 *   content  which field binding or string key a leaf shows
 *
 * A Policy answers each decision with the index of an option. This is the
 * factored action space: an RL policy conditions on state + path + options
 * and returns a choice; the sampler turns that stream of choices into a
 * valid tree. Every option offered is legal, so any policy yields a tree the
 * schema accepts.
 *
 * Two built-in policies: `localUniform` picks uniformly among the options at
 * each decision (the natural random baseline for a factored policy) and
 * `uniformDerivation` weights each option by how many complete derivations
 * it leads to, giving exactly uniform sampling over the whole space.
 */
export interface Decision {
  kind: 'props' | 'arity' | 'type' | 'content';
  /** Tree path, e.g. "sections[1].content.item.meta[0]". "" is the root. */
  path: string;
  component: string;
  context: string;
  options: string[];
  /** Number of complete derivations reachable through each option. */
  weights: bigint[];
}

export type Policy = (d: Decision) => number;

export function localUniform(rng: Rng): Policy {
  return (d) => rng.int(d.options.length);
}

export function uniformDerivation(rng: Rng): Policy {
  return (d) => {
    const total = d.weights.reduce((a, b) => a + b, 0n);
    let r = rng.bigint(total);
    for (let i = 0; i < d.weights.length; i++) {
      if (r < d.weights[i]) return i;
      r -= d.weights[i];
    }
    return d.weights.length - 1;
  };
}

export function sample(g: Grammar, policy: Policy): UIDocument {
  return { grammar: grammarId(g), tree: sampleNode(g, policy, g.root, g.rootContext, '', {}, undefined, undefined) };
}

function decide(policy: Policy, d: Decision): number {
  const i = policy(d);
  if (!Number.isInteger(i) || i < 0 || i >= d.options.length) {
    throw new Error(`policy returned ${i} for ${d.kind} at "${d.path}" with ${d.options.length} options`);
  }
  return i;
}

function sampleNode(
  g: Grammar, policy: Policy, name: string, ctx: string, path: string,
  restrict: Restrict, mode: ContentMode, bindRestrict: readonly string[] | undefined,
): UINode {
  const comp: ComponentDef = g.components[name];
  const node: UINode = { type: name };

  let a: Assignment = {};
  if (comp.props) {
    const assigns = validAssignments(comp, ctx, restrict);
    const i = decide(policy, {
      kind: 'props', path, component: name, context: ctx,
      options: assigns.map((x) => JSON.stringify(x)),
      weights: assigns.map((x) => countAssignment(g, name, ctx, x, mode, bindRestrict)),
    });
    a = assigns[i];
    node.props = { ...a };
  }

  if (comp.slots) {
    const slots: Record<string, UINode | UINode[]> = {};
    for (const [sname, sdef] of Object.entries(comp.slots)) {
      const b = slotBounds(comp, a, sname, sdef);
      const cctx = sdef.context ?? ctx;
      const per = countSlotChild(g, ctx, sdef, b);
      const slotPath = path ? `${path}.${sname}` : sname;

      const arities = Array.from({ length: b.max - b.min + 1 }, (_, k) => b.min + k);
      const n = arities[decide(policy, {
        kind: 'arity', path: slotPath, component: name, context: ctx,
        options: arities.map(String),
        weights: arities.map((k) => arityWays(per, k, !!sdef.distinct)),
      })];
      if (n === 0) continue;

      const children: UINode[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < n; k++) {
        const childPath = sdef.max === 1 ? slotPath : `${slotPath}[${k}]`;
        let child: UINode;
        let tries = 0;
        do {
          const type = sdef.accepts.length === 1
            ? sdef.accepts[0]
            : sdef.accepts[decide(policy, {
                kind: 'type', path: childPath, component: name, context: ctx,
                options: [...sdef.accepts],
                weights: sdef.accepts.map((t) => count(g, t, cctx, b.restrict, sdef.childContent, sdef.childBind)),
              })];
          child = sampleNode(g, policy, type, cctx, childPath, b.restrict, sdef.childContent, sdef.childBind);
          if (++tries > 50) throw new Error(`could not draw ${n} distinct children for ${slotPath}`);
        } while (sdef.distinct && seen.has(JSON.stringify(child)));
        seen.add(JSON.stringify(child));
        children.push(child);
      }
      slots[sname] = sdef.max === 1 ? children[0] : children;
    }
    if (Object.keys(slots).length) node.slots = slots;
  }

  if (comp.content) {
    const { binds, keys } = contentOptions(g, comp, ctx, mode, bindRestrict);
    const options = [...binds.map((f) => `bind:${f}`), ...keys.map((k) => `key:${k}`)];
    const pick = options[decide(policy, {
      kind: 'content', path, component: name, context: ctx, options, weights: options.map(() => 1n),
    })];
    const [what, value] = [pick.slice(0, pick.indexOf(':')), pick.slice(pick.indexOf(':') + 1)];
    if (what === 'bind') node.bind = value; else node.key = value;
  }

  return node;
}
