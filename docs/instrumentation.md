# Instrumentation: real sessions in the simulator's format

Sources: [`src/client/recorder.ts`](../src/client/recorder.ts),
[`src/client/instrument.ts`](../src/client/instrument.ts),
[`src/render-html.ts`](../src/render-html.ts) (`renderPage`),
[`src/collect.ts`](../src/collect.ts), [`src/demo.ts`](../src/demo.ts).

This is the init/scaffold layer: a working screen from day one, and raw
data exports in exactly the format the simulator produces, so the same
reward, state features and training code run on real sessions with no
translation. The sim-to-real gap is still real; sharing the format and
the code removes one whole class of it.

## The loop on one machine

    npm run demo                       # 1. render an instrumented screen for a user
    open demo/index.html               # 2. use it; press "Export session"; save the JSON
    npm run collect -- --add that.json # 3. validate and append to out/sessions.jsonl
    npm run demo                       # 4. the policy reads the history, picks the next screen

`demo` picks the tree with the trained policy from `out/policy.json`
(greedy, conditioned on the user's exported sessions), or `--policy random`,
or a fixed example. `collect` validates every record, derives `returned`
from whether a next session exists (censored on the last), and prints
reward and the next-session state.

## What the page records

| event | when |
|---|---|
| `impression` | a card or section footer at least half visible for 300 ms (once per card and article) |
| `open` | a click on a card, not on a button in it; opens the in-page reader |
| `dwell`, `complete` | reader closed; dwell in ms, complete = furthest scroll fraction reached |
| `scroll_past` | a card that had an impression left the viewport without being opened |
| `action` | a button click, with the button's own node path and the card's article |
| `session_end` | the page is left |

Two design points that matter:

- **Going hidden does not end the session.** A backgrounded tab usually
  comes back, especially on a phone. On `visibilitychange` the page
  flushes a *snapshot* (the record so far plus a synthetic `session_end`)
  to `localStorage` and, if an endpoint is configured, `sendBeacon`; only
  `pagehide` ends the recorder. The first version ended on hidden and
  refused every later open; a browser tab swap during testing caught it.
- **The recorder has no DOM in it.** `createRecorder` takes observations
  and produces the record, so its behaviour (deduplicated impressions, one
  open at a time, close emits dwell and complete, end is idempotent) is
  unit-tested in Node. The DOM binding is a thin layer over it.

## Export

The page exposes `window.proteus.export()` and an "Export session" button
that fills a textarea with the record. `--endpoint <url>` makes the page
also POST records with `sendBeacon` on hide and leave. No server exists in
this repo; the endpoint is a hook for one.

## Validation (`collect.ts`)

A record must carry the current grammar id, a Screen tree, and events
whose type-specific fields are present (open needs an article, dwell and
complete need a numeric value, complete in 0..1, action needs an action),
whose paths are nodes in that tree, whose timestamps do not go backwards,
and which end with `session_end`. Malformed records are rejected with the
reasons.

## Checks (`npm run check` runs `src/check-client.ts`)

- A scripted recorder session produces the expected event sequence,
  passes the collector's validation, has every path in the tree, and its
  reward matches the formula by hand.
- A snapshot appends `session_end` without ending the recorder.
- With a next session present, the earlier one is marked returned; a lone
  session is censored.
- Malformed records are rejected.
- The embedded client script has no `export` or `declare` left in it.

## A real session, for the record

One session on the trained policy's screen, in the app's browser pane:
22 events, 2 opens, both read to the end, 3 scroll-pasts, a follow. Reward
4.21. The next screen was then chosen by the policy conditioned on it.

## Known limits

- `complete` is the furthest scroll fraction in the reader. An article
  that fits without scrolling counts as fully read on close. Time-based
  reading estimates would be better.
- The reader is a stand-in for an article page; a real app would report
  dwell and completion from its own reader.
- Impressions use a 300 ms, 50% visibility rule with no per-element
  attention model, the same simplification the simulator makes.
- No server: exports are manual or via an endpoint the app provides.
