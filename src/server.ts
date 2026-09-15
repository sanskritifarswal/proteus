import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UIDocument } from './tree.ts';
import type { SessionRecord } from './events.ts';
import { makeRng } from './rng.ts';
import { localUniform, sample } from './sample.ts';
import { newsfeed } from './grammars/newsfeed.ts';
import { fakeData } from './fake-data.ts';
import { renderPage } from './render-html.ts';
import { sessionReward } from './reward.ts';
import { stateFromHistory, STATE_NAMES } from './policy/features.ts';
import { LinearPolicy } from './policy/linear-policy.ts';
import { MlpPolicy } from './policy/mlp-policy.ts';
import type { PolicyModel } from './policy/model.ts';
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
 * cannot undo a final. No dependencies; no authentication; local use.
 */
export interface ServerOptions {
  store: string;
  policy: PolicyModel | 'random' | UIDocument;
  maxBodyBytes?: number;
}

const topicByTitle = new Map<string, string>();
for (const feed of Object.values(fakeData.feeds)) for (const a of feed.articles) topicByTitle.set(a.title, a.topic);
const topicOf = (t: string) => topicByTitle.get(t);

export class SessionStore {
  private readonly current = new Map<string, ExportedRecord>();
  private readonly logFile: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logFile = join(dir, 'events.jsonl');
    if (existsSync(this.logFile)) {
      for (const line of readFileSync(this.logFile, 'utf8').split('\n')) {
        if (!line) continue;
        this.absorb(JSON.parse(line) as ExportedRecord);
      }
    }
  }

  private absorb(rec: ExportedRecord): boolean {
    const k = `${rec.user}:${rec.session}`;
    const have = this.current.get(k);
    if (have && have.events.length >= rec.events.length) return false;
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
}

export function loadPolicyFile(file: string): PolicyModel {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  return json.model === 'mlp' ? MlpPolicy.fromJSON(json) : LinearPolicy.fromJSON(json);
}

export function nextScreen(store: SessionStore, user: string, policy: ServerOptions['policy']): { doc: UIDocument; session: number; how: string } {
  const history = store.sessions(user);
  const rewards = history.map((s) => sessionReward(s));
  const session = history.length ? history[history.length - 1].session + 1 : 0;
  if (policy === 'random') return { doc: sample(newsfeed, localUniform(makeRng(session * 7919 + user.length))), session, how: 'random' };
  if ('grammar' in policy) return { doc: policy, session, how: 'fixed' };
  const state = stateFromHistory(history, rewards, topicOf);
  return { doc: sample(newsfeed, policy.forState(state, makeRng(session + 1), undefined, true)), session, how: `${policy.name} policy, ${history.length} prior session(s)` };
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
  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(body);
  };

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/events') {
        let rec: unknown;
        try { rec = JSON.parse(await readBody(req, max)); } catch (e) { return send(res, 400, JSON.stringify({ ok: false, errors: [(e as Error).message] })); }
        const { errors, replaced } = store.put(rec);
        if (errors.length) return send(res, 400, JSON.stringify({ ok: false, errors }));
        return send(res, 200, JSON.stringify({ ok: true, replaced }));
      }
      if (req.method !== 'GET') return send(res, 405, JSON.stringify({ ok: false, errors: ['method not allowed'] }));

      if (url.pathname === '/') {
        const users = store.users();
        const html = `<!doctype html><meta charset="utf-8"><title>Proteus</title><body style="font-family:system-ui;padding:24px;max-width:600px">
<h1>Proteus</h1><p>Open a user's screen; use it; leave the tab. The page sends its session here. Reload the user's screen for the next one.</p>
<p><a href="/u/${esc(`user-${Date.now().toString(36)}`)}">New user</a> · <a href="/export.jsonl">export.jsonl</a></p>
<ul>${users.map((u) => `<li><a href="/u/${esc(u)}">${esc(u)}</a> (${store.records(u).length} sessions) · <a href="/sessions/${esc(u)}">data</a></li>`).join('')}</ul></body>`;
        return send(res, 200, html, 'text/html');
      }
      const m = /^\/(u|sessions)\/([A-Za-z0-9_.-]{1,64})$/.exec(url.pathname);
      if (m && m[1] === 'u') {
        const user = m[2];
        const { doc, session } = nextScreen(store, user, opts.policy);
        return send(res, 200, renderPage(doc, fakeData, { user, session, endpoint: '/events' }), 'text/html');
      }
      if (m && m[1] === 'sessions') {
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
        return send(res, 200, store.records().map((r) => JSON.stringify(r)).join('\n') + '\n', 'application/x-ndjson');
      }
      return send(res, 404, JSON.stringify({ ok: false, errors: ['not found'] }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, errors: [(e as Error).message] }));
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const port = Number(opt('port', '8787'));
  const store = opt('store', 'out/server');
  const policyName = opt('policy', 'trained');
  const policyFile = opt('policy-file', 'out/policy.json');
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('usage: node src/server.ts [--port <int>] [--store dir] [--policy trained|random|<example>] [--policy-file out/policy.json]'); process.exit(2); }
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
  createServer({ store, policy }).listen(port, () => console.log(`proteus serving on http://localhost:${port} (store ${store}, policy ${policyName})`));
}
