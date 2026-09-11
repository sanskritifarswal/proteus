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

export function sessionReward(rec: SessionRecord, w: RewardWeights = defaultWeights): number {
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
