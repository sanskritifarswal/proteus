import type { SessionRecord } from './events.ts';
import { sessionReward } from './reward.ts';
import { compareSessions, metricsOf, METRICS, type Metric } from './real/compare.ts';
import type { ContentProvider } from './content/content.ts';
import type { SessionStore } from './server.ts';

/**
 * What the operator wants to glance at daily while readers are on the
 * server: who came, how often, what the reward did across their sessions,
 * and how far the simulator is from them. Computed from the store on
 * request; the simulation part is cached until the store changes, because
 * it is the expensive bit.
 *
 * The number that matters is `rewardBySession`: mean reward at session
 * index 0, 1, 2... across readers. If the policy is learning the right
 * thing for real people, it rises.
 */
export interface UserStatus {
  user: string;
  sessions: number;
  firstAt: string | null;
  lastAt: string | null;
  meanReward: number;
  lastReward: number;
  /** Share of sessions with a known outcome that were followed by another. */
  returnRate: number | null;
  opensPerSession: number;
  completionPerSession: number;
  dwellMinPerSession: number;
}

export interface Status {
  computedAt: string;
  server: {
    startedAt: string;
    uptimeSec: number;
    policy: string;
    epsilon: number;
    store: { users: number; sessions: number; traces: number; skippedLines: number };
    content: ContentInfo;
  };
  totals: {
    sessions: number;
    users: number;
    meanReward: number | null;
    opensPerSession: number | null;
    completionPerSession: number | null;
    dwellMinPerSession: number | null;
    returnRate: number | null;
    returnKnown: number;
  };
  /** Mean reward by session index across readers: the learning curve on real people. */
  rewardBySession: Array<{ session: number; n: number; meanReward: number }>;
  users: UserStatus[];
  /** Sim-to-real gap on the most recent sessions, or null when skipped or there is nothing to compare. */
  sim: {
    sessions: number;
    simUsers: number;
    meanZ: Record<Metric, number>;
    meanAbsZ: Record<Metric, number>;
    computedAt: string;
    ms: number;
  } | null;
}

export interface ContentInfo {
  mode: 'fake' | 'live';
  pool?: number;
  fetchedAt?: string | null;
  errors?: Record<string, string>;
}

export interface StatusOptions {
  policy: string;
  epsilon: number;
  startedAt: number;
  content: ContentProvider;
  /** Simulated readers per real session for the gap. Default 50 (compare's CLI default is 200). */
  simUsers?: number;
  /** Most recent real sessions to simulate. Default 30. */
  recentSessions?: number;
  now?: () => number;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function endedAt(s: SessionRecord): number | null {
  if (!s.startedAt) return null;
  const t0 = Date.parse(s.startedAt);
  if (!Number.isFinite(t0)) return null;
  const last = s.events[s.events.length - 1];
  return t0 + (last?.t ?? 0);
}

function userStatus(user: string, sessions: SessionRecord[]): UserStatus {
  const rewards = sessions.map((s) => sessionReward(s));
  const metrics = sessions.map((s) => metricsOf(s));
  const known = sessions.filter((s) => s.returned !== null);
  const starts = sessions.map((s) => s.startedAt).filter((t): t is string => !!t);
  const ends = sessions.map((s) => endedAt(s)).filter((t): t is number => t !== null);
  return {
    user, sessions: sessions.length,
    firstAt: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
    lastAt: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    meanReward: mean(rewards) ?? 0,
    lastReward: rewards[rewards.length - 1] ?? 0,
    returnRate: known.length ? known.filter((s) => s.returned).length / known.length : null,
    opensPerSession: mean(metrics.map((m) => m.opens)) ?? 0,
    completionPerSession: mean(metrics.map((m) => m.completion)) ?? 0,
    dwellMinPerSession: mean(metrics.map((m) => m.dwellMin)) ?? 0,
  };
}

/** Computes status on demand; the simulation is cached until the store's sessions change. */
export class StatusReporter {
  private simCache: { key: string; value: Status['sim'] } | undefined;
  private readonly store: SessionStore;
  private readonly opts: StatusOptions;
  constructor(store: SessionStore, opts: StatusOptions) { this.store = store; this.opts = opts; }

