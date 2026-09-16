import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Article, FeedData } from '../fake-data.ts';
import { fakeData } from '../fake-data.ts';
import type { SessionRecord } from '../events.ts';
import { parseFeed } from './feed-parser.ts';

/**
 * Where the screen's content comes from. The grammar's data contexts name
 * five feeds (Section.source); a provider fills them for a given user. The
 * fake data fills them with the same twenty invented articles for
 * everyone, which is fine for the gallery and the simulator and useless
 * for a real reader across sessions. Live content fills them from
 * syndication feeds, and derives the personal feeds from what the user
 * actually did:
 *
 *   topStories       newest articles, round-robin across sources so one
 *                    prolific feed cannot own the section
 *   forYou           the pool ranked by the topics the user opened most,
 *                    newest first within a topic; newest first with no history
 *   following        newest articles from sources the user pressed Follow on
 *   saved            articles the user pressed Save on, latest save first
 *   continueReading  articles opened and left before the end, latest first
 *
 * Dismissed articles never come back for that user. A personal feed with
 * nothing in it is served empty and rendered as an empty state, not padded
 * with recommendations: a "Saved" section full of things the reader never
 * saved would teach the policy that the section is worth showing to new
 * users, which is the opposite of the truth.
 */
export interface ContentProvider {
  /** The five feeds and screen fields for one user, given their assembled sessions so far. */
  forUser(history: SessionRecord[]): FeedData;
  /** Topic of an article by title, for the policy's topic features. */
  topicOf(title: string): string | undefined;
  /** For the status page: what this provider is serving. */
  describe?(): { mode: 'fake' | 'live'; pool?: number; fetchedAt?: string | null; errors?: Record<string, string> };
}

/** The same data for everyone: the fake data, or any fixed FeedData. */
export function staticContent(data: FeedData = fakeData): ContentProvider {
  const topics = new Map<string, string>();
  for (const f of Object.values(data.feeds)) for (const a of f.articles) topics.set(a.title, a.topic);
  return { forUser: () => data, topicOf: (t) => topics.get(t), describe: () => ({ mode: 'fake' }) };
}

export interface FeedSpec {
  url: string;
  /** Display name of the source; default the feed's own title. */
  source?: string;
  /** Topic for every item of this feed; default the item's first category, then the source name. */
  topic?: string;
}

export interface ContentConfig {
  feeds: Array<string | FeedSpec>;
  /** How often to refetch, in minutes. Default 30. */
  refreshMinutes?: number;
  /** Articles kept in the pool, newest first. Default 2000. */
  poolSize?: number;
  /** Articles a reader acted on (saved, followed from, left unfinished) that are kept after their feed drops them. Default 1000. */
  pinLimit?: number;
  /** Items per feed to serve in topStories and forYou. Default 40. */
  perFeed?: number;
}

/** An article as kept in the pool: everything the renderer binds except the relative time, which is formatted per serve. */
export interface PooledArticle {
  title: string;
  dek: string;
  body: string;
  url?: string;
  source: string;
  author: string;
  published: number;
  topic: string;
  imageUrl: string;
  feedUrl: string;
  /** When this article was first seen, so unchanged items keep their order across refreshes. */
  seen: number;
  /** Still listed by its feed as of the last refresh. Only these are recommended; the rest are kept for readers who acted on them. */
  inFeed: boolean;
}

/** Pool identity: the url when the feed gives one, else the title. Events name articles by title; see `byTitle`. */
export function articleId(a: { url?: string; title: string }): string {
  return a.url ?? `title:${a.title}`;
}

export interface Snapshot {
  fetchedAt: number;
  articles: PooledArticle[];
  /** Titles readers have saved, followed from or left unfinished, newest pin last; kept in the pool across refreshes. */
  pinned?: string[];
}

export type FetchText = (url: string) => Promise<string>;

/**
 * A fetcher with a timeout, a byte cap and an identifying agent (some feeds
 * block anonymous clients). The cap matters: feeds are third-party input
 * read concurrently, and one that answers with gigabytes must fail, not
 * take the process down.
 */
export function makeHttpFetch(opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): FetchText {
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), headers: { 'user-agent': 'proteus/0.1 (+https://github.com/sanskritifarswal/proteus)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new Error(`response too large (${declared} bytes, cap ${maxBytes})`);
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`response too large (over ${maxBytes} bytes)`); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
}
export const httpFetch: FetchText = makeHttpFetch();

