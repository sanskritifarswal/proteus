import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UIDocument } from './tree.ts';
import { makeRng } from './rng.ts';
import { sample, localUniform } from './sample.ts';
import { newsfeed } from './grammars/newsfeed.ts';
import { fakeData } from './fake-data.ts';
import { renderPage } from './render-html.ts';
import { sessionReward } from './reward.ts';
import { stateFromHistory } from './policy/features.ts';
import { LinearPolicy } from './policy/linear-policy.ts';
import { MlpPolicy } from './policy/mlp-policy.ts';
import type { PolicyModel } from './policy/model.ts';
import { assemble, validateRecord, type ExportedRecord } from './collect.ts';

/**
 * The init/scaffold loop on one machine:
 *   1. render an instrumented screen for a user  (this command)
 *   2. use it in a browser, press "Export session", save the JSON
 *   3. npm run collect -- --add that.json           (validates, appends)
 *   4. run this command again: the policy reads the history and picks the next screen
 *
 * usage: node src/demo.ts [--user id] [--history out/sessions.jsonl]
 *        [--policy trained|random|editorial-home|dense-list|visual-grid] [--policy-file out/policy.json]
 *        [--endpoint url] [--out demo/index.html]
 */
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const user = opt('user', 'demo-user');
const historyFile = opt('history', 'out/sessions.jsonl');
const policyName = opt('policy', 'trained');
const policyFile = opt('policy-file', 'out/policy.json');
const endpoint = opt('endpoint', '');
const out = opt('out', 'demo/index.html');

const records = existsSync(historyFile)
  ? readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExportedRecord).filter((r) => r.user === user)
  : [];
for (const r of records) { const e = validateRecord(r); if (e.length) { console.error(`invalid record in history: ${e.join('; ')}`); process.exit(1); } }
const history = assemble(records).get(user) ?? [];
const rewards = history.map((s) => sessionReward(s));
const session = history.length ? history[history.length - 1].session + 1 : 0;

let doc: UIDocument;
let how: string;
if (policyName === 'trained') {
  if (!existsSync(policyFile)) { console.error(`no trained policy at ${policyFile}; run npm run train first, or pass --policy random|<example>`); process.exit(1); }
  const json = JSON.parse(readFileSync(policyFile, 'utf8'));
  const model: PolicyModel = json.model === 'mlp' ? MlpPolicy.fromJSON(json) : LinearPolicy.fromJSON(json);
  const topicByTitle = new Map<string, string>();
  for (const feed of Object.values(fakeData.feeds)) for (const a of feed.articles) topicByTitle.set(a.title, a.topic);
  const state = stateFromHistory(history, rewards, (t) => topicByTitle.get(t));
  doc = sample(newsfeed, model.forState(state, makeRng(session + 1), undefined, true));
  how = `${model.name} policy (greedy) from ${policyFile}, conditioned on ${history.length} prior session(s)`;
} else if (policyName === 'random') {
  doc = sample(newsfeed, localUniform(makeRng(Date.now() % 100000)));
  how = 'random derivation';
} else {
  const f = `examples/valid/${policyName}.json`;
  if (!existsSync(f)) { console.error(`unknown policy '${policyName}'`); process.exit(2); }
  doc = JSON.parse(readFileSync(f, 'utf8'));
  how = `fixed example ${policyName}`;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderPage(doc, fakeData, { user, session, endpoint: endpoint || undefined }));
console.log(`wrote ${out}: ${user} session ${session}, ${how}`);
if (rewards.length) console.log(`prior rewards: ${rewards.map((r) => r.toFixed(1)).join(', ')}`);
console.log(`density ${doc.tree.props!.density}, ${(doc.tree.slots!.sections as unknown[]).length} sections`);
