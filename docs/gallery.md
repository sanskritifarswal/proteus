# Gallery: looking at what the grammar produces

Source: [`src/gallery.ts`](../src/gallery.ts), [`src/render-html.ts`](../src/render-html.ts).
Run `npm run gallery -- --seed 1 --n 20` and open `gallery/index.html`.

Validating hand-written examples proves the grammar accepts good layouts.
The gallery proves whether it rejects bad ones: sample trees at random,
render them with fake content, and list everything a designer would never
ship. Each item becomes a constraint, the grammar version bumps, and the
gallery is re-run. This is the same loop the RL policy will run later with a
reward instead of a designer.

The renderer is deliberately plain. It knows the newsfeed grammar's
components and is not a general renderer. Every element carries its tree
path in `data-path`, which is the identity reward attribution keys on.

## Findings from seed 1, 20 samples, local policy (grammar 0.2.0)

Ranked by how often they appeared and how bad they look.

1. **Section headings disagree with their feed.** "Saved" headed *For You*,
   "Following" headed *Home*, "For You" headed *Top Stories*. Nearly every
   sample with headings had at least one. Two causes: heading keys are not
   tied to `source`, and `header.*` keys are usable in section headings.
   Fix: section headings bind `feed.name` only; drop the `section.*` string
   keys. Header titles keep `header.*` keys or screen bindings.
2. **Duplicate sections.** Two "Top Stories" or two "For You" sections on
   one screen (samples 2, 6). `distinct` on `Screen.sections` would not help:
   the two sections differ in layout. Fix: distinct by `source`.
3. **Duplicate meta fields.** *Local · Local*, when a caption and a label
   both bind `topic`. Same root cause: `distinct` compares whole nodes, and
   the nodes differ in `role`. Fix: distinct by `bind` on `Card.meta`.
4. **Hero cards with square images** look like thumbnails that grew. Fix:
   hero requires `16:9` or `4:3`.
5. **Multi-line section headings.** Fix: heading `maxLines` is `1`.
6. **Two duplicate action buttons** are already impossible by node
   identity, but *Save* twice with different styles is not. Fix: distinct by
   `action` on `Card.actions`.

Needed in the meta-model: a slot-level `distinctBy` naming a prop or
`bind`, compiled to JSON Schema as a `not` over each pair of positions
(array slots are small, so pairs are few), and honoured by the sampler and
counter.

Things that looked odd but are taste, not grammar: a *Read* button on every
compact row when tapping already opens the article; the date as a header
title. Left alone.
