import type { SessionRecord } from '../events.ts';
import type { UINode } from '../tree.ts';
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
export const STATE_NAMES = [
  // Engagement summary of the user's history.
  'bias', 'session', 'openRate', 'meanCompletion', 'dismissRate', 'scrollPastRate',
  'actionRate', 'dwell', 'lastOpens', 'lastCompact', 'lastReward',
  // Evidence about choices the policy controls: mean session reward when the
  // choice was on minus when it was off, for this user (0 until both seen).
  // A linear policy cannot multiply "what I showed" by "what happened", so
  // the product is handed to it directly.
  'evCompactDensity', 'evCompactItems', 'evHeroLead', 'evButtons',
  // Sources: open rate on the user's own feeds minus on general feeds.
  'personalFeedLift',
  // Topics: how concentrated opens are, and how many topics have been opened.
  'topOpenShare', 'topicsOpened',
] as const;
export const STATE_DIM = STATE_NAMES.length;

const PERSONAL = new Set(['following', 'saved', 'continueReading']);

/** Per-session choice summary from the tree the policy produced. */
function choicesOf(tree: UINode): { compact: boolean; compactItems: boolean; heroLead: boolean; buttons: boolean } {
  const sections = (tree.slots?.sections as UINode[]) ?? [];
  let compactItems = 0, heroLead = 0, buttons = 0;
  for (const sec of sections) {
    const coll = sec.slots!.content as UINode;
    const item = coll.slots!.item as UINode;
    if (item.props!.variant === 'compact') compactItems++;
    if ((coll.slots?.lead as UINode | undefined)?.props?.variant === 'hero') heroLead++;
    buttons += ((item.slots?.actions as UINode[] | undefined)?.length ?? 0);
  }
  const n = Math.max(sections.length, 1);
  return {
    compact: tree.props?.density === 'compact',
    compactItems: compactItems / n >= 0.5,
    heroLead: heroLead > 0,
    buttons: buttons / n >= 1,
  };
}

function evidence(flags: boolean[], rewards: number[]): number {
  let on = 0, onN = 0, off = 0, offN = 0;
  flags.forEach((f, i) => { if (f) { on += rewards[i]; onN++; } else { off += rewards[i]; offN++; } });
  if (!onN || !offN) return 0;
  return Math.max(-1, Math.min(1, (on / onN - off / offN) / 20));
}

export function stateFromHistory(history: SessionRecord[], rewards: number[], topicOf?: (article: string) => string | undefined): Float64Array {
  const s = new Float64Array(STATE_DIM);
  s[0] = 1;
  s[1] = Math.min(history.length, 10) / 10;
  if (history.length === 0) return s;
  let impressions = 0, opens = 0, completion = 0, dismiss = 0, scrollPast = 0, actions = 0, dwellMs = 0;
  let pImp = 0, pOpen = 0, gImp = 0, gOpen = 0;
  const topicOpens = new Map<string, number>();
  for (const rec of history) {
    const sources = ((rec.tree.slots?.sections as UINode[]) ?? []).map((sec) => sec.props!.source);
    for (const e of rec.events) {
      const m = /^sections\[(\d+)\]/.exec(e.path);
      const personal = m ? PERSONAL.has(sources[Number(m[1])]) : false;
      switch (e.type) {
        case 'impression':
          impressions++;
          if (m && e.article) { if (personal) pImp++; else gImp++; }
          break;
        case 'open': {
          opens++;
          if (m) { if (personal) pOpen++; else gOpen++; }
          const t = topicOf?.(e.article);
          if (t) topicOpens.set(t, (topicOpens.get(t) ?? 0) + 1);
          break;
        }
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
  s[8] = Math.min(last.events.filter((e) => e.type === 'open').length / 5, 1);
  s[9] = last.tree.props?.density === 'compact' ? 1 : last.tree.props?.density === 'comfortable' ? -1 : 0;
  s[10] = rewards.length ? Math.max(-1, Math.min(1, rewards[rewards.length - 1] / 20)) : 0;

  const choices = history.map((rec) => choicesOf(rec.tree));
  const r = rewards.slice(0, history.length);
  s[11] = evidence(choices.map((c) => c.compact), r);
  s[12] = evidence(choices.map((c) => c.compactItems), r);
  s[13] = evidence(choices.map((c) => c.heroLead), r);
  s[14] = evidence(choices.map((c) => c.buttons), r);
  s[15] = pImp && gImp ? pOpen / pImp - gOpen / gImp : 0;
  const totalTopicOpens = [...topicOpens.values()].reduce((a, b) => a + b, 0);
  s[16] = totalTopicOpens ? Math.max(...topicOpens.values()) / totalTopicOpens : 0;
  s[17] = Math.min(topicOpens.size / 13, 1);
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
