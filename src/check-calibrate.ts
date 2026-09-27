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
import { compareSessions, contentCoverage, contentForStore, coverageWarning } from './real/compare.ts';
import { LiveContent, staticContent } from './content/content.ts';

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
  writeFileSync(join(dir, 'null.json'), 'null');
  report((() => { try { loadCalibration(join(dir, 'null.json')); return false; } catch (e) { return (e as Error).message.includes('calibration must be an object'); } })(), 'a calibration file holding null gets the validation error, not a TypeError');
  rmSync(dir, { recursive: true, force: true });
  report((() => { try { calibrate({ records: realSessions(IDENTITY, 2, 1), ridge: Infinity, simUsers: 4, rounds: 1 }); return false; } catch { return true; } })() && (() => { try { calibrate({ records: realSessions(IDENTITY, 2, 1), ridge: -1, simUsers: 4, rounds: 1 }); return false; } catch { return true; } })(), 'an infinite or negative ridge is refused');

  // Zero simulated variance must not hide a real gap: on a tree with no
  // buttons the simulator can never act, so its action spread is exactly 0;
  // a real reader's action on it must still score.
  const noButtons: UIDocument = { grammar: doc.grammar, tree: { type: 'Screen', props: { density: 'compact' }, slots: { sections: [{ type: 'Section', props: { source: 'topStories' }, slots: { content: { type: 'Collection', props: { layout: 'stack', limit: '5' }, slots: { item: { type: 'Card', props: { variant: 'compact' }, slots: { title: { type: 'Text', props: { role: 'title', maxLines: '2' }, bind: 'title' } } } } } } }] } } };
  const acted: SessionRecord = { user: 'a', session: 0, grammar: doc.grammar, tree: noButtons.tree, returned: null, events: [
    { t: 0, type: 'impression', path: 'sections[0].content.item', article: 'City council approves new bike lane network' },
    { t: 100, type: 'open', path: 'sections[0].content.item', article: 'City council approves new bike lane network' },
    { t: 30_100, type: 'dwell', path: 'sections[0].content.item', article: 'City council approves new bike lane network', value: 30_000 },
    { t: 30_100, type: 'complete', path: 'sections[0].content.item', article: 'City council approves new bike lane network', value: 0.8 },
    { t: 30_200, type: 'action', path: 'sections[0].content.item', action: 'save', article: 'City council approves new bike lane network' },
    { t: 31_000, type: 'session_end', path: '' },
  ] };
  const mute = compareSessions([acted], 30, 4);
  const c = mute.perSession[0];
  report(c.simSd.actions === 0 && c.simMean.actions === 0 && c.z.actions === 4, `with a population that cannot act (sim sd 0), a real action registers as z ${c.z.actions.toFixed(2)} (1 action over the 0.25 floor), not 0`);

  // Content coverage: sessions on fake articles are fully covered by the fake data; invented titles are not.
  const fakeCov = contentCoverage(realSessions(IDENTITY, 6, 22), staticContent());
  const foreign = realSessions(IDENTITY, 6, 22).map((r) => ({ ...r, events: r.events.map((e) => ('article' in e && e.article ? { ...e, article: `elsewhere: ${e.article}` } : e)) as SessionRecord['events'] }));
  const foreignCov = contentCoverage(foreign, staticContent());
  report(fakeCov.total > 0 && fakeCov.known === fakeCov.total && foreignCov.known === 0 && coverageWarning(foreign, staticContent(), 'fake data')?.startsWith('warning:') === true && coverageWarning(realSessions(IDENTITY, 6, 22), staticContent(), 'fake data') === undefined, `content coverage: ${fakeCov.known}/${fakeCov.total} known on matching content, ${foreignCov.known}/${foreignCov.total} on foreign titles, and only the latter warns`);

  // A store holding a live cache: the sessions decide which content is simulated,
  // and a provider rebuilt from the cache keeps the serving limits.
  const storeDir = mkdtempSync(join(tmpdir(), 'proteus-calstore-'));
  const rss = `<rss version="2.0"><channel><title>Pool</title>${Array.from({ length: 6 }, (_, i) => `<item><title>Pooled story ${i}</title><link>https://pool.example/${i}</link><description>Body ${i}.</description><pubDate>Tue, 15 Sep 2026 0${i}:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
  const served = new LiveContent({ config: { feeds: ['https://pool.example/rss'], perFeed: 2 }, cacheFile: join(storeDir, 'content.json'), fetchText: async () => rss, now: () => Date.parse('2026-09-16T00:00:00Z') });
  await served.refresh();
  const onFake = realSessions(IDENTITY, 4, 23);
  const onPool = onFake.map((r) => ({ ...r, events: r.events.map((e, i) => ('article' in e && e.article ? { ...e, article: `Pooled story ${i % 6}` } : e)) as SessionRecord['events'] }));
  const pickFake = contentForStore(storeDir, onFake);
  const pickPool = contentForStore(storeDir, onPool);
  report(pickFake.source === 'fake data' && pickPool.source.startsWith('live pool cached'), `a stale live cache is not chosen over the fake data the sessions were served with (fake-served → ${pickFake.source}; pool-served → ${pickPool.source.slice(0, 16)}…)`);
  const rebuilt = pickPool.content.forUser([]);
  report(rebuilt.feeds.topStories.articles.length === 2 && served.forUser([]).feeds.topStories.articles.length === 2, `a provider rebuilt from the cache keeps the serving perFeed limit (${rebuilt.feeds.topStories.articles.length} of 6 pooled stories in Top Stories, as served)`);
  const restarted = new LiveContent({ config: { feeds: ['https://pool.example/rss'] }, cacheFile: join(storeDir, 'content.json') });
  report(restarted.forUser([]).feeds.topStories.articles.length === 6, 'a serving server whose config dropped perFeed gets the default back, not the cached limit');
  writeFileSync(join(storeDir, 'content.json'), JSON.stringify({ articles: {} }));
  const malformed = new LiveContent({ config: { feeds: ['https://pool.example/rss'] }, cacheFile: join(storeDir, 'content.json') });
  report(malformed.size === 0, 'a cache with valid JSON but the wrong shape is ignored, not fatal');
  rmSync(storeDir, { recursive: true, force: true });
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
