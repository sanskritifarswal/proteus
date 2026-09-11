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
  const dismissals = trajectories.flatMap((t) => t.sessions).flatMap((s) => s.events).filter((e) => e.action === 'dismiss').length;
  report(dismissals === 0, 'a tree without dismiss buttons produces no dismiss events');
}

console.log(failures ? `\n${failures} simulator check(s) failed` : '\nsimulator checks passed');
process.exit(failures ? 1 : 0);
