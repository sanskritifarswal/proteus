# Training on real sessions

Sources: [`src/real/`](../src/real/), the server's `--epsilon` and trace
store in [`src/server.ts`](../src/server.ts).

There are no real sessions at scale yet. What exists is the pipeline,
proven end to end with synthetic clients standing in for people, and the
tool that will measure the sim-to-real gap once people arrive. This page
says exactly which is which.

## Serve with exploration, record traces

Policy-gradient training needs the probabilities a choice was sampled
from. `npm run serve` now serves the learned policy with exploration
(`--epsilon`, default 0.1: sample from (1−ε)·policy + ε·uniform) and
records the decision trace of every served screen (the options offered,
the sampling probabilities, the choice, the state) to `traces.jsonl` in
the store, keyed by (user, session, hash of the served tree). A user may
load a session's screen more than once before posting; each load is a
different tree with its own trace, and a posted record is matched to the
trace of the tree it actually carries, never to the last one served.
Greedy serving (`--epsilon 0`) records a trace too, but sessions served
greedily carry no unbiased gradient and `train-real` skips them.

Serving is bounded: at most 20 screens per (user, session) before it is
posted; at most 10,000 users who have posted a session (a trace-only id
does not consume a slot, so invented ids cannot exhaust it); and at most
1,000 first-time user ids per remote address per sliding hour, which is
what bounds trace growth from invented ids. Exposing the server beyond
loopback requires `--token`: operator routes take it as a bearer token and
user links are signed with it (docs/instrumentation.md). Exploration seeds come from the OS random source, so
two users in the same state never share an exploration sequence.

## `npm run train-real`

Pairs each stored session with its trace, derives reward-to-go from the
user's later sessions (return derived from whether a next session
exists, censored on the last), fits a linear value baseline on the real
states, and takes Adam epochs of importance-weighted policy gradient
from the current policy: each decision's log-probability gradient under
the *current* policy, scaled by its advantage and by
π_now(choice) / p_served(choice), clipped at 5. Sessions with no trace
for their tree, and sessions served greedily, are skipped and counted.
Writes the updated policy to `out/policy-real.json`. Reports the mean
importance weight (near 1 when the policy has not moved far from what was
served) and the surrogate objective per epoch (must rise). Linear policy
only for now.

## `npm run clients`

Synthetic users driving a running server the way a browser would: fetch
the screen, behave on it with the simulator, POST the record. Exercises
serve → trace → record → store → train-real without a human. Says
nothing about the sim-to-real gap; that needs people.

## `npm run compare`

The gap, measured. For each real session, the same tree is simulated for
a synthetic population (default 200 users) and the real user's per-session
metrics (opens, completion, scroll-past, actions, dwell, reward) are placed
against that distribution as z-scores. A returning user's session is
compared against simulated users carrying that user's own history: the
articles opened in earlier real sessions are already seen, and the
session index matches. A metric whose |z| is routinely
large is one the simulator gets wrong for real people, and where
calibration effort should go.

## What has been verified (`check-real.ts`, in `npm run check`)

With an untrained (uniform) policy served at ε 0.15 to 150 synthetic
users for up to 4 sessions each:

- 371 sessions posted, 0 rejected, 371 traces recorded.
- Two loads of one session before posting keep two traces; the posted
  tree matches its own by hash.
- A session with no matching trace, and a session served greedily, are
  skipped and counted, not trained on.
- Serving a session more than the bound returns 429 until it is posted.
- Importance weights start at 1.000; the surrogate objective rises across
  6 epochs.
- Held-out simulated reward rises from 31.06 to 32.70 (+5%) from the
  stored sessions alone, with no simulator in the training loop.
- `compare` produces finite z-scores.

## The one real session so far

One human session (the author, in the app's browser pane, on the trained
policy's screen), against 300 simulated users on the same tree:

| metric | real | z |
|---|---|---|
| opens | 2.0 | −0.7 |
| completion | 2.0 | −0.3 |
| scroll-past | 3.0 | −0.2 |
| actions | 0.0 | −0.7 |
| dwell (min) | 0.4 | −1.2 |
| reward | 4.2 | −1.2 |

n = 1, so this is a demonstration of the tool, not a finding. It does
show what the tool is for: this reader opened and finished as many
articles as a typical simulated user but spent far less time in them,
which is what someone clicking through a test page does, and which the
simulator's dwell model (read time × completion) does not expect.

## What it will take to mean something

- A few dozen real users over a few sessions each, served with ε > 0.
- `compare` on all of them: which metrics the simulator misses, and by
  how much. Calibrate those (dwell first, on the evidence above).
- `train-real` from the trained policy, then `compare` again on sessions
  served by the updated policy. The first number that matters is whether
  real reward per session rises across that cycle.
