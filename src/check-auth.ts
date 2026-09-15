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

// Guessing is cut off: after the cap, even the CORRECT credential from that address is refused.
{
  const dir2 = mkdtempSync(join(tmpdir(), 'proteus-auth2-'));
  const other = createServer({ store: dir2, policy: new LinearPolicy(), token, seed: 22 });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  let last = 0;
  for (let i = 0; i < 100; i++) last = (await fetch(`${b2}/u/alice?k=${i.toString(16).padStart(32, '0')}`)).status;
  const goodAfter = (await fetch(`${b2}/u/alice?k=${signUser(token, 'alice')}`)).status;
  const bearerAfter = (await fetch(`${b2}/export.jsonl`, { headers: bearer })).status;
  await new Promise<void>((r) => other.close(() => r()));
  rmSync(dir2, { recursive: true, force: true });
  report(last === 403 && goodAfter === 429 && bearerAfter === 429, `after the failure cap, even correct credentials from that address are refused (last guess ${last}, then good link ${goodAfter}, good bearer ${bearerAfter})`);
}

// The operator page in token mode links only to signed user screens, never to bearer-only routes.
{
  const index = await (await fetch(`${base}/`, { headers: bearer })).text();
  report(!/href="\/export\.jsonl"/.test(index) && !/href="\/sessions\//.test(index) && index.includes('?k='), 'the operator page carries no links a browser could not authenticate');
}

// Programmatic startup enforces the same guards as the CLI.
{
  let shortToken = false;
  try { createServer({ store: dir, policy: new LinearPolicy(), token: 'short' }); } catch { shortToken = true; }
  let openExposed = false;
  const open = createServer({ store: dir, policy: new LinearPolicy() });
  try { open.listen(0, '0.0.0.0'); } catch { openExposed = true; }
  let openDefault = false;
  try { open.listen(0); } catch { openDefault = true; }
  report(shortToken && openExposed && openDefault, 'createServer refuses a short token, and an untokened server refuses to listen beyond loopback or on all interfaces');
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
