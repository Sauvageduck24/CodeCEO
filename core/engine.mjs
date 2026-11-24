// Orchestration of the core: sync the org with the code, build packets, integrate changes.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, writeText, estTokens, trimTo, sha1 } from './util.mjs';
import { DIR, loadConfig, storePath } from './config.mjs';
import { scan } from './scan.mjs';
import { buildEdges } from './graph.mjs';
import { ancestors, buildOrg, diffOrg, makeOwner, metrics, ROOT, agentCycles } from './organize.mjs';
import { extractExports } from './lang.mjs';
import { boundaryViolations, computeContracts, dependentsOf, diffContracts } from './contracts.mjs';
import { archiveContext, contextFile, curated, loadState, purposeOf, readContext, staleness, touch, writeFacts, isWritten } from './memory.mjs';
import { buildRoutes, buildShard, chunkFile, loadProvider, saveShard, searchShard } from './retrieve.mjs';
import { inbox, readLedger, record, send } from './ledger.mjs';
import { loadCharter, canTalk } from './policy.mjs';

const GITIGNORE = `# Derived data — rebuilt by \`codeceo sync\`. Everything else in .codeceo/ should be committed.
index/
run/
archive/
manifest.json
graph.json
routes.json
`;

export function load(root) {
  const cfg = loadConfig(root);
  const org = readJson(storePath(root, 'org.json'));
  if (!org) throw new Error('CodeCEO is not initialised here. Run: codeceo init');
  const graph = readJson(storePath(root, 'graph.json'), { edges: [], metrics: {} });
  return { root, cfg, org, charter: loadCharter(root), state: loadState(root), graph, metricsByAgent: graph.metrics };
}

const ownFilesOf = (org, files) => {
  const owner = makeOwner(org);
  const by = Object.fromEntries(Object.keys(org.agents).map((id) => [id, []]));
  for (const f of files) by[owner(f.path)].push(f);
  return by;
};

