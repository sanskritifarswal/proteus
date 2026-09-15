import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { assertExposable, createServer, signUser } from './server.ts';
import { createRecorder } from './client/recorder.ts';
import { LinearPolicy } from './policy/linear-policy.ts';

/**
 * With a token set: user links must be signed, records must carry their
 * user's signature, operator routes need the bearer token, links can be
 * minted, guessing is cut off, and exposure without a token is refused.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const dir = mkdtempSync(join(tmpdir(), 'proteus-auth-'));
const token = 'correct-horse-battery-staple-2026';
const server = createServer({ store: dir, policy: new LinearPolicy(), epsilon: 0.1, token, seed: 21 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const bearer = { Authorization: `Bearer ${token}` };
const status = async (path: string, init?: RequestInit) => (await fetch(`${base}${path}`, init)).status;

report(await status('/u/alice') === 403 && await status('/u/alice?k=deadbeef') === 403, 'an unsigned or mis-signed user link is refused');
const k = signUser(token, 'alice');
const page = await fetch(`${base}/u/alice?k=${k}`);
const html = await page.text();
report(page.status === 200 && html.includes(`/events?k=${k}`), 'a signed link serves the screen and the page posts with the same signature');
const tree = JSON.parse(/<script type="application\/json" id="proteus-tree">(.*?)<\/script>/s.exec(html)![1].replace(/\\u003c/g, '<'));
const rec = createRecorder({ user: 'alice', session: 0, grammar: 'newsfeed@0.3.0', tree, now: () => 0 });
rec.impression('sections[0].content.item', 'A'); rec.end();
const body = JSON.stringify(rec.record());
report(await status('/events', { method: 'POST', body }) === 403, 'a record without a signature is refused');
report(await status(`/events?k=${signUser(token, 'mallory')}`, { method: 'POST', body }) === 403, "a record signed for a different user is refused");
report(await status(`/events?k=${k}`, { method: 'POST', body }) === 200, 'a record signed for its own user is accepted');

report(await status('/export.jsonl') === 401 && await status('/export.jsonl', { headers: { Authorization: 'Bearer wrong' } }) === 401 && await status('/sessions/alice') === 401 && await status('/') === 401, 'operator routes refuse a missing or wrong bearer token');
report(await status('/export.jsonl', { headers: bearer }) === 200 && await status('/sessions/alice', { headers: bearer }) === 200 && await status('/', { headers: bearer }) === 200, 'operator routes accept the bearer token');
const link = await (await fetch(`${base}/link/bob`, { headers: bearer })).json() as { path: string };
report(link.path === `/u/bob?k=${signUser(token, 'bob')}` && await status(link.path) === 200, `GET /link/<user> mints a working signed link (${link.path.slice(0, 20)}…)`);
report(await status('/link/bob') === 401, 'minting a link needs the operator token');

// Guessing is cut off: after the cap, even a good request from that address is 429 for a while.
{
  const other = createServer({ store: mkdtempSync(join(tmpdir(), 'proteus-auth2-')), policy: new LinearPolicy(), token, seed: 22 });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  let last = 0;
  for (let i = 0; i < 101; i++) last = (await fetch(`${b2}/u/alice?k=${i.toString(16).padStart(32, '0')}`)).status;
  await new Promise<void>((r) => other.close(() => r()));
  report(last === 429, `repeated failed authentication from one address is cut off (${last})`);
}

await new Promise<void>((r) => server.close(() => r()));

let refused = false;
try { assertExposable('0.0.0.0', undefined); } catch { refused = true; }
let allowedLoop = true;
try { assertExposable('127.0.0.1', undefined); assertExposable('0.0.0.0', token); } catch { allowedLoop = false; }
report(refused && allowedLoop, 'binding beyond loopback is refused without a token and allowed with one');
report(signUser(token, 'alice') !== signUser(token, 'alice2') && signUser('another-token-of-length-16+', 'alice') !== k, 'signatures differ by user and by token');

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} auth check(s) failed` : '\nauth checks passed');
process.exit(failures ? 1 : 0);
