import { existsSync, readFileSync } from 'node:fs';
import type { SessionRecord } from '../events.ts';
import { makeRng } from '../rng.ts';
import { fakeData } from '../fake-data.ts';
import { makePopulation } from '../sim/users.ts';
import { simulateSession } from '../sim/simulate.ts';
import { sessionReward } from '../reward.ts';
import { SessionStore } from '../server.ts';
import { assemble, type ExportedRecord } from '../collect.ts';

/**
 * The sim-to-real gap, measured. For each real session, the same tree is
 * simulated for a synthetic population and the real user's per-session
 * metrics are placed against that distribution as z-scores. A metric whose
 * |z| is routinely large is one the simulator gets wrong for real people;
 * that is where calibration effort should go.
 *
 * usage: node src/real/compare.ts [--store out/server | --file out/sessions.jsonl] [--users 200]
 */
export const METRICS = ['opens', 'completion', 'scrollPast', 'actions', 'dwellMin', 'reward'] as const;
export type Metric = typeof METRICS[number];

export function metricsOf(s: SessionRecord): Record<Metric, number> {
  let opens = 0, completion = 0, scrollPast = 0, actions = 0, dwellMs = 0;
  for (const e of s.events) {
    switch (e.type) {
      case 'open': opens++; break;
      case 'complete': completion += e.value; break;
      case 'scroll_past': scrollPast++; break;
      case 'action': if (e.action !== 'dismiss') actions++; break;
      case 'dwell': dwellMs += e.value; break;
    }
  }
  return { opens, completion, scrollPast, actions, dwellMin: dwellMs / 60000, reward: sessionReward(s) };
}

export interface Comparison {
  user: string;
  session: number;
  real: Record<Metric, number>;
  simMean: Record<Metric, number>;
  simSd: Record<Metric, number>;
  z: Record<Metric, number>;
}

/**
 * A returning user's session is compared against simulated users who carry
 * that user's own history: the articles they opened in earlier real
 * sessions are already "seen" (the simulator opens seen articles less), and
 * the session index matches. Records are grouped by user and ordered.
 */
export function compareSessions(records: SessionRecord[], usersPerTree = 200, seed = 1): { perSession: Comparison[]; meanAbsZ: Record<Metric, number>; meanZ: Record<Metric, number> } {
  if (!Number.isInteger(usersPerTree) || usersPerTree < 2) throw new Error(`usersPerTree must be an integer >= 2 (got ${usersPerTree})`);
  const perSession: Comparison[] = [];
  const byUser = new Map<string, SessionRecord[]>();
  for (const r of records) (byUser.get(r.user) ?? byUser.set(r.user, []).get(r.user)!).push(r);
  for (const list of byUser.values()) {
    list.sort((a, b) => a.session - b.session);
    const seen = new Set<string>();
    list.forEach((rec, idx) => {
      const pop = makePopulation(usersPerTree, makeRng(seed));
      const sims = pop.map((u, i) => metricsOf(simulateSession(u, rec.tree, fakeData, rec.grammar, rec.session, { seen: new Set(seen), sessionsSoFar: idx }, makeRng(seed * 1000 + i))));
      const real = metricsOf(rec);
      const simMean = {} as Record<Metric, number>, simSd = {} as Record<Metric, number>, z = {} as Record<Metric, number>;
      for (const m of METRICS) {
        const xs = sims.map((s) => s[m]);
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
        simMean[m] = mean; simSd[m] = sd; z[m] = sd > 0 ? (real[m] - mean) / sd : 0;
      }
      perSession.push({ user: rec.user, session: rec.session, real, simMean, simSd, z });
      for (const e of rec.events) if (e.type === 'open') seen.add(e.article);
    });
  }
  const meanAbsZ = {} as Record<Metric, number>, meanZ = {} as Record<Metric, number>;
  for (const m of METRICS) {
    meanAbsZ[m] = perSession.length ? perSession.reduce((a, c) => a + Math.abs(c.z[m]), 0) / perSession.length : 0;
    meanZ[m] = perSession.length ? perSession.reduce((a, c) => a + c.z[m], 0) / perSession.length : 0;
  }
  return { perSession, meanAbsZ, meanZ };
}

if (process.argv[1] && process.argv[1].endsWith('compare.ts')) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const users = Number(opt('users') ?? '200');
  if (!Number.isInteger(users) || users < 2) { console.error('usage: node src/real/compare.ts [--store dir | --file f] [--users <int>=2]'); process.exit(2); }
  let records: SessionRecord[] = [];
  if (opt('file')) {
    const f = opt('file')!;
    if (!existsSync(f)) { console.error(`no such file: ${f}`); process.exit(1); }
    const raw = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExportedRecord);
    records = [...assemble(raw).values()].flat();
  } else {
    const store = new SessionStore(opt('store') ?? 'out/server');
    records = store.users().flatMap((u) => store.sessions(u));
  }
  if (!records.length) { console.error('no sessions to compare'); process.exit(1); }
  const { perSession, meanAbsZ, meanZ } = compareSessions(records, users);
  console.log(`${records.length} real session(s), each against ${users} simulated users on the same tree\n`);
  console.log(`${'user'.padEnd(14)} ${'s'.padStart(2)} ${METRICS.map((m) => m.padStart(14)).join('')}`);
  for (const c of perSession) console.log(`${c.user.padEnd(14)} ${String(c.session).padStart(2)} ${METRICS.map((m) => `${c.real[m].toFixed(1)} (${c.z[m] >= 0 ? '+' : ''}${c.z[m].toFixed(1)}σ)`.padStart(14)).join('')}`);
  console.log(`\n${'mean z'.padEnd(17)} ${METRICS.map((m) => `${meanZ[m] >= 0 ? '+' : ''}${meanZ[m].toFixed(2)}`.padStart(14)).join('')}`);
  console.log(`${'mean |z|'.padEnd(17)} ${METRICS.map((m) => meanAbsZ[m].toFixed(2).padStart(14)).join('')}`);
  console.log('\nreal value (z against the simulated population). |z| near 0: the simulator predicts this metric for this user; |z| >> 1: it does not.');
}