  compute(o: { sim?: boolean; recent?: number } = {}): Status {
    const now = this.opts.now ?? Date.now;
    const users = this.store.users();
    const byUser = users.map((u) => ({ user: u, sessions: this.store.sessions(u) }));
    const all = byUser.flatMap((b) => b.sessions);
    const rewards = all.map((s) => sessionReward(s));
    const metrics = all.map((s) => metricsOf(s));
    const known = all.filter((s) => s.returned !== null);
    const bySession = new Map<number, number[]>();
    all.forEach((s, i) => (bySession.get(s.session) ?? bySession.set(s.session, []).get(s.session)!).push(rewards[i]));
    const describe = this.opts.content.describe?.() ?? { mode: 'fake' as const };
    return {
      computedAt: new Date(now()).toISOString(),
      server: {
        startedAt: new Date(this.opts.startedAt).toISOString(),
        uptimeSec: Math.round((now() - this.opts.startedAt) / 1000),
        policy: this.opts.policy, epsilon: this.opts.epsilon,
        store: { users: users.length, sessions: all.length, traces: this.store.traceCount(), skippedLines: this.store.skipped.length },
        content: describe,
      },
      totals: {
        sessions: all.length, users: users.length,
        meanReward: mean(rewards),
        opensPerSession: mean(metrics.map((m) => m.opens)),
        completionPerSession: mean(metrics.map((m) => m.completion)),
        dwellMinPerSession: mean(metrics.map((m) => m.dwellMin)),
        returnRate: known.length ? known.filter((s) => s.returned).length / known.length : null,
        returnKnown: known.length,
      },
      rewardBySession: [...bySession].sort((a, b) => a[0] - b[0]).map(([session, rs]) => ({ session, n: rs.length, meanReward: mean(rs)! })),
      users: byUser.map((b) => userStatus(b.user, b.sessions)).sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.user.localeCompare(b.user)),
      sim: o.sim === false ? null : this.simulate(all, o.recent ?? this.opts.recentSessions ?? 30, now),
    };
  }

  private simulate(all: SessionRecord[], recent: number, now: () => number): Status['sim'] {
    if (!all.length) return null;
    // Most recent by end time, falling back to store order; then keep a stable identity for the cache.
    const ordered = all.map((s, i) => ({ s, i, t: endedAt(s) ?? -1 })).sort((a, b) => b.t - a.t || b.i - a.i).slice(0, Math.max(1, recent)).map((x) => x.s);
    const key = ordered.map((s) => `${s.user}:${s.session}:${s.events.length}:${s.returned}`).join('|');
    if (this.simCache?.key === key) return this.simCache.value;
    const simUsers = this.opts.simUsers ?? 50;
    const t0 = now();
    const { meanZ, meanAbsZ } = compareSessions(ordered, simUsers, 1, this.opts.content);
    const value: Status['sim'] = { sessions: ordered.length, simUsers, meanZ, meanAbsZ, computedAt: new Date(now()).toISOString(), ms: now() - t0 };
    this.simCache = { key, value };
    return value;
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const f1 = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toFixed(1));
const f2 = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toFixed(2));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const when = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : '–');
const z = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