const PALETTE = ['#c9d6df', '#f0c9a0', '#b8d8be', '#e7b8c8', '#d6cbe7', '#f2e2a2', '#a9d1e0', '#e0b8a9'];
function placeholder(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = PALETTE[h % PALETTE.length], b = PALETTE[(h + 3) % PALETTE.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='400' height='300' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function relativeTime(published: number, now: number): string {
  const min = Math.max(0, Math.round((now - published) / 60_000));
  if (min < 60) return `${Math.max(1, min)}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d}d ago` : new Date(published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function readTime(body: string): string {
  const words = body.split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

export interface LiveContentOptions {
  config: ContentConfig;
  /** Where the last good snapshot is kept, so a restart or an outage serves what was last fetched. */
  cacheFile?: string;
  fetchText?: FetchText;
  now?: () => number;
  log?: (msg: string) => void;
}

/** What a user did with articles, from their sessions, oldest first. */
interface UserActions {
  dismissed: Set<string>;
  saved: string[];         // latest save last
  followedSources: Set<string>;
  unfinished: string[];    // opened, left before the end; latest last
  topicOpens: Map<string, number>;
}

export class LiveContent implements ContentProvider {
  private pool: PooledArticle[] = [];
  private byId = new Map<string, PooledArticle>();
  /**
   * Events name an article by title, so a title resolves to the newest
   * pooled article carrying it. Two feeds publishing one headline, or a
   * headline reused weeks later, therefore point at the latest; served
   * lists are deduplicated by title so a page never shows two cards a
   * reader's events could not tell apart.
   */
  private byTitle = new Map<string, PooledArticle>();
  /** Titles readers acted on, insertion-ordered oldest first; survive their feed dropping them, up to pinLimit. */
  private pinned = new Set<string>();
  /** Pins made since the cache was last written. */
  private dirty = false;
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly cfg: ContentConfig;
  private readonly specs: FeedSpec[];
  private readonly fetchText: FetchText;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly cacheFile?: string;
  /** Last error per feed url, cleared on success. */
  readonly errors = new Map<string, string>();

  constructor(opts: LiveContentOptions) {
    this.cfg = opts.config;
    if (!Array.isArray(opts.config.feeds) || opts.config.feeds.length === 0) throw new Error('content config needs a non-empty "feeds" list');
    this.specs = opts.config.feeds.map((f) => (typeof f === 'string' ? { url: f } : f));
    for (const s of this.specs) if (!/^https?:\/\//.test(s.url)) throw new Error(`feed url must be http(s): ${s.url}`);
    this.fetchText = opts.fetchText ?? httpFetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.cacheFile = opts.cacheFile;
    if (this.cacheFile && existsSync(this.cacheFile)) {
      try {
        const snap = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Snapshot;
        for (const t of snap.pinned ?? []) this.pinned.add(t);
        this.setPool(snap.articles.map((a) => ({ ...a, inFeed: a.inFeed ?? true })), snap.fetchedAt);
        this.log(`content: loaded ${snap.articles.length} cached article(s)`);
      } catch (e) { this.log(`content: ignoring unreadable cache ${this.cacheFile}: ${(e as Error).message}`); }
    }
  }

  get size(): number { return this.pool.length; }
  get lastFetched(): number { return this.fetchedAt; }

  private setPool(articles: PooledArticle[], fetchedAt: number): void {
    const limit = this.cfg.poolSize ?? 2000;
    const sorted = [...articles].sort((a, b) => b.published - a.published || b.seen - a.seen);
    // Pinned articles do not count against the limit, so a saved article cannot be pushed out by news volume.
    const keep = sorted.filter((a) => this.pinned.has(a.title));
    const rest = sorted.filter((a) => !this.pinned.has(a.title)).slice(0, limit);
    this.pool = [...keep, ...rest].sort((a, b) => b.published - a.published || b.seen - a.seen);
    this.byId = new Map(this.pool.map((a) => [articleId(a), a]));
    // Newest wins per title: iterate oldest to newest and let later entries overwrite.
    this.byTitle = new Map();
    for (let i = this.pool.length - 1; i >= 0; i--) this.byTitle.set(this.pool[i].title, this.pool[i]);
    this.fetchedAt = fetchedAt;
  }

  private pin(title: string): void {
    // Re-pinning moves the title to the newest end, and that order decides
    // eviction, so it must reach the cache like a new pin does.
    this.pinned.delete(title);
    this.pinned.add(title);
    this.dirty = true;
    const limit = this.cfg.pinLimit ?? 1000;
    while (this.pinned.size > limit) this.pinned.delete(this.pinned.values().next().value!);
  }

  /** Write the cache now if pins changed since it was last written. */
  flush(): void { if (this.dirty) this.writeCache(); }

  private writeCache(): void {
    this.dirty = false;
    if (!this.cacheFile) return;
    mkdirSync(dirname(this.cacheFile), { recursive: true });
    // Write beside, then rename: a crash mid-write must not leave the only fallback truncated.
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, articles: this.pool, pinned: [...this.pinned] } satisfies Snapshot));
    renameSync(tmp, this.cacheFile);
  }

  /**
   * Fetch every feed once. After a refresh the pool holds: what the feeds
   * list now; the previous articles of any feed that failed this time;
   * and pinned articles (ones readers saved, followed from or left
   * unfinished), which are kept but marked out of feed so they are no
   * longer recommended. Everything else is dropped, so a retracted or
   * rotated-out article leaves Top Stories and For You on the next
   * refresh. Only when every feed fails and nothing was ever loaded does
   * this throw. Returns the number of new articles.
   */
  async refresh(): Promise<number> {
    const now = this.now();
    const results = await Promise.allSettled(this.specs.map(async (spec) => ({ spec, feed: parseFeed(await this.fetchText(spec.url)) })));
    const fresh = new Map<string, PooledArticle>();
    const failed = new Set<string>();
    let okCount = 0;
    results.forEach((r, i) => {
      const spec = this.specs[i];
      if (r.status === 'rejected') { failed.add(spec.url); this.errors.set(spec.url, String((r.reason as Error)?.message ?? r.reason)); this.log(`content: ${spec.url}: ${this.errors.get(spec.url)}`); return; }
      okCount++;
      this.errors.delete(spec.url);
      const { feed } = r.value;
      const source = spec.source ?? feed.title ?? new URL(spec.url).hostname;
      for (const it of feed.items) {
        const id = articleId(it);
        if (fresh.has(id)) continue;
        const prev = this.byId.get(id);
        fresh.set(id, {
          title: it.title, dek: it.dek, body: it.body, url: it.url, source, author: it.author ?? source,
          published: it.published ?? prev?.published ?? now,
          topic: spec.topic ?? it.categories[0] ?? source,
          imageUrl: it.imageUrl ?? placeholder(it.title),
          feedUrl: spec.url, seen: prev?.seen ?? now, inFeed: true,
        });
      }
    });
    if (okCount === 0) {
      if (this.pool.length) { this.log('content: every feed failed; serving the previous snapshot'); return 0; }
      throw new Error(`no feed could be fetched: ${[...this.errors].map(([u, e]) => `${u}: ${e}`).join('; ')}`);
    }
    let added = 0;
    for (const id of fresh.keys()) if (!this.byId.has(id)) added++;
    const merged = new Map<string, PooledArticle>();
    for (const a of this.pool) {
      if (failed.has(a.feedUrl)) merged.set(articleId(a), a);
      else if (this.pinned.has(a.title)) merged.set(articleId(a), { ...a, inFeed: false });
    }
    for (const [id, a] of fresh) merged.set(id, a);
    this.setPool([...merged.values()], now);
    this.writeCache();
    this.log(`content: ${okCount}/${this.specs.length} feed(s), ${added} new, ${this.pool.length} in pool`);
    return added;
  }

  /** Refresh on an interval, and persist new pins within a minute. The timers never keep the process alive. */
  start(): void {
    const ms = (this.cfg.refreshMinutes ?? 30) * 60_000;
    if (ms > 0) {
      this.timer = setInterval(() => { this.refresh().catch((e) => this.log(`content: refresh failed: ${(e as Error).message}`)); }, ms);
      this.timer.unref();
    }
    this.flushTimer = setInterval(() => this.flush(), 60_000);
    this.flushTimer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.timer = this.flushTimer = undefined;
    this.flush();
  }

  topicOf(title: string): string | undefined { return this.byTitle.get(title)?.topic; }

  describe(): { mode: 'live'; pool: number; fetchedAt: string | null; errors: Record<string, string> } {
    return { mode: 'live', pool: this.pool.length, fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null, errors: Object.fromEntries(this.errors) };
  }

  private actionsOf(history: SessionRecord[]): UserActions {
    const acts: UserActions = { dismissed: new Set(), saved: [], followedSources: new Set(), unfinished: [], topicOpens: new Map() };
    for (const s of history) {
      const completion = new Map<string, number>();
      const opened: string[] = [];
      for (const e of s.events) {
        switch (e.type) {
          case 'open': opened.push(e.article); if (!completion.has(e.article)) completion.set(e.article, 0); break;
          case 'complete': completion.set(e.article, Math.max(completion.get(e.article) ?? 0, e.value)); break;
          case 'action':
            if (e.action === 'dismiss' && e.article) acts.dismissed.add(e.article);
            if (e.action === 'save' && e.article) { acts.saved = acts.saved.filter((t) => t !== e.article); acts.saved.push(e.article); this.pin(e.article); }
            if (e.action === 'follow' && e.article) { const src = this.byTitle.get(e.article)?.source; if (src) acts.followedSources.add(src); this.pin(e.article); }
            break;
        }
      }
      for (const t of opened) {
        const topic = this.byTitle.get(t)?.topic;
        if (topic) acts.topicOpens.set(topic, (acts.topicOpens.get(topic) ?? 0) + 1);
        acts.unfinished = acts.unfinished.filter((u) => u !== t);
        if ((completion.get(t) ?? 0) < 0.9) { acts.unfinished.push(t); this.pin(t); }
      }
    }
    return acts;
  }

  private materialise(a: PooledArticle, now: number): Article {
    return { title: a.title, dek: a.dek, body: a.body, url: a.url, source: a.source, author: a.author, publishedAt: relativeTime(a.published, now), readTime: readTime(a.body), topic: a.topic, imageUrl: a.imageUrl };
  }

  forUser(history: SessionRecord[]): FeedData {
    const now = this.now();
    const acts = this.actionsOf(history);
    // Recommendations come from what the feeds list now, one card per title.
    const titles = new Set<string>();
    const live = this.pool.filter((a) => a.inFeed && !acts.dismissed.has(a.title) && this.byTitle.get(a.title) === a && !titles.has(a.title) && titles.add(a.title));
    const perFeed = this.cfg.perFeed ?? 40;

    // Newest per source, then round-robin across sources.
    const bySource = new Map<string, PooledArticle[]>();
    for (const a of live) { const l = bySource.get(a.source) ?? []; if (l.length < perFeed) l.push(a); bySource.set(a.source, l); }
    const top: PooledArticle[] = [];
    const lists = [...bySource.values()];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) top.push(l[i]);

    const totalOpens = [...acts.topicOpens.values()].reduce((s, n) => s + n, 0);
    const affinity = (a: PooledArticle) => (totalOpens ? (acts.topicOpens.get(a.topic) ?? 0) / totalOpens : 0);
    const forYou = [...top].sort((a, b) => affinity(b) - affinity(a) || b.published - a.published);

    const following = live.filter((a) => acts.followedSources.has(a.source));
    const pick = (titles: string[]) => titles.slice().reverse().map((t) => this.byTitle.get(t)).filter((a): a is PooledArticle => !!a && !acts.dismissed.has(a.title));
    const saved = pick(acts.saved);
    const continueReading = pick(acts.unfinished);

    const hour = new Date(now).getHours();
    const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const m = (list: PooledArticle[]) => list.map((a) => this.materialise(a, now));
    return {
      screen: { greeting, todayDate: new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) },
      feeds: {
        topStories: { name: 'Top Stories', articles: m(top) },
        forYou: { name: 'For You', articles: m(forYou) },
        following: { name: 'Following', articles: m(following) },
        saved: { name: 'Saved', articles: m(saved) },
        continueReading: { name: 'Continue Reading', articles: m(continueReading) },
      },
      strings: { ...fakeData.strings },
      actionLabels: { ...fakeData.actionLabels },
    };
  }
}

export function loadContentConfig(file: string): ContentConfig {
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as ContentConfig;
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.feeds)) throw new Error(`${file}: expected {"feeds": [url, ...]}`);
  return cfg;
}
