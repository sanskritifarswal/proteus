import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, SessionStore } from './server.ts';
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

const server = createServer({ store: dir, policy, epsilon: 0.15 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const clients = await runSyntheticClients({ base, users: 150, sessions: 4, seed: 7 });
await new Promise<void>((r) => server.close(() => r()));
report(clients.rejected === 0 && clients.sessions >= 150, `synthetic clients posted ${clients.sessions} sessions for ${clients.users} users with ${clients.rejected} rejected`);

const store = new SessionStore(dir);
report(store.traceCount() >= clients.sessions, `every served screen left a trace (${store.traceCount()} traces, ${clients.sessions} sessions)`);

// A session with no trace (served elsewhere): must be skipped, not trained on.
{
  const rec = createRecorder({ user: 'stranger', session: 0, grammar: 'newsfeed@0.3.0', tree: store.sessions(store.users()[0])[0].tree, now: () => 0 });
  rec.end();
  store.put(rec.record());
}

const r = trainReal({ store: dir, policy, epochs: 6, lr: 0.02 });
report(r.skippedNoTrace === 1 && r.usable === clients.sessions, `train-real used ${r.usable} traced sessions and skipped ${r.skippedNoTrace} without a trace`);
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