function renderFacts(a, org, by, m, contracts, edges, files, root) {
  const mine = by[a.id];
  const x = m[a.id];
  const lines = [];
  lines.push(`**Scope:** ${a.paths.map((p) => `\`${p || '/'}\``).join(', ')} · ${mine.length} files · ${x.loc} LOC${a.parent ? ` · reports to \`${a.parent}\`` : ''}`);
  if (a.mandate) lines.push(`**Mandate (set by the CEO):** ${a.mandate}`);
  if (a.children.length) {
    lines.push('', '**Team:**');
    for (const c of a.children) lines.push(`- \`${c}\` — ${purposeOf(readContext(root, c)) || org.agents[c].paths[0]}`);
  }
  const c = contracts[a.id];
  const syms = Object.entries(c?.symbols ?? {});
  if (syms.length) {
    lines.push('', `**Public surface** (contract \`${c.hash}\`):`);
    for (const [k, sig] of syms.slice(0, 20)) lines.push(`- \`${k.split('#')[0]}\` — ${sig}`);
    if (syms.length > 20) lines.push(`- … and ${syms.length - 20} more`);
  }
  const dep = Object.entries(x.outTo).sort((p, q) => q[1] - p[1]);
  const used = Object.entries(x.inFrom).sort((p, q) => q[1] - p[1]);
  if (dep.length) lines.push('', `**Depends on:** ${dep.map(([k, n]) => `\`${k}\` (${n})`).join(', ')}`);
  if (used.length) lines.push(`**Used by:** ${used.map(([k, n]) => `\`${k}\` (${n})`).join(', ')}`);
  lines.push(`**Health:** cohesion ${x.cohesion} · instability ${x.instability}`);
  const big = [...mine].filter((f) => f.lang).sort((p, q) => q.loc - p.loc).slice(0, 5);
  if (big.length) lines.push(`**Largest files:** ${big.map((f) => `\`${f.path}\` (${f.loc})`).join(', ')}`);
  return lines.join('\n');
}

const fpOf = (files) => sha1(files.map((f) => `${f.path}:${f.hash}`).join('\n'));

/** Cheap check used by hooks: re-sync only when files changed since the last sync (lock-guarded). */
export async function syncIfChanged(root) {
  const cfg = loadConfig(root);
  const rec = readJson(storePath(root, 'run', 'sync.json'), {});
  const fp = fpOf(scan(root, cfg, { text: false }));
  if (rec.fp === fp) return { synced: false };
  const lock = storePath(root, 'run', 'sync.lock');
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < 60000) return { synced: false, busy: true };
  } catch {}
  writeText(lock, String(process.pid));
  try {
    return { synced: true, ...(await sync(root)) };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export async function sync(root, { embed = false, init = false } = {}) {
  const cfg = loadConfig(root);
  fs.mkdirSync(storePath(root), { recursive: true });
  if (init) {
    const gi = storePath(root, '.gitignore');
    if (!fs.existsSync(gi)) writeText(gi, GITIGNORE);
    if (!fs.existsSync(storePath(root, 'config.json'))) writeJson(storePath(root, 'config.json'), { version: 1 });
  }

  const files = scan(root, cfg, { text: true });
  const edges = buildEdges(files);
  const prevOrg = readJson(storePath(root, 'org.json'));
  const charter = loadCharter(root);
  const org = buildOrg(files, prevOrg, cfg.org, charter);
  const by = ownFilesOf(org, files);
  const m = metrics(org, files, edges);

  const contracts = computeContracts(org, cfg, files, edges);
  const baselineFile = storePath(root, 'contracts.json');
  const baseline = readJson(baselineFile);
  if (!baseline) writeJson(baselineFile, contracts);
  const changes = baseline ? diffContracts(baseline, contracts) : {};

  // reorganisation bookkeeping
  const d = diffOrg(prevOrg, org);
  for (const id of d.removed) archiveContext(root, id);
  if (prevOrg && (d.added.length || d.removed.length)) record(root, { type: 'reorg', agent: ROOT, added: d.added, removed: d.removed });

  // notify dependents of contract changes, once per contract hash
  const notified = [];
  for (const [id, ch] of Object.entries(changes)) {
    const subject = `contract of ${id} changed (${contracts[id].hash})`;
    for (const dep of Object.keys(dependentsOf(org, edges, id))) {
      if (inbox(root, dep, { all: true }).some((x) => x.subject === subject)) continue;
      send(root, { from: id, to: dep, kind: 'contract-change', subject, body: summarizeChange(ch), files: ch.removed.concat(ch.changed.map((c) => c.symbol)).map((s) => s.split('#')[0]) });
      notified.push({ from: id, to: dep });
    }
  }

  // retrieval shards (one per agent) + optional semantic vectors
  const provider = embed ? await loadProvider(root, cfg) : null;
  fs.rmSync(storePath(root, 'index'), { recursive: true, force: true });
  const agentDocs = {};
  for (const a of Object.values(org.agents)) {
    const mine = by[a.id];
    let vec = null;
    if (provider) {
      const texts = mine.flatMap((f) => chunkFile(f, cfg.retrieval.chunkLines).map((c) => c.text.slice(0, 2000)));
      vec = [];
      for (let i = 0; i < texts.length; i += 64) vec.push(...(await provider.embed(texts.slice(i, i + 64))).map((v) => v.map((n) => +n.toFixed(4))));
    }
    saveShard(root, buildShard(a.id, mine, cfg, vec));
    const symbols = mine.flatMap((f) => (f.lang ? extractExports(f.lang, f.text).map((e) => e.name) : []));
    agentDocs[a.id] = {
      text: mine.map((f) => f.text.slice(0, 20000)).join('\n'),
      boost: [...mine.map((f) => f.path), ...symbols, a.mandate ?? '', purposeOf(readContext(root, a.id))].join(' '),
    };
  }

  // write derived data
  writeJson(storePath(root, 'org.json'), org);
  writeJson(storePath(root, 'graph.json'), { edges, metrics: m });
  writeJson(storePath(root, 'routes.json'), buildRoutes(agentDocs));

  // facts blocks (children first so parents can quote their purpose)
  const order = Object.values(org.agents).sort((p, q) => q.level - p.level);
  for (const a of order) writeFacts(root, a, renderFacts(a, org, by, m, contracts, edges, files, root));

  const state = loadState(root);
  for (const id of Object.keys(state.agents)) if (!org.agents[id]) delete state.agents[id];
  writeJson(storePath(root, 'state.json'), state);
  writeJson(storePath(root, 'run', 'sync.json'), { fp: fpOf(files), at: new Date().toISOString() });

  return { files: files.length, agents: Object.keys(org.agents).length, edges: edges.length, reorg: d, contractChanges: Object.keys(changes), notified, embedded: Boolean(provider) };
}

function summarizeChange(ch) {
  const parts = [];
  if (ch.removed.length) parts.push(`removed: ${ch.removed.join(', ')}`);
  for (const c of ch.changed) parts.push(`changed: ${c.symbol}\n  was: ${c.from}\n  now: ${c.to}`);
  if (ch.added.length) parts.push(`added: ${ch.added.join(', ')}`);
  return parts.join('\n');
}

export function status(root) {
  const S = load(root);
  const files = scan(root, S.cfg, { text: false });
  const by = ownFilesOf(S.org, files);
  const out = [];
  for (const a of Object.values(S.org.agents)) {
    const st = staleness(S.state, a.id, by[a.id]);
    out.push({
      id: a.id, title: a.title, level: a.level, parent: a.parent, children: a.children, paths: a.paths,
      files: by[a.id].length, loc: S.metricsByAgent[a.id]?.loc ?? 0,
      written: isWritten(readContext(root, a.id)), stale: st.stale, unwritten: st.unwritten,
      drift: st.changed.length + st.added.length + st.removed.length,
      openMessages: inbox(root, a.id).length,
    });
  }
  return { root, agents: out, cycles: agentCycles(S.org, S.metricsByAgent) };
}

export function touchContext(root, id) {
  const S = load(root);
  if (!S.org.agents[id]) throw new Error(`unknown agent: ${id}`);
  const files = scan(root, S.cfg, { text: false });
  touch(root, S.state, id, ownFilesOf(S.org, files)[id]);
  record(root, { type: 'context', agent: id });
}

/** The brief handed to one agent: its knowledge, its neighbours' contracts, the relevant code. */
export async function packet(root, id, task, { budget, cli = 'codeceo' } = {}) {
  const S = load(root);
  const a = S.org.agents[id];
  if (!a) throw new Error(`unknown agent: ${id}`);
  const B = budget ?? S.cfg.budget.packetTokens;
  const files = scan(root, S.cfg, { text: false });
  const by = ownFilesOf(S.org, files);
  const st = staleness(S.state, id, by[id]);
  const ctx = readContext(root, id);

  const parts = [];
  const head = [
    `# You are "${a.id}" — ${a.title} of ${a.paths.map((p) => `\`${p || '/'}\``).join(', ')}`,
    `Write scope: only files owned by you${a.children.length ? ' (child agents own their subtrees: delegate to them)' : ''}. Reading is open.`,
    a.parent ? `Reports to: \`${a.parent}\`.` : 'You are the CEO: you hold the global picture and delegate to your team.',
    `CLI: ${cli} <command>   (send, inbox, ledger add, ctx touch …)`,
    `\n## Task\n${task}`,
  ].join('\n');
  parts.push(head);

  parts.push(`## Your persistent context\n${trimTo(ctx.replace(/<!--[\s\S]*?-->/g, ''), Math.floor(B * 0.35))}`);
  if (st.unwritten || !isWritten(ctx)) parts.push('> Your context notes are still empty. After reading your code, fill Purpose / Design decisions / Gotchas, then run `codeceo ctx touch ' + id + '`.');
  else if (st.stale) parts.push(`> Your notes may be stale: ${st.changed.length} changed, ${st.added.length} new, ${st.removed.length} removed files since last review (${[...st.changed, ...st.added].slice(0, 6).join(', ')}). Re-check and \`codeceo ctx touch ${id}\` when done.`);

  // neighbour contracts, compact
  const contracts = computeContractsLite(S, root);
  const neigh = Object.keys(S.metricsByAgent[id]?.outTo ?? {}).slice(0, 6);
  if (neigh.length) {
    const lines = [];
    for (const n of neigh) {
      const sy = Object.entries(contracts[n]?.symbols ?? {}).slice(0, 12).map(([k, s]) => `  - ${k.split('#')[0]}: ${s}`);
      lines.push(`- \`${n}\` (${S.org.agents[n].paths[0] || '/'}):\n${sy.join('\n') || '  - (no explicit surface)'}`);
    }
    parts.push(`## Modules you depend on (their public contracts)\n${trimTo(lines.join('\n'), Math.floor(B * 0.2))}`);
  }

  const msgs = inbox(root, id);
  if (msgs.length) parts.push(`## Open messages for you\n${msgs.map((m) => `- [${m.id}] from \`${m.from}\` (${m.kind}): ${m.subject}${m.body ? `\n  ${m.body.replace(/\n/g, '\n  ')}` : ''}`).join('\n')}`);

  const provider = await loadProvider(root, S.cfg).catch(() => null);
  const hits = await searchShard(root, id, task, { k: S.cfg.retrieval.topK, provider });
  const used = estTokens(parts.join('\n\n'));
  let room = Math.max(0, B - used);
  const snips = [];
  for (const h of hits) {
    const t = `### ${h.file}:${h.start}-${h.end}\n\`\`\`\n${h.text}\n\`\`\``;
    const cost = estTokens(t);
    if (cost > room) continue;
    room -= cost;
    snips.push(t);
  }
  if (snips.length) parts.push(`## Most relevant code in your scope (retrieved for this task)\n${snips.join('\n\n')}`);
  else if (!by[id].length) parts.push('## Code\n(You own no files directly — your team does.)');

  const text = parts.join('\n\n');
  return { text, tokens: estTokens(text), hits: hits.map((h) => `${h.file}:${h.start}`), ownFiles: by[id].length };
}

