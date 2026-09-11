import { makeRng } from './rng.ts';
import { fakeData } from './fake-data.ts';
import { nodePaths } from './tree.ts';
import { makePopulation } from './sim/users.ts';
import { fixedScreenPolicy, loadExample, randomScreenPolicy, runEpisodes } from './sim/episodes.ts';

/**
 * Simulator sanity checks: deterministic per seed, every event names a real
 * node, rewards are finite, and preferences visibly move the reward in the
 * direction they should. A simulator that fails the last one cannot tell
 * policies apart and is not worth training against.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// Determinism.
{
  const pop = () => makePopulation(20, makeRng(5));
  const a = JSON.stringify(runEpisodes(randomScreenPolicy('local'), pop(), fakeData, 4, 9).trajectories);
  const b = JSON.stringify(runEpisodes(randomScreenPolicy('local'), pop(), fakeData, 4, 9).trajectories);
  const c = JSON.stringify(runEpisodes(randomScreenPolicy('local'), pop(), fakeData, 4, 10).trajectories);
  report(a === b && a !== c, 'simulation is deterministic per seed and differs across seeds');
}

// Every event path exists in the tree it was recorded on; rewards finite.
{
  const { trajectories, stats } = runEpisodes(randomScreenPolicy('local'), makePopulation(60, makeRng(2)), fakeData, 5, 3);
  let badPaths = 0;
  let events = 0;
  for (const t of trajectories) for (const s of t.sessions) {
    const paths = nodePaths(s.tree);
    for (const e of s.events) { events++; if (!paths.has(e.path)) badPaths++; }
  }
  report(badPaths === 0, `every event names a node in its tree (${events} events, ${badPaths} bad)`);
  report(Number.isFinite(stats.meanEpisodeReward) && stats.sessions > 0, `rewards are finite (mean episode reward ${stats.meanEpisodeReward.toFixed(2)})`);
}

// Preferences move the reward: power readers should do better on the dense
// list, browsers on the editorial home with hero images.
{
  const dense = fixedScreenPolicy(loadExample('dense-list'));
  const editorial = fixedScreenPolicy(loadExample('editorial-home'));
  const N = 400;
  const power = makePopulation(N, makeRng(21), 'power-reader');
  const browsers = makePopulation(N, makeRng(22), 'browser');
  const pd = runEpisodes(dense, power, fakeData, 6, 7).stats.meanEpisodeReward;
  const pe = runEpisodes(editorial, power, fakeData, 6, 7).stats.meanEpisodeReward;
  const bd = runEpisodes(dense, browsers, fakeData, 6, 7).stats.meanEpisodeReward;
  const be = runEpisodes(editorial, browsers, fakeData, 6, 7).stats.meanEpisodeReward;
  report(pd > pe, `power readers prefer dense-list (${pd.toFixed(2)}) over editorial-home (${pe.toFixed(2)})`);
  report(be > bd, `browsers prefer editorial-home (${be.toFixed(2)}) over dense-list (${bd.toFixed(2)})`);
}

// Availability matters: with no dismiss button anywhere, no dismiss events.
{
  const { trajectories } = runEpisodes(fixedScreenPolicy(loadExample('editorial-home')), makePopulation(50, makeRng(3)), fakeData, 3, 4);
  const dismissals = trajectories.flatMap((t) => t.sessions).flatMap((s) => s.events).filter((e) => e.type === 'action' && e.action === 'dismiss').length;
  report(dismissals === 0, 'a tree without dismiss buttons produces no dismiss events');
}

// Censoring: the last session of a capped episode never claims an observed return.
{
  const { trajectories, stats } = runEpisodes(fixedScreenPolicy(loadExample('dense-list')), makePopulation(80, makeRng(6)), fakeData, 3, 5);
  const capped = trajectories.filter((t) => t.sessions.length === 3);
  const leaked = capped.filter((t) => t.sessions[2].returned !== null).length;
  const early = trajectories.filter((t) => t.sessions.length < 3).every((t) => t.sessions.at(-1)!.returned === false);
  report(capped.length > 0 && leaked === 0 && early && stats.observedSessions === stats.sessions - capped.length, `outcomes at the session cap are censored either way (${capped.length} capped episodes, ${leaked} leaked; ${stats.observedSessions}/${stats.sessions} observed)`);
}

// Footers: a footer action only ever follows an impression of that footer.
{
  const { trajectories } = runEpisodes(randomScreenPolicy('local'), makePopulation(80, makeRng(8)), fakeData, 4, 12);
  let footerActions = 0;
  let unseen = 0;
  for (const t of trajectories) for (const s of t.sessions) {
    const seen = new Set<string>();
    for (const e of s.events) {
      if (e.type === 'impression') seen.add(e.path);
      if (e.type === 'action' && e.path.endsWith('.footer')) { footerActions++; if (!seen.has(e.path)) unseen++; }
    }
  }
  report(footerActions > 0 && unseen === 0, `footer actions only on footers the user reached (${footerActions} actions, ${unseen} unseen)`);
}

// Empty population is rejected instead of producing NaN.
{
  let threw = false;
  try { runEpisodes(randomScreenPolicy('local'), [], fakeData, 3, 1); } catch { threw = true; }
  report(threw, 'empty population is rejected');
}

console.log(failures ? `\n${failures} simulator check(s) failed` : '\nsimulator checks passed');
process.exit(failures ? 1 : 0);
