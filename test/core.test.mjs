import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../core/index.mjs';
import { makeRepo } from './helpers.mjs';

test('init builds a hierarchy that mirrors the directory structure', async () => {
  const { root, rm } = makeRepo();
  const r = await core.sync(root, { init: true });
  const org = core.load(root).org;
  assert.ok(r.agents >= 4, `expected >=4 agents, got ${r.agents}`);
  assert.deepEqual(new Set(org.agents.root.children), new Set(['src-auth', 'src-billing', 'src-catalog', 'src-shared'].filter((id) => org.agents[id])));
  assert.ok(org.agents['src-auth'], 'auth agent exists (wrapper dir src/ is collapsed)');
  assert.equal(org.agents['src-auth'].parent, 'root');
  assert.ok(fs.existsSync(path.join(root, '.codeceo/contexts/src-auth.md')), 'context file per zone');
  rm();
});

test('dependency graph resolves relative imports and drives metrics', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const S = core.load(root);
  assert.ok(S.graph.edges.some(([a, b]) => a === 'src/billing/charge.js' && b === 'src/shared/money.js'));
  assert.ok(S.metricsByAgent['src-billing'].outTo['src-shared'] > 0);
  assert.ok(S.metricsByAgent['src-billing'].outTo['src-auth'] > 0);
  rm();
});

test('routing sends a query to the owning module, not the whole repo', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const { org } = core.load(root);
  const r = core.route(root, org, 'fix the stripe payment invoice rounding');
  assert.equal(r.complexity, 'local');
  assert.deepEqual(r.agents.map((a) => a.id), ['src-billing']);
  assert.equal(r.intent, 'change');
  const g = core.route(root, org, 'explain the overall architecture');
  assert.equal(g.complexity, 'global');
  const byFile = core.route(root, org, 'why does src/auth/login.js compare hashes?');
  assert.equal(byFile.agents[0].id, 'src-auth');
  rm();
});

test('packets are scoped and far smaller than the repo', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const p = await core.packet(root, 'src-billing', 'how is an invoice charged?');
  assert.match(p.text, /src-billing/);
  assert.match(p.text, /formatMoney|charge/);
  assert.doesNotMatch(p.text, /products\.js/);
  rm();
});

test('write scope: agents edit only what they own', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  assert.equal(core.guard(root, { agent: 'src-auth', tool: 'Edit', path: 'src/auth/login.js' }).ok, true);
  const denied = core.guard(root, { agent: 'src-auth', tool: 'Edit', path: path.join(root, 'src/billing/charge.js') });
  assert.equal(denied.ok, false);
  assert.match(denied.why, /src-billing/);
  assert.equal(core.guard(root, { agent: 'src-auth', tool: 'Write', path: '.codeceo/contexts/src-auth.md' }).ok, true);
  assert.equal(core.guard(root, { agent: 'src-auth', tool: 'Write', path: '.codeceo/contexts/src-billing.md' }).ok, false);
  rm();
});

test('contract change is detected and dependents are notified', async () => {
  const { root, w, rm } = makeRepo();
  await core.sync(root, { init: true });
  w('src/auth/crypto.js', 'export function hashPassword(pw, salt) { return salt + pw; }\n' + '// pad\n'.repeat(25));
  w('src/auth/index.js', `export { login } from './login.js';\nexport { hashPassword } from './crypto.js';\nexport { newThing } from './login.js';\n`);
  const r = await core.sync(root);
  assert.ok(r.contractChanges.includes('src-auth'), 'auth contract changed');
  assert.ok(r.notified.some((n) => n.to === 'src-billing'), 'billing was notified');
  assert.equal(core.inbox(root, 'src-billing').length, 1);
  rm();
});

test('integrate blocks a breaking change whose dependents were not updated', async () => {
  const { root, w, rm } = makeRepo();
  await core.sync(root, { init: true });
  core.begin(root);
  w('src/auth/index.js', `export { login } from './login.js';\n`); // removes hashPassword
  const r = core.integrate(root, { allow: ['src-auth'] });
  assert.equal(r.verdict, 'blocked');
  assert.ok(r.blockers.some((b) => /breaking contract/.test(b)));
  rm();
});

test('integrate flags writes outside the agents that were part of the run', async () => {
  const { root, w, rm } = makeRepo();
  await core.sync(root, { init: true });
  core.begin(root);
  w('src/catalog/products.js', '// sneaky\n');
  const r = core.integrate(root, { allow: ['src-auth'] });
  assert.ok(r.blockers.some((b) => /out-of-scope/.test(b)));
  rm();
});