function computeContractsLite(S, root) {
  const files = scan(root, S.cfg, { text: true });
  return computeContracts(S.org, S.cfg, files, S.graph.edges);
}

// ── integration ──────────────────────────────────────────────────────────────────────────
export function begin(root) {
  const S = load(root);
  const files = scan(root, S.cfg, { text: false });
  const snap = { ts: new Date().toISOString(), files: Object.fromEntries(files.map((f) => [f.path, f.hash])) };
  writeJson(storePath(root, 'run', 'snapshot.json'), snap);
  record(root, { type: 'begin', agent: ROOT });
  return { files: files.length, ts: snap.ts };
}

export function integrate(root, { allow = null } = {}) {
  const S = load(root);
  const snap = readJson(storePath(root, 'run', 'snapshot.json'));
  const files = scan(root, S.cfg, { text: true });
  const edges = buildEdges(files);
  const owner = makeOwner(S.org);

  const cur = Object.fromEntries(files.map((f) => [f.path, f.hash]));
  const before = snap?.files ?? {};
  const changed = [
    ...Object.keys(cur).filter((p) => before[p] !== cur[p]),
    ...Object.keys(before).filter((p) => !(p in cur)),
  ];
  const byOwner = {};
  for (const p of changed) (byOwner[owner(p)] ??= []).push(p);

  const blockers = [];
  const warnings = [];

  if (allow) for (const [o, ps] of Object.entries(byOwner)) if (!allow.includes(o)) blockers.push(`out-of-scope: ${ps.length} file(s) owned by "${o}" changed but "${o}" was not part of this run (${ps.slice(0, 3).join(', ')})`);

  // writes recorded by hooks where the writer did not own the file
  const since = snap?.ts ?? '';
  for (const e of readLedger(root)) if (e.type === 'change' && e.ts >= since && e.agent && e.agent !== owner(e.file) && S.org.agents[e.agent]) blockers.push(`conflict: ${e.agent} edited ${e.file} owned by ${owner(e.file)}`);

  const contracts = computeContracts(S.org, S.cfg, files, edges);
  const baseline = readJson(storePath(root, 'contracts.json'), {});
  const diff = diffContracts(baseline, contracts);
  for (const [id, ch] of Object.entries(diff)) {
    if (!ch.breaking) {
      warnings.push(`contract of "${id}" grew (+${ch.added.length} symbols) — accept it with: codeceo contracts accept ${id}`);
      continue;
    }
    for (const dep of Object.keys(dependentsOf(S.org, edges, id))) {
      const touched = byOwner[dep]?.length > 0;
      if (!touched) blockers.push(`breaking contract change in "${id}" (${ch.removed.length} removed, ${ch.changed.length} changed) but dependent "${dep}" was not updated`);
    }
  }
  for (const v of boundaryViolations(S.org, contracts, edges)) warnings.push(`boundary: ${v.reason}`);

  const by = ownFilesOf(S.org, files);
  for (const o of Object.keys(byOwner)) {
    const st = staleness(S.state, o, by[o]);
    if (st.stale && !st.unwritten) warnings.push(`context of "${o}" is stale — owner should review notes and run: codeceo ctx touch ${o}`);
  }

  const verdict = blockers.length ? 'blocked' : warnings.length ? 'ok-with-warnings' : 'ok';
  record(root, { type: 'integrate', agent: ROOT, verdict, changed: changed.length });
  return { verdict, changedFiles: changed.length, byOwner: Object.fromEntries(Object.entries(byOwner).map(([k, v]) => [k, v.length])), blockers, warnings };
}

export function acceptContracts(root, only = null) {
  const S = load(root);
  const files = scan(root, S.cfg, { text: true });
  const cur = computeContracts(S.org, S.cfg, files, buildEdges(files));
  const base = readJson(storePath(root, 'contracts.json'), {});
  for (const id of Object.keys(cur)) if (!only || only === id) base[id] = cur[id];
  writeJson(storePath(root, 'contracts.json'), base);
  return Object.keys(base).length;
}

export function talk(root, a, b) {
  const S = load(root);
  return canTalk(S.org, S.charter, S.metricsByAgent, a, b);
}

export { DIR, ancestors };
