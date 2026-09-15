import { makeRng } from '../rng.ts';
import { fakeData } from '../fake-data.ts';
import { makePopulation } from '../sim/users.ts';
import { simulateSession, type SimState } from '../sim/simulate.ts';
import type { UINode } from '../tree.ts';

/**
 * Synthetic users driving a running server the way a browser would: fetch
 * the user's screen, behave on it (with the simulator), and POST the record
 * to /events. Exercises the whole real-session pipeline (serve → trace →
 * record → store → train-real) without a human, so the plumbing is tested
 * before real people arrive. Says nothing about the sim-to-real gap.
 *
 * usage: node src/real/synthetic-clients.ts [--base http://127.0.0.1:8787] [--users 50] [--sessions 5] [--seed 1]
 */
export interface ClientsOptions {
  base: string;
  users: number;
  sessions: number;
  seed?: number;
  archetypes?: string[];
}

export async function runSyntheticClients(opts: ClientsOptions): Promise<{ users: number; sessions: number; rejected: number }> {
  const seed = opts.seed ?? 1;
  const pop = makePopulation(opts.users, makeRng(seed), opts.archetypes);
  let sessions = 0, rejected = 0;
  for (const [i, user] of pop.entries()) {
    const id = `${user.archetype}-${seed}-${i}`;
    const rng = makeRng(seed * 100_003 + i);
    const state: SimState = { seen: new Set(), sessionsSoFar: 0 };
    for (let s = 0; s < opts.sessions; s++) {
      const html = await (await fetch(`${opts.base}/u/${id}`)).text();
      const tree = JSON.parse(/<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(html)![1].replace(/\\u003c/g, '<')) as UINode;
      const cfg = JSON.parse(/data-proteus="([^"]*)"/.exec(html)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as { session: number; grammar: string };
      const rec = simulateSession(user, tree, fakeData, cfg.grammar, cfg.session, state, rng);
      const body = { user: id, session: cfg.session, grammar: cfg.grammar, tree, startedAt: new Date().toISOString(), events: rec.events, returned: null };
      const res = await fetch(`${opts.base}/events`, { method: 'POST', body: JSON.stringify(body) });
      if (res.status !== 200) rejected++; else sessions++;
      if (!rec.returned) break;
    }
  }
  return { users: pop.length, sessions, rejected };
}

if (process.argv[1] && process.argv[1].endsWith('synthetic-clients.ts')) {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const users = Number(opt('users', '50')), sessions = Number(opt('sessions', '5')), seed = Number(opt('seed', '1'));
  if (![users, sessions, seed].every(Number.isInteger) || users < 1 || sessions < 1) { console.error('usage: node src/real/synthetic-clients.ts [--base url] [--users <int>] [--sessions <int>] [--seed <int>]'); process.exit(2); }
  const r = await runSyntheticClients({ base: opt('base', 'http://127.0.0.1:8787'), users, sessions, seed });
  console.log(`${r.users} synthetic users, ${r.sessions} sessions posted, ${r.rejected} rejected`);
}
