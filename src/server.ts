import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { UIDocument } from './tree.ts';
import type { SessionRecord } from './events.ts';
import { makeRng } from './rng.ts';
import { localUniform, sample, type Decision, type Policy } from './sample.ts';
import { newsfeed } from './grammars/newsfeed.ts';
import { LiveContent, loadContentConfig, staticContent, type ContentProvider } from './content/content.ts';
import { renderPage } from './render-html.ts';
import { sessionReward } from './reward.ts';
import { stateFromHistory, STATE_NAMES } from './policy/features.ts';
import { LinearPolicy } from './policy/linear-policy.ts';
import { MlpPolicy } from './policy/mlp-policy.ts';
import type { PolicyModel, Step, Trace } from './policy/model.ts';
import { assemble, validateRecord, type ExportedRecord } from './collect.ts';

/**
 * The smallest server that closes the loop without copy-paste.
 *
 *   GET  /                 index of users seen so far
 *   GET  /u/<user>         the next instrumented screen for that user, chosen
 *                          by the policy from their stored sessions; the page
 *                          beacons its record to /events
 *   POST /events           a session record from the page (snapshot on hide,
 *                          final on leave); validated, stored, deduplicated
 *   GET  /sessions/<user>  that user's assembled sessions with reward and
 *                          next-session state, as JSON
 *   GET  /export.jsonl     every current session, one per line: the raw export
 *
 * Storage is an append-only JSONL log. A session is identified by
 * (user, session); when several records arrive for one, the one with the
 * most events wins, since the page only ever appends events, so a final
 * record supersedes the snapshots that preceded it and a late snapshot
 * cannot undo a final.
 *
 * Authentication, when a token is set: operator routes (/, /sessions,
 * /export.jsonl, /link) need `Authorization: Bearer <token>`; a user's
 * screen URL carries an HMAC of the user id under the token
 * (/u/<user>?k=<sig>), which the page also sends with its records, so a
 * link cannot be guessed and a poster can only post for the user their
 * link names. Without a token everything is open and the server refuses
 * to bind anywhere but loopback. No dependencies.
 */
export interface ServerOptions {
  store: string;
  policy: PolicyModel | 'random' | UIDocument;
  maxBodyBytes?: number;
  /**
   * Exploration when serving with a learned policy: 0 serves greedily,
   * > 0 samples from (1-ε)·policy + ε·uniform. Training from real
   * sessions needs the sampling probabilities, so serve with ε > 0 and
   * the trace of every served screen is recorded alongside it.
   */
  epsilon?: number;
  /**
   * Bounds on what an unauthenticated caller can make the store grow by.
   * maxServesPerSession: screens served for one (user, session) before it
   * is posted. maxUsers: users who have posted at least one session (a
   * trace-only id does not consume a slot, so invented ids cannot exhaust
   * it). maxNewUsersPerAddressPerHour: first-time user ids one remote
   * address may introduce in a sliding hour, which is what bounds trace
   * growth from invented ids. None of this is authentication; exposure
   * beyond loopback still needs some.
   */
  maxServesPerSession?: number;
  maxUsers?: number;
  maxNewUsersPerAddressPerHour?: number;
  /**
   * Shared secret. Set it to expose the server beyond loopback: operator
   * routes require it as a bearer token and user links are signed with it.
   */
  token?: string;
  /**
   * Behind a tunnel or reverse proxy you control, every client arrives from
   * the proxy's address, so failure counting by socket address would let
   * one caller's bad requests lock out everyone. With trustProxy the client
   * address is taken from the first X-Forwarded-For entry instead. Only set
   * it when the proxy overwrites that header; otherwise it is spoofable.
   */
  trustProxy?: boolean;
  /**
   * Exploration seed. Unset (production): every serve draws from the OS
   * random source, so exploration is never correlated across users or
   * predictable. Set (tests): serves are seeded from this number and a
   * per-server counter, so a run is repeatable.
   */
  seed?: number;
  /**
   * What fills the screen's feeds for each user. Default: the fake data,
   * the same for everyone. Live syndicated content with personal feeds
   * derived from the user's actions: see src/content/content.ts.
   */
  content?: ContentProvider;
}

