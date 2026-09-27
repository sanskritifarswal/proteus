import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRecord } from './events.ts';
import type { Decision } from './sample.ts';
import { assemble, validateRecord, type ExportedRecord } from './collect.ts';

/**
 * The session store, on its own so that the training, comparison and
 * calibration commands can read a store without importing the server
 * (which imports them for its status page).
 */
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

  private readonly assembleOpts: { returnWindowMs?: number; now?: () => number };

  constructor(dir: string, opts: { returnWindowMs?: number; now?: () => number } = {}) {
    this.assembleOpts = opts;
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

  sessions(user: string): SessionRecord[] { return assemble(this.records(user), { returnWindowMs: this.assembleOpts.returnWindowMs, now: this.assembleOpts.now?.() }).get(user) ?? []; }

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
