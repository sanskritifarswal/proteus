import type { UINode } from '../tree.ts';
import type { UIEvent, UIEventInput, SessionRecord } from '../events.ts';
import type { Article, FeedData } from '../fake-data.ts';
import type { Rng } from '../rng.ts';
import type { SimUser } from './users.ts';

/**
 * Simulate one session of one user on one tree.
 *
 * Walks the tree in render order (same path rule as the renderer), decides
 * for each shown article whether the user sees it, opens it, how much they
 * read, and which of the card's *available* buttons they use. Availability
 * matters: a user can only dismiss an article if the derivation put a
 * dismiss button on that card, which is exactly the kind of thing the
 * policy is supposed to learn.
 *
 * At the end, satisfaction with the session sets the probability of
 * returning, which is where retention enters the reward.
 */
export interface SimState {
  /** Article titles opened in earlier sessions; re-showing them is less interesting. */
  seen: Set<string>;
  sessionsSoFar: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Feeds the user built themselves. They are filled with articles on topics
 * the user likes (that is what following or saving means) and get a small
 * boost on top for already being chosen. A flat boost on undifferentiated
 * content would make any tree that merely covers these sections win.
 */
const PERSONAL_SOURCES = new Set(['following', 'saved', 'continueReading']);
const SOURCE_BOOST: Record<string, number> = { following: 0.15, saved: 0.25, continueReading: 0.2 };

function feedFor(user: SimUser, source: string, data: FeedData): Article[] {
  const all = data.feeds[source].articles;
  if (!PERSONAL_SOURCES.has(source)) return all;
  const liked = all.filter((a) => (user.topics[a.topic] ?? 0) > 0.1);
  const rest = all.filter((a) => (user.topics[a.topic] ?? 0) <= 0.1);
  return [...liked, ...rest];
}

interface Exposure {
  path: string;
  card: UINode;
  articleIdx: number;
  source: string;
  layout: string;
  positionInSection: number;
  section: number;
}

/** Everything the user could see, in the order they'd scroll past it. */
function exposures(user: SimUser, tree: UINode, data: FeedData): { list: Exposure[]; footers: Array<{ path: string; source: string; action: string; section: number }> } {
  const list: Exposure[] = [];
  const footers: Array<{ path: string; source: string; action: string; section: number }> = [];
  const sections = (tree.slots?.sections as UINode[]) ?? [];
  sections.forEach((sec, si) => {
    const source = sec.props!.source;
    const coll = sec.slots!.content as UINode;
    const limit = Number(coll.props!.limit);
    const lead = coll.slots?.lead as UINode | undefined;
    const item = coll.slots!.item as UINode;
    const base = `sections[${si}].content`;
    const n = Math.min(limit, feedFor(user, source, data).length);
    for (let i = 0; i < n; i++) {
      const useLead = i === 0 && !!lead;
      list.push({
        path: useLead ? `${base}.lead` : `${base}.item`,
        card: useLead ? lead! : item,
        articleIdx: i, source, layout: coll.props!.layout, positionInSection: i, section: si,
      });
    }
    const footer = sec.slots?.footer as UINode | undefined;
    if (footer) footers.push({ path: `sections[${si}].footer`, source, action: footer.props!.action, section: si });
  });
  return { list, footers };
}

function topicAffinity(user: SimUser, topic: string): number {
  return user.topics[topic] ?? 0;
}

function visualScore(card: UINode): number {
  const v = card.props!.variant;
  const hasMedia = !!card.slots?.media;
  return (v === 'hero' ? 1 : v === 'standard' ? 0.3 : -0.6) + (hasMedia ? 0.3 : -0.3);
}

function infoScore(card: UINode): number {
  const meta = (card.slots?.meta as UINode[] | undefined)?.length ?? 0;
  const summary = card.slots?.summary ? 0.4 : 0;
  const title = card.slots!.title as UINode;
  const lines = Number(title.props!.maxLines);
  return summary + 0.1 * meta + (lines >= 2 ? 0.1 : -0.1);
}

function buttonActions(card: UINode): string[] {
  return ((card.slots?.actions as UINode[] | undefined) ?? []).map((b) => b.props!.action);
}

export function simulateSession(
  user: SimUser, tree: UINode, data: FeedData, grammar: string, session: number, state: SimState, rng: Rng,
): SessionRecord {
  const events: UIEvent[] = [];
  let t = 0;
  const push = (e: UIEventInput) => events.push({ t, ...e } as UIEvent);

  // Density fit stretches or shrinks how far they scroll.
  const density = tree.props!.density === 'comfortable' ? 1 : -1;
  const densityFit = 1 + 0.35 * user.densityPref * density;
  const budget = user.patience * densityFit;

  const { list, footers } = exposures(user, tree, data);
  let position = 0;
  let opens = 0;
  let completions = 0;
  let dismissals = 0;
  let scrolledPast = 0;
  let impressions = 0;
  let clutterSeen = 0;
  const openedThisSession = new Set<string>();
  const seenThisSession = new Set<string>();
  // Sections whose end the user scrolled to. A footer below content they
  // never reached cannot be used.
  const reachedEndOf = new Set<number>();
  let left = false;

  for (let i = 0; i < list.length && !left; i++) {
    const x = list[i];
    const lastInSection = i === list.length - 1 || list[i + 1].section !== x.section;
    position += x.layout === 'grid' ? 0.5 : x.layout === 'carousel' ? (x.positionInSection < 2 ? 0.6 : 1.4) : 1;
    // Chance they are still scrolling and actually look at this item.
    const stillHere = Math.exp(-position / budget);
    if (rng.next() > stillHere) {
      if (position > 2.5 * budget) { left = true; break; }
      if (lastInSection) reachedEndOf.add(x.section);
      continue;
    }
    if (lastInSection) reachedEndOf.add(x.section);
    const article = feedFor(user, x.source, data)[x.articleIdx];
    const dup = seenThisSession.has(article.title);
    seenThisSession.add(article.title);
    t += 800 + rng.int(700);
    push({ type: 'impression', path: x.path, article: article.title });
    impressions++;
    clutterSeen += buttonActions(x.card).length + (x.card.slots?.summary ? 1 : 0);

    const aff = topicAffinity(user, article.topic) + (SOURCE_BOOST[x.source] ?? 0);
    const novelty = state.seen.has(article.title) ? -1.5 : 0;
    // Small tiles (grid cells, carousel items past the first two) get less attention each.
    const tile = x.layout === 'grid' ? -0.3 : x.layout === 'carousel' && x.positionInSection >= 2 ? -0.3 : 0;
    // Text on a card helps readers who want text; for visual readers it is
    // clutter, and so is a row of buttons. Nothing on a card is free.
    const textWeight = 0.5 * (0.5 - 0.5 * user.visualPref);
    const clutter = 0.12 * buttonActions(x.card).length * (0.5 + 0.5 * user.visualPref);
    const logit = user.curiosity + 1.6 * aff + 0.7 * user.visualPref * visualScore(x.card) + textWeight * infoScore(x.card) - clutter + novelty + tile + (dup ? -2 : 0);
    if (rng.next() < sigmoid(logit) && !openedThisSession.has(article.title)) {
      openedThisSession.add(article.title);
      opens++;
      push({ type: 'open', path: x.path, article: article.title });
      const readMin = Number.parseInt(article.readTime, 10) || 4;
      const completion = clamp(user.readDepth + 0.35 * aff + 0.15 * (rng.next() - 0.5), 0.02, 1);
      const dwell = Math.round(readMin * 60000 * completion * (0.7 + 0.6 * rng.next()));
      t += dwell;
      push({ type: 'dwell', path: x.path, article: article.title, value: dwell });
      push({ type: 'complete', path: x.path, article: article.title, value: completion });
      if (completion > 0.6) completions++;
      position += 1.5 * completion; // reading costs attention

      const actions = buttonActions(x.card);
      const actionPath = (a: string) => `${x.path}.actions[${actions.indexOf(a)}]`;
      if (actions.includes('save') && aff > 0.2 && rng.next() < 0.5 * user.social) push({ type: 'action', path: actionPath('save'), article: article.title, action: 'save' });
      if (actions.includes('share') && completion > 0.7 && aff > 0.3 && rng.next() < 0.4 * user.social) push({ type: 'action', path: actionPath('share'), article: article.title, action: 'share' });
      if (actions.includes('follow') && aff > 0.5 && rng.next() < 0.3 * user.social) push({ type: 'action', path: actionPath('follow'), article: article.title, action: 'follow' });
    } else {
      scrolledPast++;
      push({ type: 'scroll_past', path: x.path, article: article.title });
      const actions = buttonActions(x.card);
      if (actions.includes('dismiss') && aff < -0.3 && rng.next() < 0.45) {
        dismissals++;
        push({ type: 'action', path: `${x.path}.actions[${actions.indexOf('dismiss')}]`, article: article.title, action: 'dismiss' });
      }
    }
  }

  for (const f of footers) {
    if (!reachedEndOf.has(f.section)) continue;
    push({ type: 'impression', path: f.path });
    if (f.action === 'seeMore' && rng.next() < 0.08 * (1 + (SOURCE_BOOST[f.source] ?? 0))) push({ type: 'action', path: f.path, action: 'seeMore' });
  }

  t += 500;
  push({ type: 'session_end', path: '' });

  // Satisfaction drives retention. Dismissals hurt more than opens help; a
  // long scroll with nothing worth opening is a bad session.
  // Opened-and-abandoned reads feel like bait; they cost satisfaction rather
  // than add to it. Busy cards tire visual readers: the average clutter of
  // what they saw lowers satisfaction in proportion to their visual preference.
  const shallow = opens - completions;
  const meanClutter = impressions ? clutterSeen / impressions : 0;
  const clutterCost = 0.25 * meanClutter * (0.5 + 0.5 * user.visualPref);
  const satisfaction = 1.2 * completions - 0.25 * shallow - 1.0 * dismissals - 0.15 * scrolledPast - clutterCost + 0.6 * (densityFit - 1) - 0.6;
  const returnP = clamp(user.returnBase + 0.3 * Math.tanh(satisfaction), 0.03, 0.98);
  const returned = rng.next() < returnP;

  for (const title of openedThisSession) state.seen.add(title);
  state.sessionsSoFar++;

  return { user: user.id, session, grammar, tree, events, returned };
}