/** Identity of a served tree, so a posted record can be matched to the trace of the screen it came from. */
export function treeHash(tree: unknown): string {
  return createHash('sha256').update(JSON.stringify(tree)).digest('hex').slice(0, 16);
}

/** A served screen's decision trace, serialised for the store. */
export interface StoredTrace {
  user: string;
  session: number;
  /** Hash of the served tree. A user may load a session's screen more than once before posting; each load is a different tree and its own trace. */
  treeHash: string;
  steps: Array<{
    decision: Pick<Decision, 'kind' | 'path' | 'component' | 'context' | 'options'>;
    keys: string[];
    probs: number[];
    sampled: number[];
    epsilon: number;
    chosen: number;
    rawState: number[];
  }>;
}


export class SessionStore {
  private readonly current = new Map<string, ExportedRecord>();
  private readonly traceMap = new Map<string, StoredTrace>();
  /** Screens served per (user, session), for the growth bound. */
  private readonly serves = new Map<string, number>();
  private readonly logFile: string;
  private readonly traceFile: string;
  /** Log lines that could not be loaded, with reasons. */
  readonly skipped: string[] = [];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logFile = join(dir, 'events.jsonl');
    this.traceFile = join(dir, 'traces.jsonl');
    if (existsSync(this.traceFile)) {
      readFileSync(this.traceFile, 'utf8').split('\n').forEach((line, i) => {
        if (!line) return;
        try { const t = JSON.parse(line) as StoredTrace; this.traceMap.set(`${t.user}:${t.session}:${t.treeHash}`, t); this.serves.set(`${t.user}:${t.session}`, (this.serves.get(`${t.user}:${t.session}`) ?? 0) + 1); } catch { this.skipped.push(`traces line ${i + 1}: not JSON`); }
      });
    }
    if (existsSync(this.logFile)) {
      const lines = readFileSync(this.logFile, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line) return;
        // An interrupted append can leave a partial trailing line. Skip
        // what cannot be parsed or validated rather than refusing to start.
        let rec: unknown;
        try { rec = JSON.parse(line); } catch { this.skipped.push(`line ${i + 1}: not JSON`); return; }
        const errors = validateRecord(rec);
        if (errors.length) { this.skipped.push(`line ${i + 1}: ${errors[0]}`); return; }
        this.absorb(rec as ExportedRecord);
      });
      if (this.skipped.length) console.error(`store: skipped ${this.skipped.length} unreadable log line(s): ${this.skipped.join('; ')}`);
    }
  }

  /** More events wins; at equal length, the later session end wins (a final after a quiet snapshot). */
  private absorb(rec: ExportedRecord): boolean {
    const k = `${rec.user}:${rec.session}`;
    const have = this.current.get(k);
    if (have) {
      const lastT = (r: ExportedRecord) => (r.events.length ? r.events[r.events.length - 1].t : -1);
      if (have.events.length > rec.events.length) return false;
      if (have.events.length === rec.events.length && lastT(have) >= lastT(rec)) return false;
    }
    this.current.set(k, rec);
    return true;
  }

  /** Validate, log, and absorb. Returns the validation errors (empty on success) and whether it replaced the current record. */
  put(rec: unknown): { errors: string[]; replaced: boolean } {
    const errors = validateRecord(rec);
    if (errors.length) return { errors, replaced: false };
    appendFileSync(this.logFile, JSON.stringify(rec) + '\n');
    return { errors: [], replaced: this.absorb(rec as ExportedRecord) };
  }

  users(): string[] { return [...new Set([...this.current.values()].map((r) => r.user))].sort(); }

  records(user?: string): ExportedRecord[] {
    return [...this.current.values()].filter((r) => user === undefined || r.user === user).sort((a, b) => a.user.localeCompare(b.user) || a.session - b.session);
  }

  sessions(user: string): SessionRecord[] { return assemble(this.records(user)).get(user) ?? []; }

  /** Record the decision trace of a served screen, keyed by the tree it served. */
  putTrace(t: StoredTrace): void {
    appendFileSync(this.traceFile, JSON.stringify(t) + '\n');
    this.traceMap.set(`${t.user}:${t.session}:${t.treeHash}`, t);
    this.serves.set(`${t.user}:${t.session}`, (this.serves.get(`${t.user}:${t.session}`) ?? 0) + 1);
  }

  /** The trace of the screen a record came from: same user, session and tree. */
  trace(user: string, session: number, hash: string): StoredTrace | undefined { return this.traceMap.get(`${user}:${session}:${hash}`); }
  traceCount(): number { return this.traceMap.size; }
  servesFor(user: string, session: number): number { return this.serves.get(`${user}:${session}`) ?? 0; }
  /** Users who have posted at least one session. */
  postedUsers(): number { return new Set([...this.current.values()].map((r) => r.user)).size; }
  hasPosted(user: string): boolean { for (const r of this.current.values()) if (r.user === user) return true; return false; }
  /** Has this user ever been served or posted? */
  known(user: string): boolean {
    for (const r of this.current.values()) if (r.user === user) return true;
    for (const t of this.traceMap.values()) if (t.user === user) return true;
    return false;
  }
}

