import type { SessionRecord } from '../events.ts';
import type { Decision } from '../sample.ts';

/**
 * What the policy is allowed to see, and how it names its choices.
 *
 * State: a small vector summarising the user's own event history within the
 * episode. Nothing latent about the user is available; this is the view a
 * local, on-device scorer would have. Session 0 is cold: bias only.
 *
 * Option keys: a decision at a path is named by kind, component, the slot it
 * sits in, and the option text. Paths are collapsed to slot names so the
 * same choice at sections[0] and sections[3] shares parameters.
 */
export const STATE_DIM = 11;
export const STATE_NAMES = [
  'bias', 'session', 'openRate', 'meanCompletion', 'dismissRate', 'scrollPastRate',
  'actionRate', 'dwell', 'lastOpens', 'lastCompact', 'lastReward',
] as const;

export function stateFromHistory(history: SessionRecord[], rewards: number[]): Float64Array {
  const s = new Float64Array(STATE_DIM);
  s[0] = 1;
  s[1] = Math.min(history.length, 10) / 10;
  if (history.length === 0) return s;
  let impressions = 0, opens = 0, completion = 0, dismiss = 0, scrollPast = 0, actions = 0, dwellMs = 0;
  for (const rec of history) {
    for (const e of rec.events) {
      switch (e.type) {
        case 'impression': impressions++; break;
        case 'open': opens++; break;
        case 'complete': completion += e.value; break;
        case 'dwell': dwellMs += e.value; break;
        case 'scroll_past': scrollPast++; break;
        case 'action': if (e.action === 'dismiss') dismiss++; else actions++; break;
      }
    }
  }
  const last = history[history.length - 1];
  s[2] = impressions ? opens / impressions : 0;
  s[3] = opens ? completion / opens : 0;
  s[4] = impressions ? dismiss / impressions : 0;
  s[5] = impressions ? scrollPast / impressions : 0;
  s[6] = opens ? actions / opens : 0;
  s[7] = Math.min(dwellMs / 60000 / history.length / 15, 1);
  // Opens in the most recent session. (A "returned last time" feature would
  // always be 1 here: history only exists for users who came back.)
  s[8] = Math.min(last.events.filter((e) => e.type === 'open').length / 5, 1);
  s[9] = last.tree.props?.density === 'compact' ? 1 : last.tree.props?.density === 'comfortable' ? -1 : 0;
  s[10] = rewards.length ? Math.max(-1, Math.min(1, rewards[rewards.length - 1] / 20)) : 0;
  return s;
}

/** The slot a decision sits in: last path segment without its index; 'root' for the root. */
export function slotOf(path: string): string {
  if (!path) return 'root';
  const seg = path.slice(path.lastIndexOf('.') + 1);
  return seg.replace(/\[\d+\]$/, '');
}

export function optionKey(d: Decision, option: string): string {
  return `${d.kind}|${d.component}|${slotOf(d.path)}|${option}`;
}
