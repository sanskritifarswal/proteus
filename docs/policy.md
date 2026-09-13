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
recorded with its (centred) state and probabilities. The reward-to-go from
each session is compared with a linear value baseline fit on the batch,
advantages are standardised within each session index, and each
decision's log-probability gradient is scaled by its session's advantage.
Weights are updated with Adam. After the step, the feature normaliser is
blended toward the batch statistics with a logit-preserving transform of
the weights, so the update changes nothing the optimizer did not.

## Result, second version (150 iterations × 200 users, Adam lr 0.02, ε 0.1; held-out 400 mixed users)

| policy | episode reward | sessions/user | return |
|---|---|---|---|
| random-local | 34.7 | 3.50 | 74% |
| random-uniform (best baseline) | 40.7 | 3.62 | 75% |
| fixed-dense-list (best fixed) | 39.3 | 3.67 | 77% |
| learned, sampled | 54.2 | 4.28 | 81% |
| learned, greedy | 58.8 | 4.50 | 82% |

45% over the best baseline on users the trainer never saw, up from 24% in
the first version. Dismissals are zero under the greedy policy.

## What it learned, by archetype

Choices from session 2 on, when history exists:

| archetype | reward | compact density | sections | hero lead | compact items | buttons/card |
|---|---|---|---|---|---|---|
| power-reader | 126.8 | 96% | 4.6 | 0.27 | 77% | 1.00 |
| browser | 28.5 | 10% | 2.6 | 0.23 | 4% | 0.25 |
| local-loyalist | 64.6 | 65% | 3.4 | 0.19 | 28% | 0.67 |
| casual | 8.8 | 0% | 2.2 | 0.08 | 0% | 0.28 |

The conditioning gap (compact for power readers minus compact for
browsers) is 86 points. It conditions more than density: power readers get
long screens of compact cards with buttons; browsers and casual readers
get short, comfortable screens of standard cards with almost no buttons.
Browsers' reward rose from about 17 (first version, which showed them
compact) to 28.5.

## How it got there: what did not work, and what did

The first version learned a global prior and no conditioning (gap ≈ 0).
Six changes were tried, each measured by the gap on held-out archetypes:

| change | held-out greedy | gap |
|---|---|---|
| first version (per-index baseline, SGD lr 0.15, 80 it) | 50.4 | 4 |
| + value baseline (30% of return variance removed) | 50.5 | 4 |
| + discount γ = 0.9 | 49.7 | −1 |
| + large batch, small step (300 users, lr 0.05, 200 it) | 52.8 | −3 |
| + ε = 0.2 exploration floor | 52.7 | −1 |
| + per-session-index advantage standardisation | 51.6 | −5 |
| + Adam | 53.5 | 0 |
| **+ centred features** (SGD, 80 it) | 47.2 | **29** |
| **+ centred features + Adam** (150 it) | **58.8** | **86** |

Variance reduction, credit assignment, exploration and the optimiser each
raised the score a little and none of them moved the gap. A probe of the
trained weights showed why: every weight on the compact-versus-comfortable
difference was positive, so the "conditioning" was the global prior
smeared across all features, and the logit difference was 3 to 4 for every
archetype.

The structural cause was that all state features are non-negative. For a
power reader, where compact is good, the gradient pushes the completion
weight positive. For a browser, where comfortable is good, completion is
also positive, so the gradient pushes the same weight negative. The two
cancel and only the bias learns. Centring the features (per-feature mean
and scale, fit on training batches and stored with the policy) makes
deviations signed, so both groups push the weight the same way. The probe
also found two dead features: "returned last time" is always 1 when
history exists, and dwell was pinned at its cap; both were replaced.

Centring alone produced the gap. Adam on top of centring produced the
score, because per-parameter step normalisation lets the small, signed
personalising gradients move their weights as far as the large global one.

## Value baseline

`value.ts` fits a linear V(state) by ridge regression on each batch;
advantages are reward-to-go minus V. It removes about 30% of return
variance against about 0% for the per-session-index mean, and is on by
default. A discount `gamma` is available and off by default; it did not
help here.

### Is personalisation even there to learn?

Yes. Flipping only `density` on each fixed layout, 400 users per archetype,
up to 8 sessions (episode reward, comfortable minus compact):

| archetype | editorial-home | dense-list | visual-grid |
|---|---|---|---|
| power-reader | −8.9 | −8.0 | −9.5 |
| browser | +4.3 | +5.5 | +4.9 |
| local-loyalist | +2.2 | 0.0 | +2.5 |
| casual | +0.5 | +1.1 | +1.1 |

Opposite signs, and for browsers close to half their total reward. This
diagnostic is what showed the learner, not the simulator, was the problem.

## Next steps

1. Per-decision credit within a session: today all ~30 decisions in a
   session share one advantage.
2. Richer state: per-topic engagement, and what was shown before with what
   result, so the policy can run its own small experiments on a user.
3. A non-linear model once the linear one plateaus, which is where PyTorch
   enters via the grammar JSON export.
4. Renderer instrumentation producing the same events for real sessions.

## Checks (`npm run check` runs `src/check-policy.ts`)

- Training is deterministic per seed.
- The untrained policy behaves exactly like per-decision uniform random.
- 25 iterations improve held-out reward by more than 5%.
- The value baseline removes more return variance than the per-index one.
- The learned policy shows compact to power readers more than to browsers
  by more than 10 points after 25 iterations (the centring property).