function serialiseTrace(user: string, session: number, tree: unknown, trace: Trace, decisions: Decision[]): StoredTrace {
  return {
    user, session, treeHash: treeHash(tree),
    steps: trace.steps.map((st: Step, i) => ({
      decision: { kind: decisions[i].kind, path: decisions[i].path, component: decisions[i].component, context: decisions[i].context, options: decisions[i].options },
      keys: st.keys, probs: [...st.probs], sampled: [...st.sampled], epsilon: st.epsilon, chosen: st.chosen, rawState: [...st.rawState],
    })),
  };
}

export function loadPolicyFile(file: string): PolicyModel {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  return json.model === 'mlp' ? MlpPolicy.fromJSON(json) : LinearPolicy.fromJSON(json);
}

export function nextScreen(store: SessionStore, user: string, policy: ServerOptions['policy'], epsilon = 0, seed?: number, topicOf?: (title: string) => string | undefined): { doc: UIDocument; session: number; how: string; trace?: StoredTrace } {
  const history = store.sessions(user);
  const rewards = history.map((s) => sessionReward(s));
  const session = history.length ? history[history.length - 1].session + 1 : 0;
  if (policy === 'random') return { doc: sample(newsfeed, localUniform(makeRng(session * 7919 + user.length))), session, how: 'random' };
  if ('grammar' in policy) return { doc: policy, session, how: 'fixed' };
  const state = stateFromHistory(history, rewards, topicOf);
  // A fresh, unpredictable seed per serve unless a seed was given: exploration
  // must not be correlated across users, and the trace records what was
  // sampled anyway.
  const rng = makeRng(seed ?? randomInt(0, 2 ** 31));
  const trace: Trace = { steps: [] };
  const decisions: Decision[] = [];
  const inner = policy.forState(state, rng, trace, epsilon === 0, epsilon);
  const recording: Policy = (d) => { decisions.push(d); return inner(d); };
  const doc = sample(newsfeed, recording);
  return { doc, session, how: `${policy.name} policy${epsilon > 0 ? ` (ε ${epsilon})` : ' (greedy)'}, ${history.length} prior session(s)`, trace: serialiseTrace(user, session, doc.tree, trace, decisions) };
}

