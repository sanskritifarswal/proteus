import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { SessionRecord } from '../events.ts';
import { fakeData } from '../fake-data.ts';
import { LiveContent, staticContent, type ContentProvider } from '../content/content.ts';
import { compareSessions, type Metric } from './compare.ts';
import { CALIBRATION_KEYS, IDENTITY, describeCalibration, type Calibration, type CalibrationFile } from '../sim/calibration.ts';
import { assemble, type ExportedRecord } from '../collect.ts';
import { SessionStore } from '../store.ts';

/**
 * Fit the population's five scales to real sessions.
 *
 * The objective is the systematic gap: for each compared metric, the mean
 * z-score of real sessions against the simulated population (compare.ts),
 * squared, averaged over the five metrics that a scale controls. Mean z
 * rather than mean |z| because a scale can only move the population as a
 * whole; per-session scatter is the archetypes' job, and chasing it with
 * five global numbers would fit noise. A ridge term pulls every scale
 * toward identity in log space, so with a handful of sessions the fit
 * moves only where the evidence is strong.
 *
 * Search is coordinate descent over multiplicative steps (additive for the
 * curiosity logit), shrinking the step when a round finds nothing. Every
 * evaluation simulates each real session's tree for `simUsers` synthetic
 * readers, so the cost is sessions × simUsers per evaluation.
 */
export const FIT_METRICS: Metric[] = ['dwellMin', 'completion', 'opens', 'scrollPast', 'actions'];

export interface CalibrateOptions {
  records: SessionRecord[];
  content?: ContentProvider;
  /** Simulated readers per real session per evaluation. Default 60. */
  simUsers?: number;
  /** Ridge weight on log-distance from identity. Default 0.05. */
  ridge?: number;
  /** Coordinate-descent rounds. Default 6. */
  rounds?: number;
  /** Bounds on the multiplicative scales; curiosity is bounded to ±2. */
  bounds?: [number, number];
  seed?: number;
  start?: Calibration;
  log?: (msg: string) => void;
}

export interface CalibrateResult {
  calibration: Calibration;
  before: { objective: number; meanZ: Record<Metric, number>; meanAbsZ: Record<Metric, number> };
  after: { objective: number; meanZ: Record<Metric, number>; meanAbsZ: Record<Metric, number> };
  evaluations: number;
}

function ridgePenalty(c: Calibration, ridge: number): number {
  let p = 0;
  for (const k of CALIBRATION_KEYS) p += k === 'curiosity' ? c[k] ** 2 : Math.log(c[k]) ** 2;
  return ridge * p;
}

export function calibrate(opts: CalibrateOptions): CalibrateResult {
  if (!opts.records.length) throw new Error('no sessions to calibrate against');
  const content = opts.content ?? staticContent(fakeData);
  const simUsers = opts.simUsers ?? 60;
  const ridge = opts.ridge ?? 0.05;
  const rounds = opts.rounds ?? 6;
  const [lo, hi] = opts.bounds ?? [0.2, 5];
  const seed = opts.seed ?? 1;
  const log = opts.log ?? (() => {});
  let evaluations = 0;

  const evaluate = (c: Calibration) => {
    evaluations++;
    const { meanZ, meanAbsZ } = compareSessions(opts.records, simUsers, seed, content, undefined, c);
    const gap = FIT_METRICS.reduce((s, m) => s + meanZ[m] ** 2, 0) / FIT_METRICS.length;
    return { objective: gap + ridgePenalty(c, ridge), meanZ, meanAbsZ };
  };

  let current = { ...(opts.start ?? IDENTITY) };
  const before = evaluate(current);
  let best = before;
  log(`start: ${describeCalibration(current)} → objective ${best.objective.toFixed(3)} (${FIT_METRICS.map((m) => `${m} ${before.meanZ[m] >= 0 ? '+' : ''}${before.meanZ[m].toFixed(2)}`).join(', ')})`);

  let step = 1.6;       // multiplicative step for scales
  let shift = 0.6;      // additive step for the curiosity logit
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (const k of CALIBRATION_KEYS) {
      const candidates: number[] = k === 'curiosity'
        ? [current[k] - shift, current[k] + shift].filter((v) => Math.abs(v) <= 2)
        : [current[k] / step, current[k] * step].filter((v) => v >= lo && v <= hi);
      for (const v of candidates) {
        const trial = { ...current, [k]: v };
        const r = evaluate(trial);
        if (r.objective < best.objective - 1e-6) { best = r; current = trial; improved = true; }
      }
    }
    log(`round ${round + 1}: ${describeCalibration(current)} → objective ${best.objective.toFixed(3)}${improved ? '' : ' (no move; halving the step)'}`);
    if (!improved) { step = Math.sqrt(step); shift /= 2; if (step < 1.05) break; }
  }
  return { calibration: current, before, after: best, evaluations };
}

if (process.argv[1] && basename(process.argv[1]) === 'calibrate.ts') {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const simUsers = Number(opt('users') ?? '60');
  const rounds = Number(opt('rounds') ?? '6');
  const ridge = Number(opt('ridge') ?? '0.05');
  const returnWindowDays = Number(opt('return-window-days') ?? '7');
  const out = opt('out') ?? 'out/calibration.json';
  if (!Number.isInteger(simUsers) || simUsers < 2 || !Number.isInteger(rounds) || rounds < 1 || !(ridge >= 0) || !(Number.isFinite(returnWindowDays) && returnWindowDays > 0)) {
    console.error('usage: node src/real/calibrate.ts [--store out/server | --file out/sessions.jsonl] [--content out/server/content.json] [--users 60] [--rounds 6] [--ridge 0.05] [--return-window-days 7] [--out out/calibration.json]');
    process.exit(2);
  }
  const returnWindowMs = returnWindowDays * 86_400_000;
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
  if (!records.length) { console.error('no sessions to calibrate against'); process.exit(1); }
  let content: ContentProvider | undefined;
  if (opt('content')) {
    const f = opt('content')!;
    if (!existsSync(f)) { console.error(`no content cache at ${f}`); process.exit(1); }
    const live = new LiveContent({ config: { feeds: ['http://cache.invalid/'] }, cacheFile: f });
    if (live.size === 0) { console.error(`${f} holds no articles`); process.exit(1); }
    content = live;
  }
  console.log(`${records.length} real session(s), ${simUsers} simulated readers per session per evaluation\n`);
  const result = calibrate({ records, content, simUsers, rounds, ridge, log: (m) => console.log(m) });
  const file: CalibrationFile = {
    calibration: result.calibration, fittedAt: new Date().toISOString(), sessions: records.length,
    before: Object.fromEntries(FIT_METRICS.map((m) => [m, result.before.meanZ[m]])),
    after: Object.fromEntries(FIT_METRICS.map((m) => [m, result.after.meanZ[m]])),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(file, null, 2) + '\n');
  console.log(`\n${'metric'.padEnd(12)} ${'mean z before'.padStart(14)} ${'mean z after'.padStart(14)}`);
  const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`.padStart(14);
  for (const m of FIT_METRICS) console.log(`${m.padEnd(12)} ${signed(result.before.meanZ[m])} ${signed(result.after.meanZ[m])}`);
  console.log(`\nobjective ${result.before.objective.toFixed(3)} → ${result.after.objective.toFixed(3)} in ${result.evaluations} evaluations`);
  console.log(`wrote ${out}: ${describeCalibration(result.calibration)}`);
  console.log(`use it: npm run compare -- --calibration ${out}; npm run serve -- --calibration ${out}; npm run train -- --calibration ${out}`);
}
