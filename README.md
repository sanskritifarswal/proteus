# Proteus

Generative UI framework. Developers define UI components at compile time as a typed grammar
(components, slots, valid slot types); at runtime a model assembles a personalised UI from that
grammar. Currently at step one: getting the grammar right.

Read [docs/grammar.md](docs/grammar.md) for the design.

## Layout

| Path | What |
|---|---|
| `src/grammar-types.ts` | Meta-types: what any Proteus grammar looks like |
| `src/grammars/newsfeed.ts` | Starter grammar: reading/news feed home screen |
| `src/tree.ts` | Grammar-agnostic UI tree node type |
| `src/compile-schema.ts` | Grammar → JSON Schema compiler (also type-checks the grammar) |
| `src/validate.ts` | Validates `examples/valid` (must pass) and `examples/invalid` (must fail) |
| `src/count-space.ts` | Exact count of derivations the grammar admits |
| `schema/newsfeed.schema.json` | Generated; do not edit |
| `examples/` | Example UI trees |

## Commands

Node 24+ (runs TypeScript directly, no build step).

```bash
npm install
npm run check    # regenerate schema, validate all examples
npm run count    # derivation-space sizes
```
