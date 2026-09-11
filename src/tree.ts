/**
 * The runtime UI tree: what the model emits and the renderer consumes.
 *
 * This shape is grammar-agnostic. Which `type`s, `props`, `slots`, `bind`s
 * and `key`s are legal at each position is defined by a Grammar and
 * enforced by the JSON Schema compiled from it (see compile-schema.ts).
 *
 * Node addressing: a node is identified by its path from the root, e.g.
 *   sections[1].content.item.actions[0]
 * Paths are stable across derivations that share structure, which is what
 * per-slot reward attribution will need later. No `id` field is required.
 */
/**
 * What actually travels between model and renderer: a tree plus the id of
 * the grammar it was derived from (`<name>@<version>`). The compiled JSON
 * Schema pins the exact id, so a renderer built against one grammar version
 * refuses trees derived from another instead of misrendering them.
 */
export interface UIDocument {
  grammar: string;
  tree: UINode;
}

export interface UINode {
  type: string;
  /** Enum-valued parameters of this production. Required if the component declares any props. */
  props?: Record<string, string>;
  /** Child productions. Slots with max cardinality 1 hold a node; others hold an array. */
  slots?: Record<string, UINode | UINode[]>;
  /** Leaf only: field of the current data context to render. */
  bind?: string;
  /** Leaf only: developer-declared string key to render. */
  key?: string;
}
