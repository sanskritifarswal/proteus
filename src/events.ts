import type { UINode } from './tree.ts';

/**
 * The event stream. One format for both the simulator and, later, the real
 * renderer's instrumentation, so nothing learned in simulation has to be
 * translated to run on real sessions.
 *
 * Every event names the tree node it happened on by path (the template
 * node, e.g. `sections[0].content.item`), plus the article it concerned when
 * there was one. Reward attribution keys on the path; the article tells the
 * content model what was shown.
 *
 * Deliberately included from day one, so that a composite reward is the
 * easy path and raw engagement is not: `complete` (fraction of an article
 * read), `dismiss` as a first-class negative signal, and per-session
 * `returned` (did the user come back for another session).
 */
export type EventType =
  | 'impression'   // node was seen
  | 'open'         // article opened from a card
  | 'dwell'        // ms spent in an opened article (value)
  | 'complete'     // fraction of an opened article read, 0..1 (value)
  | 'scroll_past'  // seen and not opened
  | 'action'       // a Button was used (action)
  | 'session_end'; // t = session length in ms

interface Base {
  /** ms since session start. */
  t: number;
  /** Tree path of the node the event happened on. */
  path: string;
}

/** Discriminated by `type`, so each payload's required fields are enforced. */
export type UIEvent =
  | (Base & { type: 'impression'; article?: string })
  | (Base & { type: 'open'; article: string })
  | (Base & { type: 'dwell'; article: string; value: number })
  | (Base & { type: 'complete'; article: string; value: number })
  | (Base & { type: 'scroll_past'; article: string })
  | (Base & { type: 'action'; action: string; article?: string })
  | (Base & { type: 'session_end' });

/** A UIEvent without its timestamp, distributed over the union. */
export type UIEventInput = UIEvent extends infer E ? (E extends UIEvent ? Omit<E, 't'> : never) : never;

export interface SessionRecord {
  user: string;
  session: number;
  grammar: string;
  tree: UINode;
  events: UIEvent[];
  /**
   * Whether the user came back for a next session within the return window
   * (7 days by default; see collect.ts). `false` is a known no-return: the
   * window closed with no next session, or the next one came later. `null`
   * is censored: the window is still open. Reward gives the bonus for true
   * only, so false and null score alike; they differ for what is known.
   */
  returned: boolean | null;
  /** Wall-clock start as an ISO string, when the recorder had one. The simulator leaves it unset. */
  startedAt?: string;
}

export interface Trajectory {
  user: string;
  sessions: SessionRecord[];
}
