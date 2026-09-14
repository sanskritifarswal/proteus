import type { SessionRecord } from './events.ts';

/**
 * Composite per-session reward.
 *
 * The guardrail from the design notes: never optimise raw engagement alone.
 * So the largest weights sit on completion and on returning, dismissals are
 * a real negative, and every positive volume term saturates (square root of
 * opens, of total completion and of positive actions; capped dwell) so that
 * a screen which farms taps, piles on content or puts a save button on
 * everything cannot outscore one that fits the reader. Negatives stay
 * linear: each dismissal counts in full. Weights are a parameter: the local scorer can
 * shift them per user or expose some to the user directly.
 */
export interface RewardWeights {
  open: number;
  completion: number;
  dwellPerMinute: number;
  save: number;
  share: number;
  follow: number;
  dismiss: number;
  scrollPast: number;
  returned: number;
  /** Cap on dwell counted per session, in minutes. */
  dwellCapMinutes: number;
}

export const defaultWeights: RewardWeights = {
  open: 1.0,
  completion: 2.0,
  dwellPerMinute: 0.3,
  save: 1.5,
  share: 1.5,
  follow: 1.0,
  dismiss: -2.0,
  scrollPast: -0.05,
  returned: 3.0,
  dwellCapMinutes: 20,
};

/** Positive terms must be non-negative (they are square-rooted); negatives must be non-positive. */
export function validateWeights(w: RewardWeights): void {
  const bad: string[] = [];
  for (const k of ['open', 'completion', 'dwellPerMinute', 'save', 'share', 'follow', 'returned', 'dwellCapMinutes'] as const) {
    if (!(w[k] >= 0)) bad.push(`${k} must be >= 0 (got ${w[k]})`);
  }
  for (const k of ['dismiss', 'scrollPast'] as const) {
    if (!(w[k] <= 0)) bad.push(`${k} must be <= 0 (got ${w[k]})`);
  }
  if (bad.length) throw new Error(`invalid reward weights: ${bad.join('; ')}`);
}

export function sessionReward(rec: SessionRecord, w: RewardWeights = defaultWeights): number {
  validateWeights(w);
  let opens = 0;
  let completion = 0;
  let dwellMs = 0;
  let scrollPast = 0;
  let positiveActions = 0;
  let negativeActions = 0;
  for (const e of rec.events) {
    switch (e.type) {
      case 'open': opens++; break;
      case 'complete': completion += e.value ?? 0; break;
      case 'dwell': dwellMs += e.value ?? 0; break;
      case 'scroll_past': scrollPast++; break;
      case 'action':
        if (e.action === 'save') positiveActions += w.save;
        else if (e.action === 'share') positiveActions += w.share;
        else if (e.action === 'follow') positiveActions += w.follow;
        else if (e.action === 'dismiss') negativeActions += w.dismiss;
        break;
    }
  }
  const dwellMin = Math.min(dwellMs / 60000, w.dwellCapMinutes);
  return (
    w.open * Math.sqrt(opens) +
    w.completion * Math.sqrt(completion) +
    w.dwellPerMinute * dwellMin +
    Math.sqrt(positiveActions) +
    negativeActions +
    w.scrollPast * scrollPast +
    (rec.returned ? w.returned : 0)
  );
}

/**
 * Decompose a session's reward into contributions by node path, plus a
 * shared remainder with no path (the return bonus). Sums exactly to
 * sessionReward. Saturating terms are split across the events that formed
 * them in proportion to each event's contribution, so a card that earned
 * two of five opens gets two fifths of the opens term.
 *
 * This is what lets a decision be credited for what happened under its own
 * subtree rather than for the whole session.
 */
export function attributeReward(rec: SessionRecord, w: RewardWeights = defaultWeights): { byPath: Map<string, number>; shared: number } {
  validateWeights(w);
  const byPath = new Map<string, number>();
  const add = (path: string, x: number) => { if (x !== 0) byPath.set(path, (byPath.get(path) ?? 0) + x); };

  const opens: string[] = [];
  const completes: Array<[string, number]> = [];
  const dwells: Array<[string, number]> = [];
  const positives: Array<[string, number]> = [];
  for (const e of rec.events) {
    switch (e.type) {
      case 'open': opens.push(e.path); break;
      case 'complete': completes.push([e.path, e.value]); break;
      case 'dwell': dwells.push([e.path, e.value]); break;
      case 'scroll_past': add(e.path, w.scrollPast); break;
      case 'action':
        if (e.action === 'save') positives.push([e.path, w.save]);
        else if (e.action === 'share') positives.push([e.path, w.share]);
        else if (e.action === 'follow') positives.push([e.path, w.follow]);
        else if (e.action === 'dismiss') add(e.path, w.dismiss);
        break;
    }
  }
  const spread = (items: Array<[string, number]>, total: number) => {
    const sum = items.reduce((a, [, v]) => a + v, 0);
    if (sum <= 0) return;
    for (const [path, v] of items) add(path, (total * v) / sum);
  };
  const openTerm = w.open * Math.sqrt(opens.length);
  for (const path of opens) add(path, openTerm / opens.length);
  spread(completes, w.completion * Math.sqrt(completes.reduce((a, [, v]) => a + v, 0)));
  const dwellTotal = dwells.reduce((a, [, v]) => a + v, 0);
  const dwellMin = Math.min(dwellTotal / 60000, w.dwellCapMinutes);
  spread(dwells, w.dwellPerMinute * dwellMin);
  spread(positives, Math.sqrt(positives.reduce((a, [, v]) => a + v, 0)));
  return { byPath, shared: rec.returned ? w.returned : 0 };
}
