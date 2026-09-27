import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SessionRecord } from '../events.ts';
import { makeRng } from '../rng.ts';
import { fakeData } from '../fake-data.ts';
import { LiveContent, staticContent, type ContentProvider } from '../content/content.ts';
import { makePopulation } from '../sim/users.ts';
import { IDENTITY, loadCalibration, describeCalibration, type Calibration } from '../sim/calibration.ts';
import { simulateSession } from '../sim/simulate.ts';
import { sessionReward } from '../reward.ts';
import { assemble, type ExportedRecord } from '../collect.ts';
import { SessionStore } from '../store.ts';

/**
 * The sim-to-real gap, measured. For each real session, the same tree is
 * simulated for a synthetic population and the real user's per-session
 * metrics are placed against that distribution as z-scores. A metric whose
 * |z| is routinely large is one the simulator gets wrong for real people;
 * that is where calibration effort should go.
 *
 * usage: node src/real/compare.ts [--store out/server | --file out/sessions.jsonl] [--users 200] [--content out/server/content.json] [--return-window-days 7] [--calibration out/calibration.json]
 *
 * With --content, the simulated population reads the server's cached live
 * content (its current pool, not the pool each screen was served from)
 * instead of the fake data.
 */
export const METRICS = ['opens', 'completion', 'scrollPast', 'actions', 'dwellMin', 'reward'] as const;
export type Metric = typeof METRICS[number];
/** Smallest simulated standard deviation a z-score is taken against, per metric, in the metric's units. */
export const SD_FLOOR: Record<Metric, number> = { opens: 0.25, completion: 0.1, scrollPast: 0.5, actions: 0.25, dwellMin: 0.25, reward: 0.5 };

/**
 * How much of what real readers saw the content provider knows about: the
 * share of distinct articles in the sessions' events that resolve to a
 * topic. Sessions served with live content and compared against the fake
 * data resolve almost nothing, and the simulation would then be of
 * different articles than the readers had.
 */
export function contentCoverage(records: SessionRecord[], content: ContentProvider): { known: number; total: number } {
  const titles = new Set<string>();
  for (const r of records) for (const e of r.events) if ('article' in e && e.article) titles.add(e.article);
  let known = 0;
  for (const t of titles) if (content.topicOf(t) !== undefined) known++;
  return { known, total: titles.size };
}

/**
 * The content to simulate these sessions with, for a store: the server's
 * cached live pool (`<store>/content.json`) or the fake data, whichever
 * knows more of the articles the sessions mention. A store can hold a
 * cache from an earlier live run and sessions served with fake data
 * since, or the other way round; the sessions themselves say which.
 */
export function contentForStore(storeDir: string, records: SessionRecord[] = []): { content: ContentProvider; source: string } {
  const fake = { content: staticContent(fakeData), source: 'fake data' };
  const cache = join(storeDir, 'content.json');
  if (!existsSync(cache)) return fake;
  const live = new LiveContent({ config: { feeds: ['http://cache.invalid/'] }, cacheFile: cache });
  if (live.size === 0) return fake;
  const pool = { content: live, source: `live pool cached at ${cache} (${live.size} articles)` };
  const known = (c: ContentProvider) => contentCoverage(records, c).known;
  return known(pool.content) >= known(fake.content) ? pool : fake;
}

export function loadContentCache(file: string): ContentProvider {
  if (!existsSync(file)) throw new Error(`no content cache at ${file}; the server writes one under its store when run with --content`);
  const live = new LiveContent({ config: { feeds: ['http://cache.invalid/'] }, cacheFile: file });
  if (live.size === 0) throw new Error(`${file} holds no articles`);
  return live;
}

export function coverageWarning(records: SessionRecord[], content: ContentProvider, source: string): string | undefined {
  const c = contentCoverage(records, content);
  if (c.total === 0 || c.known / c.total >= 0.5) return undefined;
  return `warning: only ${c.known} of ${c.total} articles in these sessions are in the ${source}; the simulation is of different articles than the readers had (pass --content <store>/content.json, the pool they were served from)`;
}

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
/**
 * `only`, when given, restricts which sessions are simulated and reported;
 * every session still builds its reader's history (seen articles, session
 * count, personal feeds), so a reader's Nth session is compared as an Nth
 * session even when only recent ones are wanted.
 */