test('persistent context survives a re-sync and tracks staleness', async () => {
  const { root, w, rm } = makeRepo();
  await core.sync(root, { init: true });
  const file = path.join(root, '.codeceo/contexts/src-auth.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/## Purpose\n.*\n/, '## Purpose\nHandles login and password hashing.\n'));
  core.touchContext(root, 'src-auth');
  assert.equal(core.status(root).agents.find((a) => a.id === 'src-auth').stale, false);
  w('src/auth/login.js', '// changed\n' + 'export async function login() {}\n');
  await core.sync(root);
  assert.match(fs.readFileSync(file, 'utf8'), /Handles login and password hashing/);
  const s = core.status(root).agents.find((a) => a.id === 'src-auth');
  assert.equal(s.stale, true);
  assert.equal(s.written, true);
  rm();
});

test('charter: CEO re-parents agents, sets mandates and controls who may talk to whom', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  let ch = core.loadCharter(root);
  ch.agents['src-billing'] = { mandate: 'Owns every euro. Never changes money semantics without the CEO.' };
  ch = core.link(ch, 'deny', 'src-billing', 'src-auth');
  ch = core.link(ch, 'allow', 'src-catalog', 'src-auth');
  core.saveCharter(root, ch);
  await core.sync(root);
  const S = core.load(root);
  assert.equal(S.org.agents['src-billing'].mandate, 'Owns every euro. Never changes money semantics without the CEO.');
  assert.match(fs.readFileSync(path.join(root, '.codeceo/contexts/src-billing.md'), 'utf8'), /Owns every euro/);
  assert.equal(core.canTalk(S.org, S.charter, S.metricsByAgent, 'src-billing', 'src-auth').ok, false, 'denied despite dependency edge');
  assert.equal(core.canTalk(S.org, S.charter, S.metricsByAgent, 'src-catalog', 'src-auth').ok, true, 'allowed with no edge');
  assert.equal(core.canTalk(S.org, S.charter, S.metricsByAgent, 'src-catalog', 'src-billing').ok, false, 'unrelated siblings must escalate');
  assert.equal(core.canTalk(S.org, S.charter, S.metricsByAgent, 'src-catalog', 'root').ok, true, 'child may always reach its parent');
  rm();
});

test('org self-organises: grows a new agent when a directory grows, keeps ids stable', async () => {
  const { root, w, rm } = makeRepo();
  await core.sync(root, { init: true });
  assert.equal(core.load(root).org.agents['src-search'], undefined);
  w('src/search/index.js', 'export function search() {}\n' + '// x\n'.repeat(30));
  w('src/search/rank.js', 'export function rank() {}\n' + '// y\n'.repeat(30));
  const r = await core.sync(root);
  assert.ok(r.reorg.added.includes('src-search'));
  assert.ok(core.load(root).org.agents['src-auth'], 'existing ids unchanged');
  rm();
});

test('python and go imports resolve too', async () => {
  const { root, w, rm } = makeRepo();
  w('svc/app/main.py', 'from app.util import helper\nfrom .models import User\n' + '# p\n'.repeat(30));
  w('svc/app/util.py', 'def helper(): pass\n' + '# p\n'.repeat(30));
  w('svc/app/models.py', 'class User: pass\n' + '# p\n'.repeat(30));
  w('go/cmd/main.go', 'package main\nimport "example.com/shop/go/pkg/store"\n' + '// g\n'.repeat(30));
  w('go/pkg/store/store.go', 'package store\nfunc Open() {}\n' + '// g\n'.repeat(30));
  await core.sync(root, { init: true });
  const edges = core.load(root).graph.edges;
  assert.ok(edges.some(([a, b]) => a === 'svc/app/main.py' && b === 'svc/app/util.py'), 'absolute py import');
  assert.ok(edges.some(([a, b]) => a === 'svc/app/main.py' && b === 'svc/app/models.py'), 'relative py import');
  assert.ok(edges.some(([a, b]) => a === 'go/cmd/main.go' && b === 'go/pkg/store/store.go'), 'go import');
  rm();
});

test('optional semantic layer: provider vectors are stored and fused with BM25', async () => {
  const { root, w, rm } = makeRepo();
  // toy embedding: bag of a few concept words, deterministic and offline
  w('embed.mjs', `const V = ['invoice','login','product','money'];
export async function embed(texts) { return texts.map((t) => V.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)).concat([0.01])); }`);
  w('.codeceo/config.json', JSON.stringify({ org: { minModuleLoc: 20, maxModuleLoc: 60, maxFilesPerModule: 40 }, retrieval: { embeddings: { module: './embed.mjs' } } }));
  const r = await core.sync(root, { init: true, embed: true });
  assert.equal(r.embedded, true);
  const shard = core.loadShard(root, 'src-billing');
  assert.ok(shard.vec && shard.vec.length === shard.n, 'one vector per chunk');
  const S = core.load(root);
  const provider = await core.loadProvider(root, S.cfg);
  const hits = await core.searchShard(root, 'src-billing', 'invoice', { provider });
  assert.ok(hits.length > 0 && /billing/.test(hits[0].file));
  rm();
});
