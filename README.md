# Proteus

Generative UI framework. Developers define UI components at compile time as a typed grammar
(components, slots, valid slot types); at runtime a model assembles a personalised UI from that
grammar. Currently at step one: getting the grammar right.

Read [docs/grammar.md](docs/grammar.md) for the design, [docs/sampler.md](docs/sampler.md) for the decision interface, and [docs/gallery.md](docs/gallery.md) for the look-and-fix loop.

## Layout

| Path | What |
|---|---|
| `src/grammar-types.ts` | Meta-types: what any Proteus grammar looks like |
| `src/grammars/newsfeed.ts` | Starter grammar: reading/news feed home screen |
| `src/tree.ts` | Grammar-agnostic UI document (grammar id + tree) and node types |
| `src/compile-schema.ts` | Grammar → JSON Schema compiler (also type-checks the grammar) |
| `src/validate.ts` | Validates `examples/valid` (must pass) and `examples/invalid` (must fail) |
| `src/count.ts` | Derivation-space arithmetic shared by the counter and the sampler |
| `src/count-space.ts` | Prints exact derivation counts |
| `src/sample.ts` | Derivation sampler: a policy walks the grammar one decision at a time (see [docs/sampler.md](docs/sampler.md)) |
| `src/sample-cli.ts`, `src/check-sampler.ts` | Sampler CLI and its checks |
| `src/export-grammar.ts` | Dumps the grammar spec as JSON for non-TypeScript consumers |
| `src/render-html.ts`, `src/fake-data.ts` | Plain HTML renderer for newsfeed trees plus fake content; elements carry `data-path` |
| `src/gallery.ts` | Samples N trees and renders them to one page (`gallery/index.html`, not committed) |
| `schema/newsfeed.schema.json`, `schema/newsfeed.grammar.json` | Generated; do not edit |
| `examples/` | Example UI trees |

## Commands

Node 24+ (runs TypeScript directly, no build step).

```bash
npm install
npm run check    # regenerate schema, validate all examples, check the sampler
npm run schema   # regenerate schema + grammar JSON export
npm run count    # derivation-space sizes
npm run sample -- --seed 1 --n 3 --policy local   # print sampled UI documents
npm run gallery -- --seed 1 --n 20               # render 20 samples to gallery/index.html
```