export function compareSessions(records: SessionRecord[], usersPerTree = 200, seed = 1, content: ContentProvider = staticContent(fakeData), only?: (s: SessionRecord) => boolean, calibration: Calibration = IDENTITY): { perSession: Comparison[]; meanAbsZ: Record<Metric, number>; meanZ: Record<Metric, number> } {
  if (!Number.isInteger(usersPerTree) || usersPerTree < 2) throw new Error(`usersPerTree must be an integer >= 2 (got ${usersPerTree})`);
  const perSession: Comparison[] = [];
  const byUser = new Map<string, SessionRecord[]>();
  for (const r of records) (byUser.get(r.user) ?? byUser.set(r.user, []).get(r.user)!).push(r);
  for (const list of byUser.values()) {
    list.sort((a, b) => a.session - b.session);
    const seen = new Set<string>();
    list.forEach((rec, idx) => {
      if (only && !only(rec)) { for (const e of rec.events) if (e.type === 'open') seen.add(e.article); return; }
      const pop = makePopulation(usersPerTree, makeRng(seed), undefined, calibration);
      // The feeds as this user would have had them: personal sections come from their earlier sessions.
      const data = content.forUser(list.slice(0, idx));
      const sims = pop.map((u, i) => metricsOf(simulateSession(u, rec.tree, data, rec.grammar, rec.session, { seen: new Set(seen), sessionsSoFar: idx }, makeRng(seed * 1000 + i))));
      const real = metricsOf(rec);
      const simMean = {} as Record<Metric, number>, simSd = {} as Record<Metric, number>, z = {} as Record<Metric, number>;
      for (const m of METRICS) {
        const xs = sims.map((s) => s[m]);
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
        // A floor on the simulated spread: a metric the population never produces
        // (every simulated reader takes zero actions, say) must still register
        // as a gap when a real reader produces it, not as z = 0.
        const floored = Math.max(sd, SD_FLOOR[m]);
        simMean[m] = mean; simSd[m] = sd; z[m] = (real[m] - mean) / floored;
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

if (process.argv[1] && basename(process.argv[1]) === 'compare.ts') {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const users = Number(opt('users') ?? '200');
  const returnWindowDays = Number(opt('return-window-days') ?? '7');
  if (!Number.isInteger(users) || users < 2 || !(Number.isFinite(returnWindowDays) && returnWindowDays > 0)) { console.error('usage: node src/real/compare.ts [--store dir | --file f] [--users <int>=2] [--content cache.json] [--return-window-days 7] [--calibration f]'); process.exit(2); }
  const returnWindowMs = returnWindowDays * 86_400_000;
  const calibration = opt('calibration') ? loadCalibration(opt('calibration')!) : IDENTITY;
  let records: SessionRecord[] = [];
  if (opt('file')) {
    const f = opt('file')!;
    if (!existsSync(f)) { console.error(`no such file: ${f}`); process.exit(1); }
    const raw = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExportedRecord);
    records = [...assemble(raw, { returnWindowMs }).values()].flat();
  } else {
    const store = new SessionStore(opt('store') ?? 'out/server', { returnWindowMs });
    records = store.users().flatMap((u) => store.sessions(u));
  }
  if (!records.length) { console.error('no sessions to compare'); process.exit(1); }
  let content: ContentProvider, source: string;
  if (opt('content')) {
    try { content = loadContentCache(opt('content')!); } catch (e) { console.error((e as Error).message); process.exit(1); }
    source = `content cache ${opt('content')}`;
  } else if (opt('file')) {
    content = staticContent(fakeData); source = 'fake data';
  } else {
    ({ content, source } = contentForStore(opt('store') ?? 'out/server', records));
  }
  const warning = coverageWarning(records, content, source);
  if (warning) console.error(warning);
  const { perSession, meanAbsZ, meanZ } = compareSessions(records, users, 1, content, undefined, calibration);
  console.log(`${records.length} real session(s), each against ${users} simulated users on the same tree, content: ${source}${opt('calibration') ? `, calibrated: ${describeCalibration(calibration)}` : ''}\n`);
  console.log(`${'user'.padEnd(14)} ${'s'.padStart(2)} ${METRICS.map((m) => m.padStart(14)).join('')}`);
  for (const c of perSession) console.log(`${c.user.padEnd(14)} ${String(c.session).padStart(2)} ${METRICS.map((m) => `${c.real[m].toFixed(1)} (${c.z[m] >= 0 ? '+' : ''}${c.z[m].toFixed(1)}σ)`.padStart(14)).join('')}`);
  console.log(`\n${'mean z'.padEnd(17)} ${METRICS.map((m) => `${meanZ[m] >= 0 ? '+' : ''}${meanZ[m].toFixed(2)}`.padStart(14)).join('')}`);
  console.log(`${'mean |z|'.padEnd(17)} ${METRICS.map((m) => meanAbsZ[m].toFixed(2).padStart(14)).join('')}`);
  console.log('\nreal value (z against the simulated population). |z| near 0: the simulator predicts this metric for this user; |z| >> 1: it does not.');
}