/** Signature of a user id under the token: the `k` in a user's link. */
export function signUser(token: string, user: string): string {
  return createHmac('sha256', token).update(`user:${user}`).digest('hex').slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A non-loopback host without a token would hand out every session to anyone who can reach the port. */
export function assertExposable(host: string, token: string | undefined): void {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !token) throw new Error(`refusing to bind to ${host} without a token: set --token (or PROTEUS_TOKEN) to expose the server`);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function createServer(opts: ServerOptions): Server {
  const store = new SessionStore(opts.store);
  const max = opts.maxBodyBytes ?? 1_000_000;
  const token = opts.token;
  if (token !== undefined && token.length < 16) throw new Error('token must be at least 16 characters');
  const content = opts.content ?? staticContent();
  const topicOf = (title: string) => content.topicOf(title);
  // Show a live provider every known reader's history once, so the articles
  // they saved or left unfinished are pinned before a refresh could drop them.
  for (const u of store.users()) content.forUser(store.sessions(u));
  // Failed authentications per address, sliding hour. An address over the
  // cap is refused before its credentials are looked at, so guessing past
  // the cap cannot succeed. Stale addresses are evicted; the map is bounded.
  const failures = new Map<string, number[]>();
  const FAIL_CAP = 100, WINDOW = 3_600_000, MAX_ADDRESSES = 10_000;
  const recent = (address: string, now: number): number[] => {
    const times = (failures.get(address) ?? []).filter((t) => now - t < WINDOW);
    if (times.length) failures.set(address, times); else failures.delete(address);
    return times;
  };
  const blocked = (address: string): boolean => recent(address, Date.now()).length >= FAIL_CAP;
  const noteFailure = (address: string): void => {
    const now = Date.now();
    if (!failures.has(address) && failures.size >= MAX_ADDRESSES) {
      // Evict the address whose newest failure is oldest.
      let victim: string | undefined, oldest = Infinity;
      for (const [a, ts] of failures) { const t = ts[ts.length - 1] ?? 0; if (t < oldest) { oldest = t; victim = a; } }
      if (victim !== undefined) failures.delete(victim);
    }
    failures.set(address, [...recent(address, now), now]);
  };
  const isOperator = (req: IncomingMessage): boolean => {
    if (!token) return true;
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') && safeEqual(h.slice(7), token);
  };
  const userSignatureOk = (user: string, k: string | null): boolean => !token || (k !== null && safeEqual(k, signUser(token, user)));
  const userLink = (user: string): string => `/u/${user}${token ? `?k=${signUser(token, user)}` : ''}`;
  let serveCounter = 0;
  const serveSeed = (): number | undefined => (opts.seed === undefined ? undefined : (opts.seed * 1_000_003 + serveCounter++) >>> 0);
  // First-time user ids introduced per remote address, sliding hour.
  const newUsersByAddress = new Map<string, number[]>();
  const allowNewUser = (address: string): boolean => {
    const now = Date.now();
    const times = (newUsersByAddress.get(address) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= (opts.maxNewUsersPerAddressPerHour ?? 1000)) { newUsersByAddress.set(address, times); return false; }
    times.push(now);
    newUsersByAddress.set(address, times);
    return true;
  };
  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(body);
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const forwarded = opts.trustProxy ? (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0].trim() : '';
    const address = forwarded || req.socket.remoteAddress || 'unknown';
    const deny = (status: number, message: string) => {
      noteFailure(address);
      return send(res, status, JSON.stringify({ ok: false, errors: [message] }));
    };
    try {
      // Cut off a guessing address before looking at anything it presents.
      if (token && blocked(address)) return send(res, 429, JSON.stringify({ ok: false, errors: ['too many failed requests from this address; try later'] }));
      if (req.method === 'POST' && url.pathname === '/events') {
        let rec: unknown;
        try { rec = JSON.parse(await readBody(req, max)); } catch (e) { return send(res, 400, JSON.stringify({ ok: false, errors: [(e as Error).message] })); }
        // A record may only be posted with the signature of the user it names.
        const named = (rec as { user?: unknown })?.user;
        if (token && (typeof named !== 'string' || !userSignatureOk(named, url.searchParams.get('k')))) return deny(403, 'record is not signed for its user');
        // Validation first, so a malformed record is a 400 the client must
        // fix, never a 429 it would retry. Then the posted-user cap, enforced
        // here as well as on serving: a user served while capacity remained
        // must not push the count over the cap by posting after others
        // filled it.
        const invalid = validateRecord(rec);
        if (invalid.length) return send(res, 400, JSON.stringify({ ok: false, errors: invalid }));
        const user = (rec as { user: string }).user;
        if (!store.hasPosted(user) && store.postedUsers() >= (opts.maxUsers ?? 10_000)) {
          return send(res, 429, JSON.stringify({ ok: false, errors: ['user limit reached'] }));
        }
        const { errors, replaced } = store.put(rec);
        if (errors.length) return send(res, 400, JSON.stringify({ ok: false, errors }));
        return send(res, 200, JSON.stringify({ ok: true, replaced }));
      }
      if (req.method !== 'GET') return send(res, 405, JSON.stringify({ ok: false, errors: ['method not allowed'] }));

      if (url.pathname === '/') {
        if (!isOperator(req)) return deny(401, 'operator token required');
        const users = store.users();
        // In token mode the data routes need a bearer header, which a browser
        // link cannot carry, so the page shows the commands instead of links.
        const data = (path: string) => (token ? `<code>curl -H "Authorization: Bearer …" ${esc(path)}</code>` : `<a href="${esc(path)}">${esc(path.replace(/^\//, ''))}</a>`);
        const html = `<!doctype html><meta charset="utf-8"><title>Proteus</title><body style="font-family:system-ui;padding:24px;max-width:640px">
<h1>Proteus</h1><p>Open a user's screen; use it; leave the tab. The page sends its session here. Reload the user's screen for the next one.${token ? ' Links are signed: mint one with <code>GET /link/&lt;user&gt;</code> (bearer token) and hand it out.' : ''}</p>
<p><a href="${esc(userLink(`user-${Date.now().toString(36)}`))}">New user</a> · ${data('/export.jsonl')}</p>
<ul>${users.map((u) => `<li><a href="${esc(userLink(u))}">${esc(u)}</a> (${store.records(u).length} sessions) · ${data(`/sessions/${u}`)}</li>`).join('')}</ul></body>`;
        return send(res, 200, html, 'text/html');
      }
      const m = /^\/(u|sessions|link)\/([A-Za-z0-9_.-]{1,64})$/.exec(url.pathname);
      if (m && m[1] === 'link') {
        if (!isOperator(req)) return deny(401, 'operator token required');
        return send(res, 200, JSON.stringify({ user: m[2], path: userLink(m[2]) }));
      }
      if (m && m[1] === 'u') {
        const user = m[2];
        if (!userSignatureOk(user, url.searchParams.get('k'))) return deny(403, 'this link is not signed for this user');
        // Growth bounds: a caller cannot make the store grow without limit
        // by reloading, or by inventing users.
        const history = store.sessions(user);
        const sessionIdx = history.length ? history[history.length - 1].session + 1 : 0;
        if (store.servesFor(user, sessionIdx) >= (opts.maxServesPerSession ?? 20)) return send(res, 429, JSON.stringify({ ok: false, errors: ['too many screens served for this session; post the session first'] }));
        if (!store.known(user)) {
          if (store.postedUsers() >= (opts.maxUsers ?? 10_000)) return send(res, 429, JSON.stringify({ ok: false, errors: ['user limit reached'] }));
          if (!allowNewUser(req.socket.remoteAddress ?? 'unknown')) return send(res, 429, JSON.stringify({ ok: false, errors: ['too many new users from this address; try later'] }));
        }
        const { doc, session, trace } = nextScreen(store, user, opts.policy, opts.epsilon ?? 0, serveSeed(), topicOf);
        if (trace) store.putTrace(trace);
        const endpoint = token ? `/events?k=${signUser(token, user)}` : '/events';
        return send(res, 200, renderPage(doc, content.forUser(history), { user, session, endpoint }), 'text/html');
      }
      if (m && m[1] === 'sessions') {
        if (!isOperator(req)) return deny(401, 'operator token required');
        const user = m[2];
        const sessions = store.sessions(user);
        const rewards = sessions.map((s) => sessionReward(s));
        const state = stateFromHistory(sessions, rewards, topicOf);
        return send(res, 200, JSON.stringify({
          user,
          sessions: sessions.map((s, i) => ({ session: s.session, events: s.events.length, returned: s.returned, reward: rewards[i] })),
          nextState: Object.fromEntries(STATE_NAMES.map((n, i) => [n, state[i]])),
          records: sessions,
        }));
      }
      if (url.pathname === '/export.jsonl') {
        if (!isOperator(req)) return deny(401, 'operator token required');
        return send(res, 200, store.records().map((r) => JSON.stringify(r)).join('\n') + '\n', 'application/x-ndjson');
      }
      return send(res, 404, JSON.stringify({ ok: false, errors: ['not found'] }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, errors: [(e as Error).message] }));
    }
  });
  // The exposure guard applies however the server is started: a TCP listen
  // on a non-loopback host (or on all interfaces, the default when no host
  // is given) without a token throws. A local IPC listen (a socket path, or
  // an options object with `path`) exposes nothing and is not guarded.
  const originalListen = server.listen.bind(server);
  (server as { listen: (...args: unknown[]) => Server }).listen = (...args: unknown[]) => {
    const first = args[0];
    const isObject = first !== null && typeof first === 'object';
    const ipc = typeof first === 'string' || (isObject && typeof (first as { path?: unknown }).path === 'string');
    if (!ipc) {
      const host = typeof args[1] === 'string' ? args[1]
        : isObject && typeof (first as { host?: unknown }).host === 'string' ? (first as { host: string }).host
        : '0.0.0.0';
      assertExposable(host, token);
    }
    return originalListen(...(args as Parameters<Server['listen']>));
  };
  return server;
}

