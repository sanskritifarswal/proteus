import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from './events.ts';
import type { UIDocument } from './tree.ts';
import { makeRng } from './rng.ts';
import { fakeData } from './fake-data.ts';
import { makePopulation } from './sim/users.ts';
import { simulateSession } from './sim/simulate.ts';
import { IDENTITY, loadCalibration, validateCalibration, type Calibration } from './sim/calibration.ts';
import { calibrate } from './real/calibrate.ts';
import { compareSessions } from './real/compare.ts';

/**
 * Calibration recovers a known shift. "Real" sessions are produced by the
 * simulator itself with the population moved (dwell doubled, patience
 * halved); the fit, which only sees the sessions, must move its scales
 * the same way and shrink the gap. Sessions from the unmoved population
 * must leave the scales near identity. Plus the plumbing: a calibration
 * changes the population it is applied to, files round-trip, bad values
 * are refused.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const doc = JSON.parse(readFileSync('examples/valid/editorial-home.json', 'utf8')) as UIDocument;
const dense = JSON.parse(readFileSync('examples/valid/dense-list.json', 'utf8')) as UIDocument;

function realSessions(cal: Calibration, n: number, seed: number): SessionRecord[] {
  const pop = makePopulation(n, makeRng(seed), undefined, cal);
  return pop.map((u, i) => {
    const tree = i % 2 === 0 ? doc : dense;
    const s = simulateSession(u, tree.tree, fakeData, tree.grammar, 0, { seen: new Set(), sessionsSoFar: 0 }, makeRng(seed * 100 + i));
    return { ...s, user: `r${i}`, session: 0, returned: null };
  });
}

// --- Plumbing ---
{
  const base = makePopulation(20, makeRng(3));
  const moved = makePopulation(20, makeRng(3), undefined, { dwell: 2, readDepth: 1, curiosity: 0.5, patience: 0.5, social: 1 });
  const ratios = base.map((u, i) => moved[i].patience / u.patience).filter((r, i) => base[i].patience > 4.5);
  report(ratios.every((r) => Math.abs(r - 0.5) < 1e-9) && moved.every((u, i) => Math.abs(u.curiosity - base[i].curiosity - 0.5) < 1e-9 && u.dwellScale === 2), 'a calibration scales patience, shifts curiosity and sets dwellScale on every user, with the same draws');
  const s0 = simulateSession(base[0], doc.tree, fakeData, doc.grammar, 0, { seen: new Set(), sessionsSoFar: 0 }, makeRng(9));
  const s1 = simulateSession({ ...base[0], dwellScale: 2 }, doc.tree, fakeData, doc.grammar, 0, { seen: new Set(), sessionsSoFar: 0 }, makeRng(9));
  const dwellOf = (s: SessionRecord) => s.events.filter((e) => e.type === 'dwell').reduce((a, e) => a + (e as { value: number }).value, 0);
  report(dwellOf(s0) > 0 && Math.abs(dwellOf(s1) - 2 * dwellOf(s0)) <= s0.events.length, `dwellScale doubles simulated dwell (${dwellOf(s0)} → ${dwellOf(s1)} ms)`);
  report(validateCalibration({}).dwell === 1 && validateCalibration({ dwell: 1.5 }).dwell === 1.5 && validateCalibration({ curiosity: -0.3 }).curiosity === -0.3, 'validateCalibration fills identity and accepts partial objects');
  const rejects = (o: unknown) => { try { validateCalibration(o); return false; } catch { return true; } };
  report(rejects({ dwell: 0 }) && rejects({ patience: -1 }) && rejects({ social: Infinity }) && rejects({ readDepth: 'x' }) && rejects(null), 'non-positive, non-finite or non-numeric scales are refused');
  const dir = mkdtempSync(join(tmpdir(), 'proteus-cal-'));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ calibration: { dwell: 1.7, curiosity: -0.2 }, fittedAt: 'x' }));
  const loaded = loadCalibration(join(dir, 'c.json'));
  report(loaded.dwell === 1.7 && loaded.curiosity === -0.2 && loaded.patience === 1, 'a calibration file round-trips through loadCalibration');
  report((() => { try { loadCalibration(join(dir, 'missing.json')); return false; } catch { return true; } })(), 'a missing calibration file is an error');
  rmSync(dir, { recursive: true, force: true });
}

// --- Recovery of a known shift ---
{
  const truth: Calibration = { ...IDENTITY, dwell: 2, patience: 0.5 };
  const records = realSessions(truth, 32, 11);
  const gap = (cal: Calibration) => compareSessions(records, 40, 5, undefined, undefined, cal).meanZ;
  const gapBefore = gap(IDENTITY);
  report(gapBefore.dwellMin > 0.25 && gapBefore.scrollPast < -0.3, `sessions from the moved population show the gap as designed: dwell z ${gapBefore.dwellMin.toFixed(2)}, scrollPast z ${gapBefore.scrollPast.toFixed(2)}`);
  const t0 = Date.now();
  const r = calibrate({ records, simUsers: 40, rounds: 4, seed: 5, ridge: 0.02 });
  const c = r.calibration;
  report(c.dwell > 1.4 && c.patience < 0.8, `the fit moves the way the truth did: dwell ×${c.dwell.toFixed(2)} (truth ×2), patience ×${c.patience.toFixed(2)} (truth ×0.5), in ${r.evaluations} evaluations, ${Date.now() - t0} ms`);
  report(r.after.objective < r.before.objective && Math.abs(r.after.meanZ.dwellMin) < Math.abs(r.before.meanZ.dwellMin) && Math.abs(r.after.meanZ.scrollPast) < Math.abs(r.before.meanZ.scrollPast), `objective ${r.before.objective.toFixed(3)} → ${r.after.objective.toFixed(3)}; dwell z ${r.before.meanZ.dwellMin.toFixed(2)} → ${r.after.meanZ.dwellMin.toFixed(2)}, scrollPast z ${r.before.meanZ.scrollPast.toFixed(2)} → ${r.after.meanZ.scrollPast.toFixed(2)}`);
  report(Math.abs(c.readDepth - 1) < 0.7 && Math.abs(c.curiosity) < 0.8 && Math.abs(c.social - 1) < 0.8, `scales the truth did not move stay near identity: readDepth ×${c.readDepth.toFixed(2)}, curiosity ${c.curiosity >= 0 ? '+' : ''}${c.curiosity.toFixed(2)}, social ×${c.social.toFixed(2)}`);
  report(calibrate({ records, simUsers: 40, rounds: 4, seed: 5, ridge: 0.02 }).calibration.dwell === c.dwell, 'the fit is deterministic for a seed');
}

// --- No shift: the fit stays home ---
{
  const records = realSessions(IDENTITY, 32, 12);
  const r = calibrate({ records, simUsers: 40, rounds: 3, seed: 6 });
  const c = r.calibration;
  report(c.dwell > 0.6 && c.dwell < 1.7 && c.patience > 0.6 && c.patience < 1.7 && Math.abs(c.curiosity) < 0.7 && r.after.objective <= r.before.objective, `sessions from the unmoved population leave the scales near identity: dwell ×${c.dwell.toFixed(2)}, patience ×${c.patience.toFixed(2)}, curiosity ${c.curiosity >= 0 ? '+' : ''}${c.curiosity.toFixed(2)}; objective ${r.before.objective.toFixed(3)} → ${r.after.objective.toFixed(3)}`);
}

console.log(failures ? `\n${failures} calibration check(s) failed` : '\ncalibration checks passed');
process.exit(failures ? 1 : 0);
