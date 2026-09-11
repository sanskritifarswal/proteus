# Sampling derivations: the decision interface

Source: [`src/sample.ts`](../src/sample.ts). Run `npm run sample -- --seed 3 --n 5 --policy local`.

## Why the sampler is the RL interface

Building a tree from the grammar is a sequence of decisions, each made at a
path in the tree. The sampler walks the grammar and, at every decision, asks
a **policy** for an index into the legal options. Every option offered is
legal under the grammar, so any policy produces a tree the compiled schema
accepts. That makes the sampler the factored action space the RL policy will
plug into: it never has to know the grammar, only how to choose.

| Decision kind | Made at | Options | Example |
|---|---|---|---|
| `props` | every node with props | the valid joint prop assignments (after `propIn` constraints) | Card: `{variant: hero}`, `{variant: standard}`, `{variant: compact}` |
| `arity` | every slot | legal child counts after constraints | `Card.meta`: 0, 1, 2 |
| `type` | every child position in a slot accepting more than one type | accepted component types | (none in the newsfeed grammar yet) |
| `content` | every leaf | `bind:<field>` and `key:<string>` legal in this context | `Text@article` title slot: `bind:title` |

Each decision carries its `path` (e.g. `sections[1].content.item.meta[0]`),
the component and data context, and a `weights` array: the number of complete
derivations reachable through each option, computed exactly by
[`src/count.ts`](../src/count.ts). Paths are the same identity the design
doc uses for reward attribution, so a policy can condition on them and a
reward can be credited back to them.

## Built-in policies

- **`localUniform`** picks uniformly among the options at each decision. This
  is the natural random baseline for a factored policy and produces trees of
  varied shape (mean ~30 nodes).
- **`uniformDerivation`** weights each option by its completion count, which
  gives exactly uniform sampling over all 10⁸² derivations. Because the count
  is dominated by maximal trees, almost every sample is maxed out (mean ~96
  nodes: five sections, two meta lines, two buttons). Useful as a statement
  about the space, not as a baseline.

The gap between those two numbers is the practical reason a policy must be
factored per decision rather than treating derivations as arms.

## Guarantees checked by `npm run check`

- 200 samples per policy validate against the compiled schema.
- Sampling is deterministic for a seed and differs across seeds.

## Known limits

- For `distinctBy` slots the values already used are removed from later
  draws, so children differ by construction and any policy fills the slot.
- For plain `distinct` slots a duplicate draw is discarded. A stochastic policy
  gets up to 2n draws to fill n positions; a deterministic policy cannot
  produce two distinct children, so the slot is truncated to what was drawn.
  The tree stays valid because every distinct slot in the grammar has min 0.
- Options with zero complete derivations behind them are filtered before the
  policy sees a decision, so a policy can only choose completable branches.
- The `props` decision is a joint choice per node. A finer factoring (one
  decision per prop) would need `propIn` constraints applied incrementally.

## First findings from sampling (seed 3, local policy, grammar 0.2.0)

Looseness the hand-written examples never exposed. All four became
constraints in grammar 0.3.0; see docs/gallery.md for the full list.

- A section's heading key can disagree with its source (`source=forYou`
  headed by `section.topStories`). Heading keys should be tied to the
  source, or headings should bind `feed.name` only.
- A hero card can carry a square (`1:1`) image. Hero should require `16:9`
  or `4:3`.
- Section headings can be two or three lines. Headings should be one line.
- Two sections can bind the same source. `Screen.sections` should be
  distinct by `source`, which needs a "distinct by prop" slot rule rather
  than whole-node `uniqueItems`.