export function renderStatus(s: Status, userLink: (user: string) => string): string {
  const c = s.server.content;
  const contentLine = c.mode === 'live'
    ? `live, ${c.pool ?? 0} articles in pool, fetched ${when(c.fetchedAt ?? null)}${c.errors && Object.keys(c.errors).length ? `, <b>${Object.keys(c.errors).length} feed(s) failing</b>: ${Object.entries(c.errors).map(([u, e]) => `${esc(u)} (${esc(e)})`).join('; ')}` : ''}`
    : 'fake data';
  const curve = s.rewardBySession.length
    ? `<table><tr><th>session</th>${s.rewardBySession.map((r) => `<th>${r.session}</th>`).join('')}</tr><tr><td>mean reward</td>${s.rewardBySession.map((r) => `<td>${f2(r.meanReward)}</td>`).join('')}</tr><tr><td>readers</td>${s.rewardBySession.map((r) => `<td>${r.n}</td>`).join('')}</tr></table>`
    : '<p>No sessions yet.</p>';
  const sim = s.sim
    ? `<table><tr><th></th>${METRICS.map((m) => `<th>${m}</th>`).join('')}</tr><tr><td>mean z</td>${METRICS.map((m) => `<td>${z(s.sim!.meanZ[m])}</td>`).join('')}</tr><tr><td>mean |z|</td>${METRICS.map((m) => `<td>${f2(s.sim!.meanAbsZ[m])}</td>`).join('')}</tr></table>
<p class="note">${s.sim.sessions} most recent real session(s), each against ${s.sim.simUsers} simulated readers on the same tree, computed ${when(s.sim.computedAt)} in ${s.sim.ms} ms. |z| near 0: the simulator predicts this metric for real readers; |z| well above 1: it does not, and that is where calibration goes. Skip with <code>?sim=0</code>.</p>`
    : '<p class="note">Skipped (<code>?sim=0</code>) or nothing to compare.</p>';
  return `<!doctype html><meta charset="utf-8"><title>Proteus status</title>
<style>body{font-family:system-ui;padding:24px;max-width:980px;color:#111;background:#fff;margin:0 auto}table{border-collapse:collapse;margin:8px 0 16px}th,td{border:1px solid #ddd;padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums}th:first-child,td:first-child{text-align:left}th{background:#f4f4f6}.note{color:#555;font-size:13px}h2{margin-top:28px}</style>
<h1>Proteus status</h1>
<p class="note">${when(s.computedAt)} · up ${Math.round(s.server.uptimeSec / 60)} min · policy ${esc(s.server.policy)}${s.server.epsilon > 0 ? ` (ε ${s.server.epsilon})` : ''} · content ${contentLine} · store: ${s.server.store.users} reader(s), ${s.server.store.sessions} session(s), ${s.server.store.traces} trace(s)${s.server.store.skippedLines ? `, <b>${s.server.store.skippedLines} unreadable log line(s)</b>` : ''} · <a href="/status.json">json</a> · <a href="/">index</a></p>
<h2>Totals</h2>
<table><tr><th>sessions</th><th>readers</th><th>mean reward</th><th>opens/session</th><th>completion/session</th><th>dwell min/session</th><th>return rate</th></tr>
<tr><td>${s.totals.sessions}</td><td>${s.totals.users}</td><td>${f2(s.totals.meanReward)}</td><td>${f1(s.totals.opensPerSession)}</td><td>${f2(s.totals.completionPerSession)}</td><td>${f1(s.totals.dwellMinPerSession)}</td><td>${pct(s.totals.returnRate)} <span class="note">(${s.totals.returnKnown} known)</span></td></tr></table>
<h2>Reward by session index</h2>
${curve}
<p class="note">Mean reward across readers at their 1st, 2nd, 3rd… session. Rising means the policy is learning the right thing for real people; flat or falling means it is not, whatever the simulator says.</p>
<h2>Readers</h2>
<table><tr><th>reader</th><th>sessions</th><th>first</th><th>last</th><th>mean reward</th><th>last reward</th><th>opens</th><th>completion</th><th>dwell min</th><th>returned</th></tr>
${s.users.map((u) => `<tr><td><a href="${esc(userLink(u.user))}">${esc(u.user)}</a></td><td>${u.sessions}</td><td>${when(u.firstAt)}</td><td>${when(u.lastAt)}</td><td>${f2(u.meanReward)}</td><td>${f2(u.lastReward)}</td><td>${f1(u.opensPerSession)}</td><td>${f2(u.completionPerSession)}</td><td>${f1(u.dwellMinPerSession)}</td><td>${pct(u.returnRate)}</td></tr>`).join('\n')}
</table>
<h2>Simulator vs readers</h2>
${sim}
`;
}
