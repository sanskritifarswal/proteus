# Live content

Sources: [`src/content/`](../src/content/), the server's `--content` flag in
[`src/server.ts`](../src/server.ts), `content.example.json`.

The grammar's data contexts name five feeds (`Section.source`: topStories,
forYou, following, continueReading, saved). Until now they were filled with
the same twenty invented articles for everyone. That is right for the
gallery and the simulator and wrong for a real reader: nobody comes back
to invented news, so the return signal and the dwell calibration never
arrive. Live content fills the feeds from syndication feeds and fills the
personal ones from what each reader actually did.

## Running it

    cp content.example.json content.json      # edit the feed list
    npm run serve -- --content content.json   # plus --token etc. as before

The server fetches every feed once before listening, so the first screen is
real, then refreshes every `refreshMinutes` (default 30). The last good pool
is cached at `<store>/content.json`; a restart or an outage serves that. A
feed that fails keeps its previous articles and logs the error; only when
nothing was ever fetched and nothing is cached does the server refuse to
start.

Config:

```json
{
  "refreshMinutes": 30,
  "feeds": [
    "https://example.org/rss",
    { "url": "https://example.org/food/rss", "source": "Example", "topic": "Food" }
  ]
}
```

A bare URL takes its source name from the feed's own title and each
article's topic from its first `<category>` (falling back to the source
name). `source` and `topic` override both; set them, because feed titles are
things like "World news | The Guardian" and many feeds carry no categories.
`poolSize` (default 2000) bounds the articles kept across refreshes;
`perFeed` (default 40) bounds what one source contributes to Top Stories.

## What each feed contains

| source | contents |
|---|---|
| topStories | newest per source, round-robin across sources, so one prolific feed cannot own the section |
| forYou | the same pool ranked by the share of the reader's opens in each topic, newest first within a topic; newest first with no history |
| following | newest articles from sources the reader pressed Follow on |
| saved | articles the reader pressed Save on, latest save first |
| continueReading | articles opened and left before 90%, latest first; finishing one removes it |

An article the reader dismissed never comes back for them.

The pool after a refresh is exactly what the feeds list now, plus the
previous articles of any feed that failed this time, plus *pinned*
articles: ones some reader saved, followed from, or left unfinished. Pinned
articles are kept for those readers' Saved and Continue Reading lists but
are marked out of feed and never recommended again, so a retracted or
rotated-out story leaves Top Stories and For You at the next refresh.
Pins do not count against `poolSize`; `pinLimit` (default 1000) bounds
them, oldest pin first. Pins are persisted with the cache within a minute
of being made, and the server shows the provider every known reader's
history at start, so a restart does not lose them.

Pool identity is the article URL (the title when a feed gives none).
Events name an article by title, so a title resolves to the newest pooled
article carrying it, and a served list holds one card per title: two feeds
publishing one headline, or a headline reused a week later, cannot produce
two cards a reader's events could not tell apart.

A personal feed with nothing in it is served empty and the renderer shows
an empty state ("Nothing here yet."). It is not padded with
recommendations on purpose: a Saved section full of things the reader never
saved would teach the policy that the section pays for new users, which is
the opposite of the truth. The policy's `personalFeedLift` feature and the
open rate of those sections carry the real signal.

## The parser

Feeds are fetched with a 15 s timeout and a 5 MB byte cap, checked
against the declared length and again while streaming, so a feed that
answers with gigabytes fails on its own rather than taking the process
down.

RSS 2.0 and Atom, by regex, no dependencies. From each item: title, link
(Atom: `rel="alternate"` preferred), summary or description, full content
(`content:encoded` or Atom `content`), author (`dc:creator`, `author`, Atom
`name`), date (`pubDate`, `dc:date`, `published`, `updated`), categories,
and an image (`media:content`, `media:thumbnail`, an image `enclosure`, or
the first `<img>` in the content; otherwise a generated placeholder). HTML
is reduced to plain-text paragraphs once, at parse time: block boundaries
become paragraph breaks, tags go, entities decode, script and style blocks
are dropped. Nothing downstream handles markup; the reader inserts
paragraphs as text nodes. Items without a title are dropped.

The reader shows the article body the feed carried, which for most feeds is
a summary of one to six paragraphs, and links to the original in a new tab
("Read the original"). Read time is words at 220 a minute, never under one;
the relative time ("2h ago") is formatted per serve.

## What changes for the pipeline

- Article identity in events is still the title, so nothing in the
  collector, reward, or training changes.
- The policy's topic features (`topOpenShare`, `topicsOpened`) now look
  topics up in the live pool. A topic set from the config is as good as a
  category from the feed.
- `npm run compare -- --content out/server/content.json` simulates each real
  session on the cached pool, with the personal feeds as that reader would
  have had them from their earlier sessions. It is the current pool, not
  the one the screen was served from; Top Stories will have moved on.
- The simulator's archetypes hold topic preferences over the fake data's
  topic names (Local, Economy, Tech...). Against live content whose topics
  do not match those names, the simulated personal-feed ordering is
  unaffected but the archetypes' topic lift is not exercised. That is a
  calibration item, not a correctness one.
- `demo` and `gallery` still use the fake data.
- A reload races the beacon. The page posts its final record on `pagehide`
  and the browser may request the next screen before that record has been
  stored, in which case the next screen's personal feeds and state come
  from the previous snapshot and lag by one session. The store catches up
  when the beacon lands (the record with more events wins), so nothing is
  lost; a reader who closes the tab and comes back later never sees it.

## Checks (`npm run check` runs `src/check-content.ts`)

Offline, on fixtures: RSS and Atom parsing (CDATA, escaped HTML,
double-escaped entities, namespaced tags, link preference, image sources,
dates), HTML-to-paragraphs, the pool's five feeds for a new reader and for
one with opens, a save, a follow and a dismiss across two sessions, the
cache surviving a restart and a total outage, a refresh merging a changed
feed while a saved article outlives it, and the server serving a page with
the real title, body and link, whose posted session yields topic features
from the live pool.

Against the example config on 2026-09-16: 7 of 7 feeds, 185 articles, an
image and a date on every one, fetched in about two seconds.
