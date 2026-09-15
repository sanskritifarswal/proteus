import { readFileSync } from 'node:fs';
import { createRecorder } from './client/recorder.ts';
import { clientScript } from './render-html.ts';
import { validateRecord, assemble } from './collect.ts';
import { sessionReward, defaultWeights } from './reward.ts';
import { stateFromHistory } from './policy/features.ts';
import { nodePaths, type UIDocument } from './tree.ts';

/**
 * The recorder produces records that pass the same validation, reward and
 * state code the simulator's sessions do; the embedded client script is
 * well-formed; the collector rejects malformed records.
 */
let failures = 0;
const report = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const doc = JSON.parse(readFileSync('examples/valid/editorial-home.json', 'utf8')) as UIDocument;
let clock = 1_000_000;
const now = () => clock;
const rec = createRecorder({ user: 'u-test', session: 0, grammar: doc.grammar, tree: doc.tree, now });
const item = 'sections[0].content.item';
const lead = 'sections[0].content.lead';
rec.impression(lead, 'A');
rec.impression(lead, 'A'); // duplicate, ignored
rec.impression(item, 'B');
clock += 2000;
report(rec.open(lead, 'A'), 'open returns true the first time');
report(!rec.open(item, 'B'), 'a second open while one is open is refused');
clock += 90_000;
rec.close(0.8);
rec.scrollPast(item, 'B');
rec.scrollPast(item, 'B'); // duplicate, ignored
rec.action(`${lead}.actions[0]`, 'save', 'A');
const snap = rec.snapshot();
report(snap.events[snap.events.length - 1].type === 'session_end' && rec.size() === 7, 'a snapshot appends session_end without ending the recorder');
rec.open(item, 'C'); // no prior impression: one is synthesised; still allowed after a snapshot
clock += 5000;
rec.end(); // closes C with 0 read
rec.end(); // idempotent
rec.impression(item, 'D'); // after end: ignored
const record = rec.record();
const types = record.events.map((e) => e.type).join(',');
report(types === 'impression,impression,open,dwell,complete,scroll_past,action,impression,open,dwell,complete,session_end', `event sequence is as expected (${types})`);
report(validateRecord(record).length === 0, `recorder output passes the collector's validation (${validateRecord(record).join('; ') || 'no errors'})`);
const paths = nodePaths(doc.tree);
report(record.events.every((e) => paths.has(e.path)), 'every recorded path is a node in the tree');

const sessions = assemble([record as never]).get('u-test')!;
report(sessions.length === 1 && sessions[0].returned === null, 'a lone session has unknown (censored) return');
const r = sessionReward(sessions[0]);
const w = defaultWeights;
const expected = w.open * Math.sqrt(2) + w.completion * Math.sqrt(0.8) + w.dwellPerMinute * (95_000 / 60_000) + Math.sqrt(w.save) + w.scrollPast * 1;
report(Math.abs(r - expected) < 1e-9, `reward from a recorded session matches the formula (${r.toFixed(3)} vs ${expected.toFixed(3)})`);
const state = stateFromHistory(sessions, [r]);
report(state[0] === 1 && state[2] > 0 && Number.isFinite(state[3]), `state features compute from a recorded session (openRate ${state[2].toFixed(2)}, meanCompletion ${state[3].toFixed(2)})`);

// Two sessions: the first is now known to have returned.
const rec2 = createRecorder({ user: 'u-test', session: 1, grammar: doc.grammar, tree: doc.tree, now });
rec2.end();
const two = assemble([record as never, rec2.record() as never]).get('u-test')!;
report(two[0].returned === true && two[1].returned === null, 'with a next session, the earlier one is marked returned');

// Malformed records are rejected.
const bad = JSON.parse(JSON.stringify(record));
bad.events[3] = { t: bad.events[3].t, type: 'dwell', path: lead, article: 'A' }; // no value
bad.events.push({ t: 0, type: 'open', path: 'nowhere', article: 'Z' });
const errs = validateRecord(bad);
report(errs.some((e) => e.includes('needs a numeric value')) && errs.some((e) => e.includes('not a node')) && errs.some((e) => e.includes('goes backwards') || e.includes('session_end')), `malformed records are rejected (${errs.length} errors)`);

// Stricter validation: null article, negative dwell, empty events.
{
  const withNull = JSON.parse(JSON.stringify(record)); withNull.events[2].article = null;
  const negDwell = JSON.parse(JSON.stringify(record)); negDwell.events[3].value = -5;
  const empty = { ...JSON.parse(JSON.stringify(record)), events: [] };
  report(validateRecord(withNull).some((e) => e.includes('article')) && validateRecord(negDwell).some((e) => e.includes('non-negative')) && validateRecord(empty).some((e) => e.includes('session_end')), 'null article, negative dwell and empty event lists are rejected');
}

// Duplicate (user, session) records are an error, not a phantom session.
{
  let threw = false;
  try { assemble([record as never, record as never]); } catch { threw = true; }
  report(threw, 'duplicate sessions are rejected by assemble');
}

// The embedded client script is well-formed.
const js = clientScript();
report(js.includes('function createRecorder') && !/^export\s/m.test(js) && !/^declare\s/m.test(js) && js.includes('IntersectionObserver'), `client script embeds without export/declare (${js.length} chars)`);
report(!/\.innerHTML\s*=\s*[^'"]/.test(js.replace(/reader\.innerHTML = '<div class="proteus-reader-inner">[^;]*;/, '')), 'client script never assigns page content through innerHTML');

console.log(failures ? `\n${failures} client check(s) failed` : '\nclient checks passed');
process.exit(failures ? 1 : 0);
