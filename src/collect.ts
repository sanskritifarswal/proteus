import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { SessionRecord, UIEvent } from './events.ts';
import { nodePaths, type UINode } from './tree.ts';
import { sessionReward } from './reward.ts';
import { stateFromHistory, STATE_NAMES } from './policy/features.ts';
import { grammarId } from './compile-schema.ts';
import { newsfeed } from './grammars/newsfeed.ts';
import { fakeData } from './fake-data.ts';

/**
 * Real sessions in, the same numbers the simulator produces out.
 *
 * A record exported from an instrumented page is validated against the
 * event contract (type-specific required fields, every path a node in the
 * tree it was shown, the current grammar id), `returned` is derived from
 * whether the user's next session exists, and the composite reward and the
 * policy state are computed with the very code the simulator uses.
 *
 * usage: node src/collect.ts --file out/sessions.jsonl [--add record.json] [--user id]
 */
export interface ExportedRecord extends Omit<SessionRecord, 'returned'> {
  returned: boolean | null;
}

export function validateRecord(rec: unknown): string[] {
  const errors: string[] = [];
  const r = rec as Partial<ExportedRecord>;
  if (typeof r !== 'object' || r === null) return ['record is not an object'];
  if (typeof r.user !== 'string' || !r.user) errors.push('user must be a non-empty string');
  if (!Number.isInteger(r.session) || (r.session as number) < 0) errors.push('session must be a non-negative integer');
  if (r.grammar !== grammarId(newsfeed)) errors.push(`grammar is '${r.grammar}', expected '${grammarId(newsfeed)}'`);
  if (typeof r.tree !== 'object' || r.tree === null || (r.tree as UINode).type !== newsfeed.root) errors.push('tree must be a Screen node');
  if (!Array.isArray(r.events)) return [...errors, 'events must be an array'];
  const paths = r.tree && typeof r.tree === 'object' ? nodePaths(r.tree as UINode) : new Set<string>();
  let last = -1;
  r.events.forEach((e: Partial<UIEvent>, i) => {
    const at = `events[${i}]`;
    if (typeof e !== 'object' || e === null) { errors.push(`${at} is not an object`); return; }
    if (!Number.isFinite(e.t) || (e.t as number) < 0) errors.push(`${at}.t must be a non-negative number`);
    else if ((e.t as number) < last) errors.push(`${at}.t goes backwards`);
    else last = e.t as number;
    if (typeof e.path !== 'string') errors.push(`${at}.path must be a string`);
    else if (!paths.has(e.path)) errors.push(`${at}.path '${e.path}' is not a node in the tree`);
    const articleRaw = (e as { article?: unknown }).article;
    const art = typeof articleRaw === 'string' && articleRaw.length > 0;
    if (articleRaw !== undefined && !art) errors.push(`${at}.article must be a non-empty string when present`);
    const value = (e as { value?: unknown }).value;
    const num = typeof value === 'number' && Number.isFinite(value);
    switch (e.type) {
      case 'impression': break;
      case 'open': case 'scroll_past': if (!art) errors.push(`${at} ${e.type} needs article`); break;
      case 'dwell': case 'complete':
        if (!art) errors.push(`${at} ${e.type} needs article`);
        if (!num) errors.push(`${at} ${e.type} needs a numeric value`);
        else if (e.type === 'complete' && (value < 0 || value > 1)) errors.push(`${at} complete value must be in 0..1`);
        else if (e.type === 'dwell' && value < 0) errors.push(`${at} dwell value must be non-negative`);
        break;
      case 'action': if (typeof (e as { action?: unknown }).action !== 'string' || !(e as { action: string }).action) errors.push(`${at} action needs action`); break;
      case 'session_end': break;
      default: errors.push(`${at} has unknown type '${String(e.type)}'`);
    }
  });
  if (!r.events.length || r.events[r.events.length - 1].type !== 'session_end') errors.push('last event must be session_end');
  return errors;
}

/**
 * Group by user, order by session, derive `returned` from the next
 * session's existence (censored on the last). Two records for the same
 * (user, session) are an error: re-adding an export, or ingesting both a
 * hidden-page snapshot and the final record, would otherwise invent a
 * session and a return.
 */
export function assemble(records: ExportedRecord[]): Map<string, SessionRecord[]> {
  const byUser = new Map<string, ExportedRecord[]>();
  const seen = new Set<string>();
  for (const r of records) {
    const k = `${r.user}:${r.session}`;
    if (seen.has(k)) throw new Error(`duplicate session ${r.session} for user ${r.user}`);
    seen.add(k);
    (byUser.get(r.user) ?? byUser.set(r.user, []).get(r.user)!).push(r);
  }
  const out = new Map<string, SessionRecord[]>();
  for (const [user, list] of byUser) {
    list.sort((a, b) => a.session - b.session);
    out.set(user, list.map((r, i) => ({ user: r.user, session: r.session, grammar: r.grammar, tree: r.tree, events: r.events, returned: i < list.length - 1 ? true : null, ...(r.startedAt ? { startedAt: r.startedAt } : {}) })));
  }
  return out;
}

const topicByTitle = new Map<string, string>();
for (const feed of Object.values(fakeData.feeds)) for (const a of feed.articles) topicByTitle.set(a.title, a.topic);

if (process.argv[1] && basename(process.argv[1]) === 'collect.ts') {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const file = opt('file') ?? 'out/sessions.jsonl';
  const add = opt('add');
  const onlyUser = opt('user');
  if (add) {
    const rec = JSON.parse(readFileSync(add, 'utf8'));
    const errors = validateRecord(rec);
    if (errors.length) { console.error(`record rejected:\n  ${errors.join('\n  ')}`); process.exit(1); }
    const existing = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExportedRecord) : [];
    if (existing.some((r) => r.user === rec.user && r.session === rec.session)) {
      console.error(`record rejected: session ${rec.session} for ${rec.user} is already in ${file}`); process.exit(1);
    }
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + '\n');
    console.log(`added session ${rec.session} for ${rec.user} to ${file}`);
  }
  if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExportedRecord);
  let bad = 0;
  records.forEach((r, i) => { const e = validateRecord(r); if (e.length) { bad++; console.error(`line ${i + 1}: ${e.join('; ')}`); } });
  if (bad) { console.error(`${bad} invalid record(s)`); process.exit(1); }
  let assembled: Map<string, SessionRecord[]>;
  try { assembled = assemble(records); } catch (e) { console.error((e as Error).message); process.exit(1); }
  for (const [user, sessions] of assembled) {
    if (onlyUser && user !== onlyUser) continue;
    console.log(`user ${user}: ${sessions.length} session(s)`);
    const rewards: number[] = [];
    sessions.forEach((s) => {
      const r = sessionReward(s);
      rewards.push(r);
      const opens = s.events.filter((e) => e.type === 'open').length;
      const compl = s.events.filter((e) => e.type === 'complete').reduce((a, e) => a + (e.type === 'complete' ? e.value : 0), 0);
      console.log(`  session ${s.session}: ${s.events.length} events, ${opens} opens, completion ${compl.toFixed(2)}, returned ${s.returned === null ? 'unknown' : s.returned}, reward ${r.toFixed(2)}`);
    });
    const state = stateFromHistory(sessions, rewards, (t) => topicByTitle.get(t));
    console.log(`  next-session state: ${STATE_NAMES.map((n, i) => `${n}=${state[i].toFixed(2)}`).join(' ')}`);
  }
}
