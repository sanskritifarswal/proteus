import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseFeed, htmlToParagraphs, decodeEntities, truncate } from './content/feed-parser.ts';
import { LiveContent, readTime, relativeTime, staticContent } from './content/content.ts';
import { createServer } from './server.ts';
import { renderDocument } from './render-html.ts';
import { createRecorder } from './client/recorder.ts';
import type { SessionRecord } from './events.ts';
import type { UIDocument, UINode } from './tree.ts';

/**
 * Live content, offline: the RSS and Atom parsers on fixtures, the pool's
 * personal feeds derived from a user's actions, the cache surviving a
 * restart and an outage, and the server serving a real article with its
 * body and link. No network is touched.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>The Ledger</title>
  <link>https://ledger.example</link>
  <item>
    <title><![CDATA[Council approves bike lanes & more]]></title>
    <link>https://ledger.example/bike-lanes</link>
    <description>&lt;p&gt;The plan adds 40 miles of &lt;b&gt;protected&lt;/b&gt; lanes.&lt;/p&gt;</description>
    <content:encoded><![CDATA[<p>The plan adds 40 miles of protected lanes.</p><script>alert(1)</script><p>Funded by a parking surcharge &amp; a grant.</p><p>Work starts in spring.</p>]]></content:encoded>
    <dc:creator>M. Okafor</dc:creator>
    <pubDate>Tue, 15 Sep 2026 08:00:00 GMT</pubDate>
    <category>Local</category>
    <category>Transport</category>
    <media:content url="https://ledger.example/bike.jpg" medium="image" width="800"/>
    <media:title>ignored</media:title>
  </item>
  <item>
    <title>Housing market stalls</title>
    <link>https://ledger.example/housing</link>
    <description><![CDATA[Rates, inventory and a wait-and-see mood among sellers froze listings.<br>More below.]]></description>
    <pubDate>Tue, 15 Sep 2026 06:00:00 GMT</pubDate>
    <category>Economy</category>
    <enclosure url="https://ledger.example/housing.png" type="image/png" length="1"/>
  </item>
  <item>
    <link>https://ledger.example/no-title</link>
    <description>An item without a title is skipped.</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Wired Notes</title>
  <link href="https://wired.example/"/>
  <entry>
    <title>Open-source maps eat the industry</title>
    <link rel="alternate" type="text/html" href="https://wired.example/maps"/>
    <link rel="enclosure" href="https://wired.example/maps.mp3"/>
    <summary type="html">Delivery apps &amp;amp; car makers build on the same data.</summary>
    <content type="html">&lt;div&gt;&lt;p&gt;Delivery apps and car makers build on the same data.&lt;/p&gt;&lt;p&gt;City planners too.&lt;/p&gt;&lt;img src="https://wired.example/maps.jpg"&gt;&lt;/div&gt;</content>
    <author><name>R. Chen</name></author>
    <published>2026-09-15T07:30:00Z</published>
    <category term="Tech"/>
  </entry>
  <entry>
    <title>Why your sleep tracker is wrong</title>
    <link href="https://wired.example/sleep"/>
    <summary>Wrist sensors guess at sleep stages.</summary>
    <updated>2026-09-14T20:00:00Z</updated>
  </entry>
</feed>`;

// --- Parsers ---
{
  const rss = parseFeed(RSS);
  report(rss.title === 'The Ledger' && rss.items.length === 2, `RSS: channel title and ${rss.items.length} items; the titleless item is dropped`);
  const a = rss.items[0];
  report(a.title === 'Council approves bike lanes & more', `RSS: CDATA title unwrapped (${a.title})`);
  report(a.url === 'https://ledger.example/bike-lanes' && a.author === 'M. Okafor', 'RSS: link and dc:creator');
  report(a.body === 'The plan adds 40 miles of protected lanes.\n\nFunded by a parking surcharge & a grant.\n\nWork starts in spring.', 'RSS: content:encoded becomes paragraphs, script dropped, entities decoded');
  report(a.dek === 'The plan adds 40 miles of protected lanes.', `RSS: dek is the first paragraph of the escaped description with tags stripped (${a.dek})`);
  report(a.published === Date.parse('Tue, 15 Sep 2026 08:00:00 GMT'), 'RSS: pubDate parsed');
  report(a.categories.join(',') === 'Local,Transport' && a.imageUrl === 'https://ledger.example/bike.jpg', 'RSS: categories and media:content image');
  const b = rss.items[1];
  report(b.body === 'Rates, inventory and a wait-and-see mood among sellers froze listings.\n\nMore below.' && b.imageUrl === 'https://ledger.example/housing.png', 'RSS: description-only item: body from description, <br> splits, enclosure image');
  const atom = parseFeed(ATOM);
  report(atom.title === 'Wired Notes' && atom.items.length === 2, 'Atom: feed title and entries');
  const c = atom.items[0];
  report(c.url === 'https://wired.example/maps', `Atom: rel=alternate link preferred over enclosure (${c.url})`);
  report(c.body === 'Delivery apps and car makers build on the same data.\n\nCity planners too.' && c.dek === 'Delivery apps & car makers build on the same data.', 'Atom: escaped html content to paragraphs; summary double-escaped entity decoded');
  report(c.author === 'R. Chen' && c.categories[0] === 'Tech' && c.imageUrl === 'https://wired.example/maps.jpg' && c.published === Date.parse('2026-09-15T07:30:00Z'), 'Atom: author name, category term, first img in content, published');
  report(atom.items[1].url === 'https://wired.example/sleep' && atom.items[1].published === Date.parse('2026-09-14T20:00:00Z'), 'Atom: bare link href and updated as fallback date');
  report(htmlToParagraphs('<style>p{}</style><h2>A &amp; B</h2><ul><li>one</li><li>two</li></ul>text  with   spaces').join('|') === 'A & B|one|two|text with spaces', 'htmlToParagraphs: style dropped, blocks split, whitespace collapsed');
  report(decodeEntities('&#x27;x&#39; &rsquo;&unknown;') === "'x' ’&unknown;", 'decodeEntities: hex, decimal, named; unknown left alone');
  const long = 'word '.repeat(60).trim();
  report(truncate(long, 50).length <= 51 && truncate(long, 50).endsWith('…') && truncate('short', 50) === 'short', 'truncate cuts at a word with an ellipsis');
  report(readTime('w '.repeat(660)) === '3 min read' && readTime('one two') === '1 min read', 'readTime: 220 words a minute, never under one');
  const now = Date.parse('2026-09-15T10:00:00Z');
  report(relativeTime(now - 5 * 60_000, now) === '5m ago' && relativeTime(now - 3 * 3_600_000, now) === '3h ago' && relativeTime(now - 2 * 86_400_000, now) === '2d ago', 'relativeTime: minutes, hours, days');
}

// --- Pool and personal feeds ---
const dir = mkdtempSync(join(tmpdir(), 'proteus-content-'));
const cache = join(dir, 'content.json');
const NOW = Date.parse('2026-09-15T10:00:00Z');
const fetches: string[] = [];
const fetchOk = async (url: string) => { fetches.push(url); if (url.includes('ledger')) return RSS; if (url.includes('wired')) return ATOM; throw new Error('404 Not Found'); };
const config = { feeds: ['https://ledger.example/rss', { url: 'https://wired.example/atom', source: 'Wired' }, 'https://down.example/rss'] };

const session = (user: string, n: number, script: (rec: ReturnType<typeof createRecorder>) => void): SessionRecord => {
  let clock = 0;
  const rec = createRecorder({ user, session: n, grammar: 'newsfeed@0.3.0', tree: { type: 'Screen', props: { density: 'compact' }, slots: { sections: [{ type: 'Section', props: { source: 'topStories' }, slots: { content: { type: 'Collection', props: { layout: 'stack', limit: '5' }, slots: { item: { type: 'Card', props: { variant: 'compact' }, slots: { title: { type: 'Text', props: { role: 'title', maxLines: '2' }, bind: 'title' }, actions: [{ type: 'Button', props: { action: 'save', style: 'ghost' } }] } } } } } }] } }, now: () => (clock += 1000) });
  script(rec);
  rec.end();
  return { ...rec.record(), tree: rec.record().tree as UINode, returned: null };
};
const P = 'sections[0].content.item';
const BTN = 'sections[0].content.item.actions[0]';

{
  const live = new LiveContent({ config, cacheFile: cache, fetchText: fetchOk, now: () => NOW });
  const added = await live.refresh();
  report(added === 4 && live.size === 4 && live.errors.get('https://down.example/rss') === '404 Not Found', `refresh: ${added} articles from the two feeds that answered; the failing feed is recorded (${live.errors.get('https://down.example/rss')})`);
  report(live.topicOf('Council approves bike lanes & more') === 'Local' && live.topicOf('Why your sleep tracker is wrong') === 'Wired', 'topicOf: first category, else the source name (config source overrides the feed title)');

  const fresh = live.forUser([]);
  const titles = (f: string) => fresh.feeds[f].articles.map((a) => a.title);
  report(titles('topStories').join('|') === 'Council approves bike lanes & more|Open-source maps eat the industry|Housing market stalls|Why your sleep tracker is wrong', `topStories: newest per source, round-robin across sources`);
  report(titles('forYou').join('|') === titles('topStories').join('|'), 'forYou with no history: same order as top stories');
  report(titles('following').length === 0 && titles('saved').length === 0 && titles('continueReading').length === 0, 'personal feeds are empty for a new user');
  const a0 = fresh.feeds.topStories.articles[0];
  report(a0.publishedAt === '2h ago' && a0.readTime === '1 min read' && a0.source === 'The Ledger' && a0.url === 'https://ledger.example/bike-lanes' && (a0.body ?? '').includes('\n\n'), 'materialised article: relative time, read time, source, url, multi-paragraph body');
  report(fresh.screen.greeting === 'Good morning' || fresh.screen.greeting === 'Good afternoon' || fresh.screen.greeting === 'Good evening' || fresh.screen.greeting === 'Good night', `screen greeting from the hour (${fresh.screen.greeting})`);
  report(fresh.feeds.topStories.articles.every((a) => a.imageUrl.startsWith('http') || a.imageUrl.startsWith('data:image/svg')), 'every article has an image url or a placeholder');

  // A history: opened two Tech articles (one unfinished), saved one, followed Wired, dismissed one.
  const history = [
    session('u', 0, (rec) => {
      rec.impression(P, 'Open-source maps eat the industry'); rec.open(P, 'Open-source maps eat the industry'); rec.close(0.3);
      rec.impression(P, 'Why your sleep tracker is wrong'); rec.open(P, 'Why your sleep tracker is wrong'); rec.close(1);
      rec.action(BTN, 'save', 'Housing market stalls');
      rec.action(BTN, 'follow', 'Why your sleep tracker is wrong');
      rec.action(BTN, 'dismiss', 'Council approves bike lanes & more');
    }),
  ];
  const mine = live.forUser(history);
  const t = (f: string) => mine.feeds[f].articles.map((a) => a.title);
  report(!t('topStories').includes('Council approves bike lanes & more') && !t('forYou').includes('Council approves bike lanes & more'), 'dismissed article is gone from every feed');
  report(t('forYou')[0] === 'Open-source maps eat the industry' && t('forYou')[1] === 'Why your sleep tracker is wrong', `forYou ranks the opened topics first (${t('forYou').join(' | ')})`);
  report(t('saved').join('|') === 'Housing market stalls', 'saved: the article the user saved');
  report(t('following').join('|') === 'Open-source maps eat the industry|Why your sleep tracker is wrong', 'following: newest from the followed source');
  report(t('continueReading').join('|') === 'Open-source maps eat the industry', 'continueReading: opened and left at 30%, not the one read to the end');
  const later = [...history, session('u', 1, (rec) => { rec.impression(P, 'Open-source maps eat the industry'); rec.open(P, 'Open-source maps eat the industry'); rec.close(0.95); rec.action(BTN, 'save', 'Open-source maps eat the industry'); })];
  const m2 = live.forUser(later);
  report(m2.feeds.continueReading.articles.length === 0 && m2.feeds.saved.articles.map((a) => a.title).join('|') === 'Open-source maps eat the industry|Housing market stalls', 'finishing an article removes it from continueReading; a later save comes first');

  // Cache: a restart with every feed down serves the snapshot; a refresh that fails everywhere keeps it.
  report(existsSync(cache), 'refresh wrote the cache');
  const restarted = new LiveContent({ config, cacheFile: cache, fetchText: async () => { throw new Error('offline'); }, now: () => NOW });
  report(restarted.size === 4, 'a restart loads the cached pool before any fetch');
  const added2 = await restarted.refresh();
  report(added2 === 0 && restarted.size === 4 && restarted.errors.size === 3, 'every feed failing keeps the previous pool and records the errors');
  let threw = '';
  try { await new LiveContent({ config, fetchText: async () => { throw new Error('offline'); } }).refresh(); } catch (e) { threw = (e as Error).message; }
  report(threw.startsWith('no feed could be fetched'), `with nothing cached and nothing fetched, refresh throws (${threw.slice(0, 40)}…)`);

  // A changed feed: the saved item drops out of its feed but stays in the pool
  // (pinned) without being recommended; an unpinned dropped item goes; a new
  // item is added. Pins made since the last refresh reach the cache via flush.
  live.flush();
  report((JSON.parse(readFileSync(cache, 'utf8')) as { pinned: string[] }).pinned.includes('Housing market stalls'), 'flush persists the pins a reader created since the last refresh');
  const rss2 = RSS
    .replace(/<item>\s*<title>Housing market stalls[\s\S]*?<\/item>/, '<item><title>Transit cards go contactless</title><link>https://ledger.example/transit</link><description>Tap to ride.</description><pubDate>Tue, 15 Sep 2026 09:30:00 GMT</pubDate></item>')
    .replace(/<item>\s*<title><!\[CDATA\[Council approves[\s\S]*?<\/item>/, '');
  const live2 = new LiveContent({ config, cacheFile: cache, fetchText: async (u) => (u.includes('ledger') ? rss2 : fetchOk(u)), now: () => NOW + 60_000 });
  const added3 = await live2.refresh();
  const after = live2.forUser(history);
  const topAfter = after.feeds.topStories.articles.map((a) => a.title);
  report(added3 === 1 && live2.size === 4 && after.feeds.saved.articles[0]?.title === 'Housing market stalls' && topAfter[0] === 'Transit cards go contactless' && !topAfter.includes('Housing market stalls') && live2.topicOf('Council approves bike lanes & more') === undefined, `refresh: the new item leads; the saved item outlives its feed but is no longer recommended; the unpinned dropped item is gone (pool ${live2.size})`);
  const snap = JSON.parse(readFileSync(cache, 'utf8')) as { articles: unknown[] };
  report(snap.articles.length === 4 && !existsSync(`${cache}.${process.pid}.tmp`), 'the cache holds the new pool and was written atomically');

  // Titles are not unique across feeds or time: one card per title, resolving to the newest.
  const dupAtom = ATOM.replace('<title>Why your sleep tracker is wrong</title>', '<title>Housing market stalls</title>').replace('2026-09-14T20:00:00Z', '2026-09-15T09:00:00Z');
  const dup = new LiveContent({ config, fetchText: async (u) => (u.includes('ledger') ? RSS : dupAtom), now: () => NOW });
  await dup.refresh();
  const dupTop = dup.forUser([]).feeds.topStories.articles.filter((a) => a.title === 'Housing market stalls');
  report(dup.size === 4 && dupTop.length === 1 && dupTop[0].source === 'Wired' && dup.topicOf('Housing market stalls') === 'Wired', `two feeds with one headline: both pooled (${dup.size}), served once, resolving to the newer (${dupTop[0]?.source})`);

  // The fetcher refuses oversized bodies, declared or streamed.
  const { makeHttpFetch } = await import('./content/content.ts');
  const bigDeclared = makeHttpFetch({ maxBytes: 100, fetchImpl: (async () => new Response('x', { headers: { 'content-length': '1000' } })) as unknown as typeof fetch });
  const bigStreamed = makeHttpFetch({ maxBytes: 100, fetchImpl: (async () => new Response('y'.repeat(1000))) as unknown as typeof fetch });
  const small = makeHttpFetch({ maxBytes: 100, fetchImpl: (async () => new Response('<rss/>')) as unknown as typeof fetch });
  const msgOf = async (f: () => Promise<string>) => { try { await f(); return ''; } catch (e) { return (e as Error).message; } };
  report((await msgOf(() => bigDeclared('u'))).includes('too large') && (await msgOf(() => bigStreamed('u'))).includes('too large') && (await small('u')) === '<rss/>', 'fetcher: bodies over the byte cap are refused by declared length and while streaming; small ones pass');
  report((() => { try { new LiveContent({ config: { feeds: [] } }); return false; } catch { return true; } })() && (() => { try { new LiveContent({ config: { feeds: ['ftp://x'] } }); return false; } catch { return true; } })(), 'config validation: feeds required, http(s) only');
}

// --- Renderer and server with live content ---
{
  const live = new LiveContent({ config, cacheFile: cache, fetchText: fetchOk, now: () => NOW });
  await live.refresh();
  const doc: UIDocument = { grammar: 'newsfeed@0.3.0', tree: { type: 'Screen', props: { density: 'comfortable' }, slots: { sections: [
    { type: 'Section', props: { source: 'topStories' }, slots: { content: { type: 'Collection', props: { layout: 'stack', limit: '3' }, slots: { item: { type: 'Card', props: { variant: 'standard' }, slots: { title: { type: 'Text', props: { role: 'title', maxLines: '2' }, bind: 'title' }, meta: [{ type: 'Text', props: { role: 'caption', maxLines: '1' }, bind: 'publishedAt' }] } } } } } },
    { type: 'Section', props: { source: 'saved' }, slots: { heading: { type: 'Text', props: { role: 'title', maxLines: '1' }, bind: 'name' }, content: { type: 'Collection', props: { layout: 'stack', limit: '3' }, slots: { item: { type: 'Card', props: { variant: 'compact' }, slots: { title: { type: 'Text', props: { role: 'title', maxLines: '2' }, bind: 'title' } } } } } } },
  ] } } };
  const html = renderDocument(doc, live.forUser([]));
  report(html.includes('data-article="Council approves bike lanes &amp; more"') && html.includes('data-url="https://ledger.example/bike-lanes"') && html.includes('Funded by a parking surcharge &amp; a grant.'), 'renderer: card carries the real title, url and body');
  report(html.includes('<p class="empty">Nothing here yet.</p>') && html.includes('>Saved</p>'), 'renderer: an empty personal feed shows its heading and an empty state');
  report(html.includes('>2h ago</p>'), 'renderer: relative time binds like any article field');

  const server = createServer({ store: join(dir, 'store'), policy: doc, content: live });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await (await fetch(`${base}/u/alice`)).text();
    report(page.includes('data-url="https://ledger.example/bike-lanes"') && page.includes('Read the original'), 'server: /u/alice is rendered from live content and the reader links to the original');
    const tree = JSON.parse(/<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(page)![1].replace(/\\u003c/g, '<'));
    let clock = 0;
    const rec = createRecorder({ user: 'alice', session: 0, grammar: 'newsfeed@0.3.0', tree, now: () => (clock += 1000) });
    rec.impression('sections[0].content.item', 'Open-source maps eat the industry');
    rec.open('sections[0].content.item', 'Open-source maps eat the industry'); rec.close(1);
    rec.end();
    const r = await fetch(`${base}/events`, { method: 'POST', body: JSON.stringify(rec.record()) });
    const posted = await r.json() as { ok: boolean; errors?: string[] };
    report(r.status === 200 && posted.ok, `server: a session on live content is accepted${posted.errors ? ` (${posted.errors.join('; ')})` : ''}`);
    const sres = await fetch(`${base}/sessions/alice`);
    const s = await sres.json() as { nextState: Record<string, number>; errors?: string[] };
    if (!s.nextState) console.log('  /sessions/alice ->', sres.status, JSON.stringify(s).slice(0, 300));
    report(s.nextState.topOpenShare === 1 && s.nextState.topicsOpened > 0, `server: topic features come from the live pool (topOpenShare ${s.nextState.topOpenShare}, topicsOpened ${s.nextState.topicsOpened})`);
    const page2 = await (await fetch(`${base}/u/alice`)).text();
    report(page2.includes('data-source="topStories"'), 'server: the next screen renders for a user with history');
  } finally { await new Promise<void>((r) => server.close(() => r())); }

  const fake = staticContent();
  report(fake.forUser([]).feeds.topStories.articles.length === 10 && fake.topicOf('City council approves new bike lane network') === 'Local', 'staticContent: the fake data through the same interface');
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} content check(s) failed` : '\nall content checks passed');
process.exit(failures ? 1 : 0);