if (process.argv[1] && basename(process.argv[1]) === 'server.ts') {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const port = Number(opt('port', '8787'));
  // Loopback unless remote access is deliberately requested: there is no
  // authentication, so anything that can reach the port can read every
  // session and replace any user's current one.
  const host = opt('host', '127.0.0.1');
  const store = opt('store', 'out/server');
  const policyName = opt('policy', 'trained');
  const policyFile = opt('policy-file', 'out/policy.json');
  const epsilon = Number(opt('epsilon', '0.1'));
  const token = opt('token', process.env.PROTEUS_TOKEN ?? '') || undefined;
  const trustProxy = args.includes('--trust-proxy');
  const contentFile = opt('content', '') || undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !host || !(epsilon >= 0 && epsilon < 1)) { console.error('usage: node src/server.ts [--port <int>] [--host 127.0.0.1] [--store dir] [--policy trained|random|<example>] [--policy-file out/policy.json] [--epsilon [0,1)=0.1] [--token <secret> | PROTEUS_TOKEN] [--trust-proxy] [--content content.json]'); process.exit(2); }
  try { assertExposable(host, token); } catch (e) { console.error((e as Error).message); process.exit(2); }
  if (token && token.length < 16) { console.error('token must be at least 16 characters'); process.exit(2); }
  let policy: ServerOptions['policy'];
  if (policyName === 'trained') {
    if (!existsSync(policyFile)) { console.error(`no trained policy at ${policyFile}; run npm run train first, or pass --policy random|<example>`); process.exit(1); }
    policy = loadPolicyFile(policyFile);
  } else if (policyName === 'random') policy = 'random';
  else {
    const f = `examples/valid/${policyName}.json`;
    if (!existsSync(f)) { console.error(`unknown policy '${policyName}'`); process.exit(2); }
    policy = JSON.parse(readFileSync(f, 'utf8')) as UIDocument;
  }
  let content: ContentProvider | undefined;
  if (contentFile) {
    // Live content: fetch once before listening so the first screen is real,
    // then keep refreshing. The last good snapshot is cached in the store.
    const live = new LiveContent({ config: loadContentConfig(contentFile), cacheFile: join(store, 'content.json'), log: (m) => console.log(m) });
    try { await live.refresh(); } catch (e) { console.error((e as Error).message); process.exit(1); }
    live.start();
    content = live;
  }
  createServer({ store, policy, epsilon, token, trustProxy, content }).listen(port, host, () => console.log(`proteus serving on http://${host}:${port} (store ${store}, policy ${policyName}${policyName === 'trained' ? `, epsilon ${epsilon}` : ''}, ${token ? 'token set: operator routes need a bearer token, user links are signed' : 'no token: open, loopback only'}, content ${contentFile ? `live from ${contentFile}` : 'fake'})`));
}
