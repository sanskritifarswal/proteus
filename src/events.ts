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

export interface UIEvent {
  /** ms since session start. */
  t: number;
  type: EventType;
  path: string;
  article?: string;
  action?: string;
  value?: number;
}

export interface SessionRecord {
  user: string;
  session: number;
  grammar: string;
  tree: UINode;
  events: UIEvent[];
  /** Whether the user came back for a next session. Filled in when known. */
  returned: boolean;
}

export interface Trajectory {
  user: string;
  sessions: SessionRecord[];
}
