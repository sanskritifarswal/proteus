/**
 * Event recorder: the part of instrumentation that has no DOM in it.
 *
 * It turns a sequence of observations (a card became visible, the user
 * opened it, closed it having read this much, pressed this button, left)
 * into a SessionRecord in exactly the format the simulator produces, so
 * the same reward, state features and training code run on real sessions.
 *
 * Written without imports so it can be embedded verbatim in a rendered
 * page; the types below mirror src/events.ts and src/tree.ts.
 */
export type RecorderEvent =
  | { t: number; type: 'impression'; path: string; article?: string }
  | { t: number; type: 'open'; path: string; article: string }
  | { t: number; type: 'dwell'; path: string; article: string; value: number }
  | { t: number; type: 'complete'; path: string; article: string; value: number }
  | { t: number; type: 'scroll_past'; path: string; article: string }
  | { t: number; type: 'action'; path: string; action: string; article?: string }
  | { t: number; type: 'session_end'; path: string };

export interface RecorderRecord {
  user: string;
  session: number;
  grammar: string;
  tree: unknown;
  startedAt: string;
  events: RecorderEvent[];
  /** Unknown on the client; derived later from whether a next session exists. */
  returned: null;
}

export interface RecorderOptions {
  user: string;
  session: number;
  grammar: string;
  tree: unknown;
  /** Milliseconds clock; defaults to Date.now. */
  now?: () => number;
}

export interface Recorder {
  /** A node with content became visible. Deduplicated per (path, article). */
  impression(path: string, article?: string): void;
  /** The user opened an article from a card. Returns false if already open. */
  open(path: string, article: string): boolean;
  /** The open article was closed; `fractionRead` in 0..1. Emits dwell and complete. */
  close(fractionRead: number): void;
  /** A card that had an impression left the viewport without being opened. */
  scrollPast(path: string, article: string): void;
  /** A button was pressed. */
  action(path: string, action: string, article?: string): void;
  /** The session ended (page hidden or unloaded). Idempotent. */
  end(): void;
  /** The record so far. */
  record(): RecorderRecord;
  /**
   * The record so far with a session_end appended, without ending the
   * recorder. For flushing when the page is hidden: a tab going to the
   * background and back is ordinary on a phone and must not end the session.
   */
  snapshot(): RecorderRecord;
  /** Number of events so far. */
  size(): number;
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const events: RecorderEvent[] = [];
  const seen = new Set<string>();
  const opened = new Set<string>();
  const passed = new Set<string>();
  let current: { path: string; article: string; openedAt: number } | null = null;
  let ended = false;
  const t = () => Math.max(0, Math.round(now() - t0));
  const key = (path: string, article?: string) => JSON.stringify([path, article ?? '']);

  return {
    impression(path, article) {
      if (ended) return;
      const k = key(path, article);
      if (seen.has(k)) return;
      seen.add(k);
      events.push(article === undefined ? { t: t(), type: 'impression', path } : { t: t(), type: 'impression', path, article });
    },
    open(path, article) {
      if (ended || current) return false;
      const k = key(path, article);
      if (opened.has(k)) return false;
      opened.add(k);
      if (!seen.has(k)) { seen.add(k); events.push({ t: t(), type: 'impression', path, article }); }
      current = { path, article, openedAt: now() };
      events.push({ t: t(), type: 'open', path, article });
      return true;
    },
    close(fractionRead) {
      if (!current) return;
      const dwell = Math.max(0, Math.round(now() - current.openedAt));
      const value = Math.min(1, Math.max(0, Number.isFinite(fractionRead) ? fractionRead : 0));
      events.push({ t: t(), type: 'dwell', path: current.path, article: current.article, value: dwell });
      events.push({ t: t(), type: 'complete', path: current.path, article: current.article, value });
      current = null;
    },
    scrollPast(path, article) {
      if (ended) return;
      const k = key(path, article);
      if (!seen.has(k) || opened.has(k) || passed.has(k)) return;
      passed.add(k);
      events.push({ t: t(), type: 'scroll_past', path, article });
    },
    action(path, action, article) {
      if (ended) return;
      events.push(article === undefined ? { t: t(), type: 'action', path, action } : { t: t(), type: 'action', path, action, article });
    },
    end() {
      if (ended) return;
      if (current) this.close(0);
      ended = true;
      events.push({ t: t(), type: 'session_end', path: '' });
    },
    record() {
      return { user: opts.user, session: opts.session, grammar: opts.grammar, tree: opts.tree, startedAt: new Date(t0).toISOString(), events: events.slice(), returned: null };
    },
    snapshot() {
      const r = this.record();
      if (!ended) r.events.push({ t: t(), type: 'session_end', path: '' });
      return r;
    },
    size() { return events.length; },
  };
}
