import type { SessionRecord } from './events.ts';

/**
 * Composite per-session reward.
 *
 * The guardrail from the design notes: never optimise raw engagement alone.
 * So the largest weights sit on completion and on returning, dismissals are
 * a real negative, and the engagement terms saturate (sqrt of opens, capped
 * dwell) so that a screen which farms taps cannot outscore one that gets an
 * article actually read. Weights are a parameter: the local scorer can
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
  let actions = 0;
  for (const e of rec.events) {
    switch (e.type) {
      case 'open': opens++; break;
      case 'complete': completion += e.value ?? 0; break;
      case 'dwell': dwellMs += e.value ?? 0; break;
      case 'scroll_past': scrollPast++; break;
      case 'action':
        if (e.action === 'save') actions += w.save;
        else if (e.action === 'share') actions += w.share;
        else if (e.action === 'follow') actions += w.follow;
        else if (e.action === 'dismiss') actions += w.dismiss;
        break;
    }
  }
  const dwellMin = Math.min(dwellMs / 60000, w.dwellCapMinutes);
  return (
    w.open * Math.sqrt(opens) +
    w.completion * completion +
    w.dwellPerMinute * dwellMin +
    actions +
    w.scrollPast * scrollPast +
    (rec.returned ? w.returned : 0)
  );
}
