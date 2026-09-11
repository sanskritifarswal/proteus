/**
 * Proteus grammar meta-types.
 *
 * A Grammar is what a developer writes at compile time. It is a typed,
 * bounded context-free grammar over UI components:
 *
 *   - Components are productions. Each has named slots (non-terminals)
 *     and enum props (parameters of the production).
 *   - Slots list which component types they accept, with cardinality.
 *   - Leaves (Text, Image, Button) never carry free content. They either
 *     bind to a field of the current *data context* or reference a
 *     developer-declared string key.
 *   - Data contexts (e.g. screen -> feed -> article) are a second typing
 *     layer: a slot may switch the context its children are evaluated in,
 *     and a leaf may only bind fields that exist in its context.
 *
 * A UI tree that satisfies the grammar IS a derivation: every node is a
 * production choice, every prop is a parameter choice. That derivation is
 * the thing a model (bandit, later a world model) picks at runtime.
 */

/** Kinds of data a leaf can bind to. Extend as leaves grow (e.g. 'number', 'url'). */
export type FieldKind = 'text' | 'image';

export interface ContextDef {
  description: string;
  /** Fields a leaf may bind to while in this context, and their kind. */
  fields: Record<string, FieldKind>;
}

export interface PropDef {
  description?: string;
  /**
   * Allowed values. All props are required on a node and there are no
   * defaults, so every derivation is fully explicit (good for the renderer,
   * essential for the bandit: no hidden choices).
   */
  values?: readonly string[];
  /** Alternative to `values`: allowed values depend on the data context. */
  valuesByContext?: Record<string, readonly string[]>;
}

export interface SlotDef {
  description?: string;
  /** Component types this slot accepts. */
  accepts: readonly string[];
  /** Cardinality. max === 1 encodes as a single node; max > 1 as an array. */
  min: number;
  max: number;
  /** Data context children are evaluated in. Omit to inherit the parent's. */
  context?: string;
  /** Narrow the child's prop values (e.g. a Card's title slot only takes role=title Text). */
  childProps?: Record<string, readonly string[]>;
  /** Force the child leaf to use a data binding or a string key. */
  childContent?: 'bind' | 'key';
  /** Restrict which context fields the child leaf may bind (subset of the context's fields). */
  childBind?: readonly string[];
  /** Array slots only: forbid two identical children. */
  distinct?: boolean;
}

export interface ContentDef {
  /** Leaf may bind to a context field of one of these kinds. */
  bind?: readonly FieldKind[];
  /** Leaf may reference a string key. `true` = any key in grammar.strings. */
  keys?: true | readonly string[];
}

export interface Condition {
  prop: string;
  is: string;
}

/**
 * Cross-node constraints that a plain slot/type listing cannot express.
 * Kept declarative so they compile to JSON Schema `if/then` and so the
 * derivation counter can honour them.
 */
export type Constraint =
  | { when: Condition; requireSlot: string }
  | { when: Condition; forbidSlot: string }
  | { when: Condition; propIn: { prop: string; in: readonly string[] } }
  | { when: Condition; childProps: { slot: string; prop: string; in: readonly string[] } };

export interface ComponentDef {
  description: string;
  /** Contexts this component may appear in. The compiler rejects a slot that would place it elsewhere. */
  contexts: readonly string[];
  props?: Record<string, PropDef>;
  slots?: Record<string, SlotDef>;
  content?: ContentDef;
  constraints?: readonly Constraint[];
}

export interface Grammar {
  name: string;
  version: string;
  root: string;
  rootContext: string;
  contexts: Record<string, ContextDef>;
  /** Developer-declared string keys. The only "literal" text a derivation may reference. */
  strings: readonly string[];
  components: Record<string, ComponentDef>;
}
