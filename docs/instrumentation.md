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
| `dwell`, `complete` | reader closed; dwell in ms, complete = fraction read: the smaller of how much of the body was ever on screen and dwell over the text's reading time at 220 wpm (floor 4 s), see below |
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
that fills a textarea with the record. With an endpoint configured the
page also POSTs records with `sendBeacon` on hide and on leave.

## The server (`npm run serve`)

The same loop without copy-paste, in one dependency-free Node process:

| route | what |
|---|---|
| `GET /` | index of users seen so far |
| `GET /u/<user>` | the next instrumented screen for that user, chosen by the policy from their stored sessions; the page beacons to `/events` |
| `POST /events` | a session record; validated with the collector, stored, deduplicated |
| `GET /sessions/<user>` | that user's assembled sessions with reward and next-session state |
| `GET /export.jsonl` | every current session, one per line: the raw export |
| `GET /status` | readers, sessions, mean reward by session index, the sim-to-real gap on recent sessions; `/status.json` for scripts; `?sim=0` skips the simulation, `?recent=N` sets how many sessions it covers |

The learned policy is served with exploration (`--epsilon`, default 0.1)
and every served screen's decision trace is recorded, so stored sessions
can train the policy: see docs/real.md.

Storage is an append-only JSONL log under `--store` (default
`out/server`). A session is identified by (user, session). The page sends
a snapshot on every hide and a final record on leave, and delivery order
is not guaranteed, so when several records arrive for one session the one
with the most events wins: the page only ever appends events, so a final
supersedes its snapshots and a late snapshot cannot undo a final. The
store reloads from the log on start.

### Exposing it: `--token`

Without a token the server is open and refuses to bind anywhere but
loopback. With one (`--token <secret>`, at least 16 characters, or
`PROTEUS_TOKEN`):

- Operator routes (`/`, `/status`, `/sessions/<user>`, `/export.jsonl`, `/link/<user>`)
  need `Authorization: Bearer <token>`. The token never goes in a URL.
- A user's screen URL is signed: `/u/<user>?k=<hmac of the user id under
  the token>`. Mint one with `GET /link/<user>` (operator) and hand it
  out. An unsigned or mis-signed link is refused, so ids cannot be guessed.
- The page posts its records to `/events?k=<same signature>`, so a poster
  can only post sessions for the user their link names. A record without
  its user's signature is refused.
- Repeated failed authentication from one address is cut off (100 per
  hour), and comparisons are constant-time.

    PROTEUS_TOKEN=$(openssl rand -hex 24) npm run serve -- --host 0.0.0.0
    curl -s -H "Authorization: Bearer $PROTEUS_TOKEN" localhost:8787/link/alice

To reach it from a phone, put an HTTPS tunnel in front (any of the usual
ones works; the server speaks plain HTTP on the port you give it) and send
the minted link with the tunnel's host in place of localhost. Records are
small and `sendBeacon` survives the tab closing. Behind a tunnel every
client arrives from the tunnel's own address, so run with `--trust-proxy`
to count authentication failures per forwarded client (first
`X-Forwarded-For` entry) rather than per tunnel; otherwise one caller's bad
requests would lock out everyone. Set it only when the proxy overwrites
that header.

Hand out links with real articles behind them: `--content content.json`
serves syndicated feeds instead of the fake data and fills Saved,
Following and Continue Reading from what each reader actually did. See
[docs/content.md](content.md).

This is enough to hand links to a few dozen people you know. It is not a
multi-tenant service: one secret, no accounts, no rate limiting beyond
the failed-auth cut-off.

    npm run train                 # a policy to serve with (or --policy random)
    npm run serve                 # http://localhost:8787
    open http://localhost:8787/u/alice   # use it, leave the tab, reload for the next screen

## Completion

`complete` used to be the furthest scroll fraction in the reader, which
made every short body fully read the moment it opened and a long one fully
read when skimmed to the end. With live content most bodies are one to six
paragraphs, so that definition saturated on open and carried no signal.

Completion is now `completionOf` in `src/client/recorder.ts`, a pure
function the client calls on close: the smaller of the fraction of the
body that was ever on screen (1 when it fits) and dwell over the expected
reading time, words at 220 words a minute with a 4 s floor. A one-second
glance at a summary is a quarter read; a 2200-word piece scrolled to the
end in five minutes is half read; half an hour on the first third of it is
a third. The simulator already draws dwell as completion times reading
time (±30%), so the two sides define completion the same way, and the
reward's completion term is unchanged.

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
- Server (`check-server.ts`): serves a user's screen, accepts a snapshot,
  lets the final replace it, ignores a late smaller snapshot, rejects
  malformed and non-JSON bodies, assembles sessions with reward and state,
  advances the session index, exports one line per session, and reloads
  the store from its log.

## A real session, for the record

One session on the trained policy's screen, in the app's browser pane:
22 events, 2 opens, both read to the end, 3 scroll-pasts, a follow. Reward
4.21. The next screen was then chosen by the policy conditioned on it.

## Known limits

- `complete` is bounded by time, not measured: a reader who stared at the
  text for its reading time counts as having read it. Dwell keeps running
  while the tab is hidden with the reader open, so a reader who switches
  away and comes back is over-counted; pausing dwell on hide is the next
  refinement.
- Following "Read the original" is recorded as `action: read` on the card.
  The reward gives it no weight yet: what a click-through is worth is a
  calibration decision to make with real sessions, not a guess.
- The reader is a stand-in for an article page; a real app would report
  dwell and completion from its own reader.
- Impressions use a 300 ms, 50% visibility rule with no per-element
  attention model, the same simplification the simulator makes.
- The server is for local use: no authentication, no rate limiting, one
  process, one log file.
