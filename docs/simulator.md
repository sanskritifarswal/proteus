# User simulator, events and reward

Sources: [`src/events.ts`](../src/events.ts), [`src/reward.ts`](../src/reward.ts),
[`src/sim/`](../src/sim/). Run `npm run simulate -- --users 300 --sessions 10 --seed 1`.

## Why a simulator comes before the policy

Sequential RL needs thousands of episodes, and an exploring policy on real
users is exactly the dark-pattern risk the design notes warn about. So the
policy learns against synthetic readers first. The simulator shares the
tree types, the path rule and the event format with the real renderer, so
nothing learned here has to be translated to run on real sessions. The
sim-to-real gap is still the project's main risk; sharing code shrinks it,
it does not remove it.

## The MDP

| Term | Here |
|---|---|
| Episode | one user over up to N sessions; ends early when they do not return |
| Step | one screen: the policy emits a derivation, the user responds |
| State | the user's event history (what the local scorer sees) plus session index |
| Action | a derivation, made one grammar decision at a time (see docs/sampler.md) |
| Reward | composite per-session score, `sessionReward` |

## Events (`src/events.ts`)

One format for the simulator and for real instrumentation. Every event
names a node by path and, where relevant, the article.

| Type | Meaning | value / action |
|---|---|---|
| `impression` | node was seen | |
| `open` | article opened from a card | |
| `dwell` | ms in an opened article | value = ms |
| `complete` | fraction of an opened article read | value = 0..1 |
| `scroll_past` | seen, not opened | |
| `action` | a Button was used | action = save, share, follow, dismiss, seeMore, … |
| `session_end` | end of session | t = length in ms |

Plus `returned` on the session record: `true`, `false`, or `null` when the
session was the last inside the observation window and the outcome is
unobserved (censored, not false). Completion, dismissal and return are in
the format from day one so that a composite reward is the easy path. The
event type is a discriminated union, so each payload's required fields are
enforced by `tsc`.

## Reward (`src/reward.ts`)

Weighted sum with the largest weights on completion and return, dismissal
as a real negative, and saturating volume terms (square root of opens and
of total completion, capped dwell). Weights are a parameter: the local
scorer can shift them per user or expose some to the user.

## Synthetic readers (`src/sim/users.ts`)

Four archetypes with per-user noise: power-reader (compact, text, patient,
reads to the end), browser (comfortable, visual, impatient), local-loyalist,
casual. Latent fields: density and visual preference, topic affinities,
patience, curiosity, read depth, social propensity, return baseline. The
policy never sees these; it only sees events.

## One session (`src/sim/simulate.ts`)

Walk the tree in render order. For each shown article: does the user still
scroll this far (patience, stretched by density fit), do they open it
(curiosity, topic affinity, visual fit of the card, text on the card for
readers who want text, clutter from buttons for readers who do not, small
tiles in grids and carousels, novelty), how much do they read, and which of
the card's *available* buttons do they use. A user can only dismiss an
article if the derivation put a dismiss button on that card.

Feeds the user built themselves (following, saved, continue reading) are
filled with articles on topics that user likes, because that is what
following or saving means. A flat relevance boost on undifferentiated
content was the first version's mistake: any tree that merely covered those
sections won.

Session satisfaction sets the return probability. Completed reads raise
it; opened-and-abandoned reads lower it (they feel like bait), as do
dismissals and long low-yield scrolling.

## Checks (`npm run check` runs `src/check-sim.ts`)

- Deterministic per seed.
- Every event names a node in its tree; footer actions only follow an
  impression of that footer (a user who left early cannot use it).
- Outcomes at the session cap are censored either way, never counted as a
  return or as churn.
- Power readers score higher on the dense list than on the editorial home;
  browsers the reverse. A simulator that fails this cannot tell policies
  apart and is not worth training against.
- A tree with no dismiss buttons produces no dismiss events.
- Volume does not pay by itself, in two forms. A layout fitted to patient
  readers (dense and long) beats maximal random trees for them, so richness
  does not substitute for fit. And inflating the browsers' fitted layout
  (every limit to 10, every card given a summary, two meta lines and two
  buttons) lowers their reward, so clutter and quantity cost something.

## Baselines and the first finding

`npm run simulate` runs five policies on the same population: a random
derivation per session (per-decision uniform, and exact-uniform), and each
of the three hand-written examples as a fixed screen.

Mixed population, 300 users, up to 10 sessions, seed 1:

| policy | episode reward | sessions/user | return | opens/session |
|---|---|---|---|---|
| random-local | 59.0 | 4.38 | 80% | 3.6 |
| random-uniform | 72.3 | 4.71 | 83% | 4.2 |
| fixed-editorial-home | 45.2 | 4.30 | 80% | 2.9 |
| fixed-dense-list | 58.6 | 4.43 | 81% | 3.4 |
| fixed-visual-grid | 57.1 | 4.44 | 81% | 3.8 |

Return rate is over observed sessions only; the last session of a capped
episode is censored. Per-archetype runs go the right way: power readers
score 147 on the dense list versus 87 on the editorial home; browsers 38 on
the visual grid versus 16 on the dense list. So the simulator separates layouts by audience, which
is the property a policy needs.

**The finding:** exact-uniform random trees, which are almost always maximal
(five sections, ten items each, every button), beat every fixed layout on
the mixed population. Under the current reward and user model, volume
wins: more sections means more topic hits, and completion is linear in
count. Return rate barely moves between policies (81–85%) because the
baseline dominates the satisfaction term. That is precisely the incentive
the design guardrail warns about, reproduced in miniature before any
learning happened. Two knobs to tune next, with the check above as the
guard: make satisfaction (and so return) more sensitive to long,
low-yield scrolling, and saturate completions per session the way opens
already are.

## Known limits

- Everything is hand-designed. No parameter here is calibrated on real
  data, and real data is what the init/export layer will eventually give.
- Users do not remember layouts, only articles. Layout fatigue and novelty
  are not modelled.
- Topic affinity is static per user; interests do not drift.
- Section order matters only through scroll position. There is no model of
  a user looking for a specific section.
