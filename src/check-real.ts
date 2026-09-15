import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, SessionStore, treeHash } from './server.ts';
import { LinearPolicy } from './policy/linear-policy.ts';
import { learnedScreenPolicy } from './policy/train.ts';
import { runEpisodes } from './sim/episodes.ts';
import { makePopulation } from './sim/users.ts';
import { makeRng } from './rng.ts';
import { fakeData } from './fake-data.ts';
import { runSyntheticClients } from './real/synthetic-clients.ts';
import { trainReal } from './real/train-real.ts';
import { compareSessions, METRICS } from './real/compare.ts';
import { createRecorder } from './client/recorder.ts';

/**
 * The real-session pipeline end to end, with synthetic clients standing in
 * for people: serve with exploration and record traces, clients behave and
 * post, train-real updates the policy from the store and improves it on a
 * held-out simulated population, compare produces finite z-scores, and
 * sessions without traces are skipped rather than trained on.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const dir = mkdtempSync(join(tmpdir(), 'proteus-real-'));
const policy = new LinearPolicy(); // untrained: uniform, so improvement is measurable
const evalPop = () => makePopulation(300, makeRng(4242));
const evaluate = () => runEpisodes(learnedScreenPolicy(policy), evalPop(), fakeData, 6, 4242).stats.meanEpisodeReward;
const before = evaluate();

// Seeded, so the run (and so the improvement it asserts) is repeatable.
const server = createServer({ store: dir, policy, epsilon: 0.15, seed: 11 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const clients = await runSyntheticClients({ base, users: 150, sessions: 4, seed: 7 });
await new Promise<void>((r) => server.close(() => r()));
report(clients.rejected === 0 && clients.sessions >= 150, `synthetic clients posted ${clients.sessions} sessions for ${clients.users} users with ${clients.rejected} rejected`);

const store = new SessionStore(dir);
report(store.traceCount() >= clients.sessions, `every served screen left a trace (${store.traceCount()} traces, ${clients.sessions} sessions)`);

// A session whose tree has no trace (served elsewhere, or a different load
// than the one posted): skipped, not trained on.
{
  const rec = createRecorder({ user: 'stranger', session: 0, grammar: 'newsfeed@0.3.0', tree: store.sessions(store.users()[0])[0].tree, now: () => 0 });
  rec.end();
  store.put(rec.record());
}
// A greedily served session (ε = 0): skipped.
{
  const greedy = createServer({ store: dir, policy, epsilon: 0, seed: 12 });
  await new Promise<void>((r) => greedy.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(greedy.address() as AddressInfo).port}`;
  const html = await (await fetch(`${b}/u/greedy-user`)).text();
  const tree = JSON.parse(/<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(html)![1].replace(/\\u003c/g, '<'));
  const rec = createRecorder({ user: 'greedy-user', session: 0, grammar: 'newsfeed@0.3.0', tree, now: () => 0 });
  rec.end();
  await fetch(`${b}/events`, { method: 'POST', body: JSON.stringify(rec.record()) });
  await new Promise<void>((r) => greedy.close(() => r()));
}
// Two loads before posting: the posted tree matches its own trace, not the last one served.
{
  const two = createServer({ store: dir, policy, epsilon: 0.15, seed: 13 });
  await new Promise<void>((r) => two.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(two.address() as AddressInfo).port}`;
  const grab = async () => JSON.parse(/<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(await (await fetch(`${b}/u/reloader`)).text())![1].replace(/\\u003c/g, '<'));
  const first = await grab();
  const second = await grab();
  const rec = createRecorder({ user: 'reloader', session: 0, grammar: 'newsfeed@0.3.0', tree: first, now: () => 0 });
  rec.impression('sections[0].content.item', 'A'); rec.end();
  await fetch(`${b}/events`, { method: 'POST', body: JSON.stringify(rec.record()) });
  await new Promise<void>((r) => two.close(() => r()));
  const s2 = new SessionStore(dir);
  report(treeHash(first) !== treeHash(second) && !!s2.trace('reloader', 0, treeHash(first)) && !!s2.trace('reloader', 0, treeHash(second)), 'each load of a session keeps its own trace, matched to the posted tree by hash');
}

const r = trainReal({ store: dir, policy, epochs: 6, lr: 0.02 });
report(r.skippedNoTrace === 1 && r.skippedGreedy === 1 && r.usable === clients.sessions + 1, `train-real used ${r.usable} sessions; skipped ${r.skippedNoTrace} with no matching trace and ${r.skippedGreedy} served greedily`);

// Growth bound: one address cannot introduce unlimited new user ids, and
// invented ids never consume a slot of the posted-user cap.
{
  const postedBefore = new SessionStore(dir).postedUsers();
  const quota = createServer({ store: dir, policy, epsilon: 0.15, maxNewUsersPerAddressPerHour: 2, seed: 14 });
  await new Promise<void>((r) => quota.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(quota.address() as AddressInfo).port}`;
  const known = (await fetch(`${b}/u/${store.users()[0]}`)).status; // a user who has posted: unaffected
  const fresh = [(await fetch(`${b}/u/fresh-1`)).status, (await fetch(`${b}/u/fresh-2`)).status, (await fetch(`${b}/u/fresh-3`)).status];
  await new Promise<void>((r) => quota.close(() => r()));
  const postedAfter = new SessionStore(dir).postedUsers();
  report(known === 200 && fresh.join(',') === '200,200,429' && postedAfter === postedBefore, `new user ids are rate-limited per address, known users are not, and trace-only ids consume no posted-user slot (known ${known}; fresh ${fresh.join(',')}; posted ${postedBefore} -> ${postedAfter})`);
}

// The posted-user cap holds on posting too: a served-but-unposted user cannot push the count over it.
{
  const posted = new SessionStore(dir).postedUsers();
  const full = createServer({ store: dir, policy, epsilon: 0.15, maxUsers: posted, seed: 16 });
  await new Promise<void>((r) => full.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(full.address() as AddressInfo).port}`;
  const tree = new SessionStore(dir).sessions(store.users()[0])[0].tree;
  const mk = (user: string) => { const r = createRecorder({ user, session: 0, grammar: 'newsfeed@0.3.0', tree, now: () => 0 }); r.impression('sections[0].content.item', 'A'); r.end(); return r.record(); };
  const newcomer = (await fetch(`${b}/events`, { method: 'POST', body: JSON.stringify(mk('late-arrival')) })).status;
  const malformed = (await fetch(`${b}/events`, { method: 'POST', body: JSON.stringify({ user: 'late-arrival-2' }) })).status;
  const existing = (await fetch(`${b}/events`, { method: 'POST', body: JSON.stringify({ ...mk(store.users()[0]), session: 99 }) })).status;
  await new Promise<void>((r) => full.close(() => r()));
  report(newcomer === 429 && existing === 200 && malformed === 400 && new SessionStore(dir).postedUsers() === posted, `posting cannot exceed the posted-user cap, and a malformed record at the cap is still a 400 (newcomer ${newcomer}, existing ${existing}, malformed ${malformed}, posted ${posted} -> ${new SessionStore(dir).postedUsers()})`);
}

// Growth bound: a session cannot be served more than maxServesPerSession times before it is posted.
{
  const capped = createServer({ store: dir, policy, epsilon: 0.15, maxServesPerSession: 3, seed: 15 });
  await new Promise<void>((r) => capped.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(capped.address() as AddressInfo).port}`;
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await fetch(`${b}/u/flooder`)).status);
  await new Promise<void>((r) => capped.close(() => r()));
  report(statuses.join(',') === '200,200,200,429,429', `serving is bounded per session before it is posted (${statuses.join(',')})`);
}
report(r.epochs[0].meanWeight > 0.9 && r.epochs[0].meanWeight < 1.1, `importance weights start near 1 (${r.epochs[0].meanWeight.toFixed(3)})`);
report(r.epochs[r.epochs.length - 1].surrogate > r.epochs[0].surrogate + 1e-6, `the surrogate objective rises across epochs (${r.epochs[0].surrogate.toFixed(4)} -> ${r.epochs[r.epochs.length - 1].surrogate.toFixed(4)})`);
const after = evaluate();
report(after > before * 1.03, `training on stored sessions improves held-out simulated reward by >3% (${before.toFixed(2)} -> ${after.toFixed(2)})`);

const some = store.users().slice(0, 5).map((u) => store.sessions(u)[0]);
const cmp = compareSessions(some, 60, 3);
report(cmp.perSession.length === 5 && METRICS.every((m) => Number.isFinite(cmp.meanAbsZ[m])), `compare places ${cmp.perSession.length} sessions against simulated populations (mean |z| opens ${cmp.meanAbsZ.opens.toFixed(2)}, reward ${cmp.meanAbsZ.reward.toFixed(2)})`);

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} real-pipeline check(s) failed` : '\nreal-pipeline checks passed');
process.exit(failures ? 1 : 0);
