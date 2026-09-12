# The first learned policy

Sources: [`src/policy/`](../src/policy/). Run `npm run train` (about 25 s).

## What it is

A factored linear softmax policy over the sampler's decisions, trained by
REINFORCE against the synthetic population. No dependencies, no PyTorch. It
exists to prove the loop closes end to end: grammar → sampler decisions →
policy → simulated users → reward → gradient → better policy. A richer
model can replace `LinearPolicy` later without touching the sampler, the
simulator or the reward.

## What it sees

Only what a local, on-device scorer could see: a small vector summarising
the user's own event history within the episode (`features.ts`): open
rate, mean completion, dismiss rate, scroll-past rate, action rate, dwell,
whether they returned last time, the density they were last shown, and
the last session's reward. Session 0 is cold (bias only). Latent
preferences are never available.

## How it chooses

For each decision the sampler offers, each option gets a logit
`w[key] · state`, and the choice is sampled from the softmax. The key names
the decision by kind, component, slot and option text, with paths
collapsed to slot names so the same choice at `sections[0]` and
`sections[3]` shares parameters. Around 100 keys × 11 features.

## How it learns

Each iteration a fresh population runs one episode each. Every decision is
recorded with its state and probabilities. The reward-to-go from each
session is compared with a running per-session-index baseline, advantages
are standardised over the batch, and each decision's log-probability
gradient is scaled by its session's advantage. Plain policy gradient with a
moving baseline.

## Result (80 iterations × 150 users, lr 0.15, seed 1; held-out 400 mixed users)

| policy | episode reward | sessions/user | return |
|---|---|---|---|
| random-local | 34.7 | 3.50 | 74% |
| random-uniform (best baseline) | 40.7 | 3.62 | 75% |
| fixed-dense-list (best fixed) | 39.3 | 3.67 | 77% |
| learned, sampled | 48.2 | 4.20 | 80% |
| learned, greedy | 50.4 | 4.21 | 80% |

The learned policy beats the best baseline by 24% on users it never saw.
Dismissals drop to near zero and return rate rises five points.

## What it learned, and what it did not

By archetype, choices from session 2 on (when history exists):

| archetype | reward | compact density | sections | hero lead | compact items | buttons/card |
|---|---|---|---|---|---|---|
| power-reader | 105.8 | 77% | 4.0 | 0.16 | 12% | 0.70 |
| browser | 17.9 | 79% | 4.0 | 0.15 | 15% | 0.75 |
| local-loyalist | 60.2 | 75% | 4.0 | 0.15 | 12% | 0.70 |
| casual | 6.5 | 72% | 4.1 | 0.22 | 8% | 0.81 |

It learned a good **global prior**: compact density, four sections,
standard cards, few buttons, rarely a hero lead. It did **not** learn to
condition on the user: browsers get compact 79% of the time although the
simulator says they prefer comfortable. The state carries the information
(mean completion alone separates power readers from browsers), so this is
a training-signal problem, not an observability problem: the personalising
weights sit on interaction terms whose gradient is small and noisy
relative to the global terms. Training curves confirm the noise (the
batch mean swings by ±5 between iterations). A longer run, 250 iterations
× 200 users at lr 0.1, reached the same held-out greedy score (50.5) with
the same lack of conditioning (compact density 58–62% for every
archetype), so more of the same training is not the fix.

Next steps, in order of expected payoff:

1. Variance reduction: a learned value baseline conditioned on state
   instead of a per-session-index mean, and larger batches.
2. Per-session credit: attribute session reward to that session's
   decisions with a discount, rather than full reward-to-go.
3. Explicit exploration on the personalising axis (density, item variant)
   early in an episode, so the history features have signal to condition on.
4. Then a non-linear model, which is where PyTorch enters.

## Checks (`npm run check` runs `src/check-policy.ts`)

- Training is deterministic per seed.
- The untrained policy behaves exactly like per-decision uniform random.
- 25 iterations improve held-out reward by more than 5%.
