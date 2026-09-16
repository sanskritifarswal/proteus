# Proteus

Generative UI framework. Developers define UI components at compile time as a typed grammar
(components, slots, valid slot types); at runtime a model assembles a personalised UI from that
grammar. Currently at step one: getting the grammar right.

Read [docs/grammar.md](docs/grammar.md) for the design, [docs/sampler.md](docs/sampler.md) for the decision interface, [docs/gallery.md](docs/gallery.md) for the look-and-fix loop, [docs/simulator.md](docs/simulator.md) for events, reward and synthetic users, [docs/policy.md](docs/policy.md) for the learned policy, [docs/instrumentation.md](docs/instrumentation.md) for real sessions in the simulator's format, [docs/real.md](docs/real.md) for training on them and measuring the sim-to-real gap, and [docs/content.md](docs/content.md) for serving real articles from syndication feeds.

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
| `src/events.ts`, `src/reward.ts` | Event format shared by simulator and real instrumentation; composite per-session reward |
| `src/sim/` | Synthetic readers, one-session simulation, episode runner, baseline comparison CLI |
| `src/check-sim.ts` | Simulator checks (determinism, path validity, preferences move reward) |
| `src/policy/` | State features, linear softmax policy, REINFORCE trainer, train-and-evaluate CLI |
| `src/check-policy.ts` | Policy checks (determinism, untrained = uniform, short training improves) |
| `src/client/` | Event recorder (no DOM, unit-tested) and the DOM binding embedded in rendered pages |
| `src/collect.ts` | Validates exported sessions, derives `returned`, computes reward and state |
| `src/demo.ts` | Renders the next instrumented screen for a user from their exported history |
| `src/check-client.ts` | Recorder and collector checks |
| `src/server.ts` | Local server: serves each user's next screen, receives the page's beacons, exports sessions |
| `src/check-server.ts` | Server checks (in-process, ephemeral port) |
| `src/check-auth.ts` | Token, signed links, operator routes, exposure guard |
| `src/content/` | Live content: RSS/Atom parser, article pool, personal feeds derived from a user's actions (see [docs/content.md](docs/content.md)) |
| `src/check-content.ts` | Parser, pool, cache and served-page checks, offline on fixtures |
| `src/status.ts`, `src/check-status.ts` | Operator status page: readers, sessions, reward by session index, sim-to-real gap on recent sessions |
| `src/real/` | Training from stored real sessions, the sim-to-real comparison, synthetic clients |
| `src/check-real.ts` | Real-session pipeline checks (serve with exploration → clients → train-real → compare) |
| `schema/newsfeed.schema.json`, `schema/newsfeed.grammar.json` | Generated; do not edit |
| `examples/` | Example UI trees |

## Commands

Node 24+ (runs TypeScript directly, no build step; `tsc` is used only to type-check).

```bash
npm install
npm run check    # type-check, regenerate schema, validate examples, check sampler and simulator
npm run schema   # regenerate schema + grammar JSON export
npm run count    # derivation-space sizes
npm run sample -- --seed 1 --n 3 --policy local   # print sampled UI documents
npm run gallery -- --seed 1 --n 20               # render 20 samples to gallery/index.html
npm run simulate -- --users 300 --sessions 10    # compare baseline policies on synthetic users; trajectories to out/
npm run train                                    # train the linear policy, evaluate vs baselines on held-out users
npm run twins                                    # does within-episode experimentation pay? full vs ablated state on the twins
npm run demo                                     # render an instrumented screen (demo/index.html); export a session from it
npm run collect -- --add session.json            # validate an exported session, append it, print reward and state
npm run serve                                    # local server with exploration: /u/<user> serves screens, /events receives them, traces recorded
PROTEUS_TOKEN=... npm run serve -- --host 0.0.0.0 # exposed: bearer token for operator routes, signed user links (GET /link/<user>)
npm run clients -- --users 50 --sessions 5       # synthetic users against a running server (pipeline test, not a gap measurement)
npm run train-real                               # policy-gradient epochs from the store's traced sessions -> out/policy-real.json
npm run compare -- --store out/server            # real sessions vs simulated populations on the same trees, as z-scores
```
