import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, SessionStore } from './server.ts';
import { createRecorder } from './client/recorder.ts';
import { LinearPolicy } from './policy/linear-policy.ts';
import { train } from './policy/train.ts';

/**
 * The server in-process on an ephemeral port: serves a user's screen,
 * accepts valid records, rejects malformed ones, deduplicates snapshots
 * against finals by event count, survives a restart, and advances the
 * user's session index.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const dir = mkdtempSync(join(tmpdir(), 'proteus-server-'));
const policy = train({ iterations: 2, usersPerIteration: 20, maxSessions: 3, lr: 0.02, l2: 0.001, seed: 1 }).policy as LinearPolicy;

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ store: dir, policy });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { return await fn(base); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

await withServer(async (base) => {
  const page = await (await fetch(`${base}/u/alice`)).text();
  // The config lives in an HTML attribute, so quotes are escaped.
  const cfg = (html: string) => JSON.parse(/data-proteus="([^"]*)"/.exec(html)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as { session: number; endpoint?: string };
  report(page.includes('data-proteus') && cfg(page).session === 0 && cfg(page).endpoint === '/events', 'GET /u/alice serves an instrumented screen for session 0 pointing at /events');
  const treeJson = /<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(page)![1];
  const tree = JSON.parse(treeJson.replace(/\\u003c/g, '<'));

  // A snapshot, then the final record with more events, then a stale snapshot.
  let clock = 0;
  const rec = createRecorder({ user: 'alice', session: 0, grammar: 'newsfeed@0.3.0', tree, now: () => clock });
  rec.impression('sections[0].content.item', 'A');
  const snapshot = rec.snapshot();
  clock += 1000; rec.open('sections[0].content.item', 'A'); clock += 60000; rec.close(0.9); rec.end();
  const final = rec.record();
  const post = async (body: unknown) => { const r = await fetch(`${base}/events`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as { ok: boolean; replaced?: boolean; errors?: string[] } }; };
  const r1 = await post(snapshot);
  report(r1.status === 200 && r1.json.replaced === true, 'a snapshot is accepted and stored');
  const r2 = await post(final);
  report(r2.status === 200 && r2.json.replaced === true, 'the final record replaces the snapshot');
  const r3 = await post(snapshot);
  report(r3.status === 200 && r3.json.replaced === false, 'a late snapshot with fewer events does not replace the final');
  const bad = await post({ ...final, events: [{ t: 0, type: 'open', path: 'nowhere', article: 'Z' }] });
  report(bad.status === 400 && (bad.json.errors?.length ?? 0) > 0, `a malformed record is rejected with reasons (${bad.json.errors?.[0]})`);
  const notJson = await fetch(`${base}/events`, { method: 'POST', body: '{not json' });
  report(notJson.status === 400, 'non-JSON bodies are rejected');

  const data = await (await fetch(`${base}/sessions/alice`)).json() as { sessions: Array<{ session: number; events: number; reward: number }>; nextState: Record<string, number> };
  report(data.sessions.length === 1 && data.sessions[0].events === final.events.length && data.sessions[0].reward > 0 && data.nextState.session === 0.1, `GET /sessions/alice assembles one session with reward ${data.sessions[0].reward.toFixed(2)} and a next state`);
  const page2 = await (await fetch(`${base}/u/alice`)).text();
  report(cfg(page2).session === 1, 'GET /u/alice now serves session 1');
  const exp = await (await fetch(`${base}/export.jsonl`)).text();
  report(exp.trim().split('\n').length === 1 && JSON.parse(exp.trim()).events.length === final.events.length, 'export.jsonl has one deduplicated line per session');
  const missing = await fetch(`${base}/nope`);
  report(missing.status === 404, 'unknown paths are 404');
});

// Restart on the same store: the session is still there.
const reloaded = new SessionStore(dir);
report(reloaded.sessions('alice').length === 1 && reloaded.records().length === 1, 'the store reloads deduplicated sessions from its log');

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} server check(s) failed` : '\nserver checks passed');
process.exit(failures ? 1 : 0);
