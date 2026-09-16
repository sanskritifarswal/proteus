import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from './server.ts';
import { createRecorder } from './client/recorder.ts';
import type { UIDocument } from './tree.ts';
import type { Status } from './status.ts';
import { train } from './policy/train.ts';

/**
 * The status page, in-process: totals and per-reader rows from posted
 * sessions, the reward-by-session curve, the simulated gap cached until
 * the store changes and skippable, the bearer gate in token mode, and
 * the HTML carrying the same numbers.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const dir = mkdtempSync(join(tmpdir(), 'proteus-status-'));
const doc = JSON.parse(readFileSync('examples/valid/dense-list.json', 'utf8')) as UIDocument;
// A barely trained policy, so serves record traces and the page names the policy; the token server uses a fixed tree.
const learned = train({ iterations: 2, usersPerIteration: 20, maxSessions: 3, lr: 0.02, l2: 0.001, seed: 1 }).policy;

async function withServer<T>(token: string | undefined, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ store: join(dir, token ? 'tok' : 'open'), policy: token ? doc : learned, epsilon: token ? 0 : 0.1, token, statusSimUsers: 20, seed: 7 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { return await fn(base); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

async function postSession(base: string, user: string, session: number, opens: number, startedAt: string, k = ''): Promise<void> {
  const page = await (await fetch(`${base}/u/${user}${k}`)).text();
  const tree = JSON.parse(/<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(page)![1].replace(/\\u003c/g, '<'));
  const cards = [...page.matchAll(/data-path="([^"]+)" data-article="([^"]+)"/g)].map((m) => ({ path: m[1], article: m[2].replace(/&amp;/g, '&') }));
  let clock = Date.parse(startedAt);
  const rec = createRecorder({ user, session, grammar: doc.grammar, tree, now: () => clock });
  for (let i = 0; i < Math.min(opens, cards.length); i++) {
    clock += 500; rec.impression(cards[i].path, cards[i].article);
    clock += 500; rec.open(cards[i].path, cards[i].article);
    clock += 30_000; rec.close(0.8);
  }
  clock += 1000; rec.end();
  const r = await fetch(`${base}/events${k}`, { method: 'POST', body: JSON.stringify(rec.record()) });
  if (r.status !== 200) throw new Error(`post failed: ${await r.text()}`);
}

await withServer(undefined, async (base) => {
  const empty = await (await fetch(`${base}/status.json`)).json() as Status;
  report(empty.totals.sessions === 0 && empty.sim === null && empty.users.length === 0 && empty.server.policy === learned.name && empty.server.epsilon === 0.1 && empty.server.content.mode === 'fake', `empty store: zero totals, no simulation, policy ${empty.server.policy} (ε ${empty.server.epsilon}), fake content`);

  await postSession(base, 'alice', 0, 1, '2026-09-16T09:00:00Z');
  await postSession(base, 'alice', 1, 3, '2026-09-16T18:00:00Z');
  await postSession(base, 'bob', 0, 2, '2026-09-16T12:00:00Z');
  const s = await (await fetch(`${base}/status.json`)).json() as Status;
  report(s.totals.sessions === 3 && s.totals.users === 2 && s.server.store.sessions === 3 && s.server.store.traces === 3, `totals: ${s.totals.sessions} sessions from ${s.totals.users} readers, ${s.server.store.traces} traces`);
  report(s.totals.opensPerSession === 2 && (s.totals.meanReward ?? 0) > 0, `totals: ${s.totals.opensPerSession} opens/session, mean reward ${s.totals.meanReward?.toFixed(2)}`);
  report(s.totals.returnKnown === 1 && s.totals.returnRate === 1, 'return: alice\'s first session is known to have returned; the others are censored');
  const alice = s.users.find((u) => u.user === 'alice')!, bob = s.users.find((u) => u.user === 'bob')!;
  report(s.users[0].user === 'alice' && alice.sessions === 2 && bob.sessions === 1 && alice.returnRate === 1 && bob.returnRate === null, 'readers sorted by last activity; per-reader sessions and return rate');
  report(alice.firstAt === '2026-09-16T09:00:00.000Z' && alice.lastAt !== null && alice.lastAt > '2026-09-16T18:00:00' && alice.lastAt < '2026-09-16T18:05:00', `reader timestamps from the records: first ${alice.firstAt}, last ${alice.lastAt} (start plus the session's length)`);
  report(s.rewardBySession.length === 2 && s.rewardBySession[0].session === 0 && s.rewardBySession[0].n === 2 && s.rewardBySession[1].n === 1 && s.rewardBySession[1].meanReward > s.rewardBySession[0].meanReward, `reward by session index: ${s.rewardBySession.map((r) => `${r.session}: ${r.meanReward.toFixed(2)} (n=${r.n})`).join(', ')}`);
  report(s.sim !== null && s.sim.sessions === 3 && s.sim.simUsers === 20 && Number.isFinite(s.sim.meanZ.reward) && Number.isFinite(s.sim.meanAbsZ.opens), `sim gap on ${s.sim?.sessions} sessions × ${s.sim?.simUsers} readers: reward z ${s.sim?.meanZ.reward.toFixed(2)}, computed in ${s.sim?.ms} ms`);

  const again = await (await fetch(`${base}/status.json`)).json() as Status;
  report(again.sim?.computedAt === s.sim?.computedAt, 'the simulation is cached while the store is unchanged');
  const skipped = await (await fetch(`${base}/status.json?sim=0`)).json() as Status;
  report(skipped.sim === null && skipped.totals.sessions === 3, '?sim=0 skips the simulation and keeps the rest');
  const recent = await (await fetch(`${base}/status.json?recent=1`)).json() as Status;
  report(recent.sim?.sessions === 1 && recent.sim.computedAt !== s.sim?.computedAt, '?recent=1 simulates only the latest session (and is its own cache entry)');
  const bad = await fetch(`${base}/status.json?recent=0`);
  report(bad.status === 400, 'recent out of range is a 400');
  await postSession(base, 'bob', 1, 1, '2026-09-16T20:00:00Z');
  const after = await (await fetch(`${base}/status.json`)).json() as Status;
  report(after.sim?.sessions === 4 && after.sim.computedAt !== s.sim?.computedAt && after.users[0].user === 'bob', 'a new session invalidates the cache and moves that reader to the top');

  const html = await (await fetch(`${base}/status`)).text();
  report(html.includes('<title>Proteus status</title>') && html.includes('>alice<') && html.includes('>bob<') && html.includes('Reward by session index') && html.includes('mean z') && html.includes('href="/u/alice"'), 'the HTML page carries readers, the curve, the gap table, and links to each reader\'s screen');
  const index = await (await fetch(`${base}/`)).text();
  report(index.includes('href="/status"'), 'the index links to the status page');
});

await withServer('0123456789abcdef0123', async (base) => {
  const noAuth = await fetch(`${base}/status`);
  const noAuthJson = await fetch(`${base}/status.json`);
  const withAuth = await fetch(`${base}/status.json`, { headers: { authorization: 'Bearer 0123456789abcdef0123' } });
  const st = await withAuth.json() as Status;
  report(noAuth.status === 401 && noAuthJson.status === 401 && withAuth.status === 200 && st.server.policy === 'fixed', 'in token mode both status routes need the bearer token; a fixed tree is reported as such');
});

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} status check(s) failed` : '\nstatus checks passed');
process.exit(failures ? 1 : 0);
