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

Only what a local, on-device scorer could see: an 18-feature vector
summarising the user's own event history within the episode
(`features.ts`). Session 0 is cold (bias only). Latent preferences are
never available.

- **Engagement summary** (11): open rate, mean completion, dismiss rate,
  scroll-past rate, action rate, dwell, opens in the last session, the
  density last shown, the last session's reward.
- **Choice evidence** (4): for each of compact density, compact items,
  hero lead and buttons-per-card, the user's mean session reward when the
  choice was on minus when it was off (0 until both have been tried). A
  linear policy cannot multiply "what I showed" by "what happened", so the
  product is handed to it directly; with the ε exploration floor it gets
  both sides tried early in an episode. This is the policy running a small
  experiment on each user.
- **Sources** (1): open rate on the user's own feeds (following, saved,
  continue reading) minus on general feeds.
- **Topics** (2): share of opens in the most-opened topic, and number of
  topics opened. Needs an article-to-topic lookup, which real
  instrumentation would get from article metadata.

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
| learned, sampled | 54.5 | 4.46 | 82% |
| learned, greedy | 59.3 | 4.61 | 83% |

46% over the best baseline on users the trainer never saw, up from 24% in
the first version. Dismissals are zero under the greedy policy.

## What it learned, by archetype

Choices from session 2 on, when history exists:

| archetype | reward | compact density | sections | hero lead | compact items | buttons/card |
|---|---|---|---|---|---|---|
| power-reader | 125.4 | 95% | 4.7 | 0.06 | 64% | 1.03 |
| browser | 26.0 | 33% | 3.5 | 0.16 | 10% | 0.62 |
| local-loyalist | 59.2 | 71% | 4.0 | 0.15 | 33% | 0.70 |
| casual | 10.1 | 18% | 3.4 | 0.27 | 5% | 0.19 |

The conditioning gap (compact for power readers minus compact for
browsers) is 63 points. It conditions more than density: power readers get
long screens of compact cards with buttons; browsers and casual readers
get shorter, mostly comfortable screens of standard cards with fewer
buttons. Browsers' reward rose from about 17 (first version, which showed
them compact) to 26.

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
| **+ centred features + Adam** (150 it) | **59.3** | **63** |

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
(An earlier version of this table showed a gap of 86; part of that came
from the normaliser moving between a rollout and its update, which changed
behaviour outside the optimizer. With logit-preserving updates the honest
figure is 63.)

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

## Per-decision credit by path: a negative result

Every event names the node path it happened on, so a session's reward can
be attributed back to the subtree that earned it (`attributeReward` in
`reward.ts`: saturating terms are split across the events that formed
them, the return bonus stays shared; the parts sum to the session reward
exactly, checked). With `credit: 'path'` a decision is credited with the
reward under paths related to its own (its subtree, or an ancestor) plus
the shared session-level part, instead of sharing one advantage with the
other ~30 decisions in the session. The local part is baselined by a
running mean per decision key.

It does not help. Same configuration, two seeds each, held-out:

| credit | seed | greedy | sampled | gap |
|---|---|---|---|---|
| session | 1 | 59.3 | 54.5 | 63 |
| session | 2 | 58.6 | 53.6 | 78 |
| path | 1 | 56.4 | 53.7 | 72 |
| path | 2 | 59.4 | 57.8 | 83 |

Means: 59.0 vs 57.9 greedy, 54.0 vs 55.7 sampled, gap 70 vs 78. The gap
moves by 15 points between seeds of the same configuration, so nothing
here is distinguishable from noise. Learning speed (25 and 50 iterations)
is a point faster on reward and slower on the gap. Session credit stays
the default; the option and the attribution stay, because the attribution
is the right primitive for reward reporting per node regardless. (The
local term is divided by the same per-index spread as the session term,
so the two parts are commensurate at every session index.)

Why it likely does not help here: the decisions that matter most (density,
section count, item variant) sit at or near the root, where path credit
equals session credit anyway; leaf decisions inside a card mostly affect
the same card-level events, so their local credit is shared among them
just as the session advantage was. Sharper credit needs a model of what
each decision changed, which is the world-model direction.

## Richer state: mechanism verified, outcome neutral

The 18-feature state (above) replaced the 11-feature one. Same
configuration, two seeds, held-out:

| state | seed | greedy | sampled | gap |
|---|---|---|---|---|
| 11 features | 1 | 59.3 | 54.5 | 63 |
| 11 features | 2 | 58.6 | 53.6 | 78 |
| 18 features | 1 | 56.5 | 54.2 | 60 |
| 18 features | 2 | 57.8 | 54.7 | 63 |

Means 57.2 vs 59.0 greedy, 54.4 vs 54.0 sampled, gap 62 vs 70: neutral
within seed noise. The value baseline explains more of the return with the
new features (37% versus 30%), so they do predict outcomes.

A probe of the trained weights shows the mechanism doing what it was built
for: the density decision puts one of its largest weights (+0.87 on the
normalised feature) on the compact-density evidence, with the right sign,
so "compact worked for this user" pushes toward compact. Why it does not
move the outcome here:

- Evidence exists only once both sides of a choice have been tried. That
  is 0% of users at sessions 0 and 1, 51% at session 2, 81% at session 3.
  Most sessions in an episode are the early ones.
- By the time evidence exists, mean completion alone has already
  identified the archetype. In this simulator every preference is readable
  from engagement statistics, so an experiment adds nothing a summary did
  not already say.

The features stay: the mechanism is the reason to run sequential
decisions rather than a per-screen bandit, and it is now shown to be
picked up by learning. To test whether it pays, the simulator needs users
whose layout preference is *not* inferable from their engagement
summary, for example two archetypes with identical curiosity, read depth
and topics but opposite density preferences. That is the next simulator
change.

## Next steps

1. Simulator: an archetype pair with identical engagement statistics and
   opposite density preferences, to test whether within-episode
   experimentation pays when it is the only way to tell users apart.
2. A non-linear model once the linear one plateaus, which is where PyTorch
   enters via the grammar JSON export.
3. Renderer instrumentation producing the same events for real sessions.
4. Report seed variance with every number: the gap moves ±8 between seeds.

## Checks (`npm run check` runs `src/check-policy.ts`)

- Training is deterministic per seed.
- The untrained policy behaves exactly like per-decision uniform random.
- 25 iterations improve held-out reward by more than 5%.
- The value baseline removes more return variance than the per-index one.
- The learned policy shows compact to power readers more than to browsers
  by more than 10 points after 25 iterations (the centring property).
