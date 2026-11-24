#!/usr/bin/env node
// CodeCEO command line. Every adapter (Claude Code, Codex, Pi…) talks to the core through this
// CLI or through the same functions in ../core. `--json` makes any command machine-readable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../core/index.mjs';
import { scan } from '../core/scan.mjs';
import { buildEdges } from '../core/graph.mjs';
import { searchShard } from '../core/retrieve.mjs';
import { readJson, estTokens } from '../core/util.mjs';
import { storePath } from '../core/config.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const CLI = `node "${fileURLToPath(import.meta.url)}"`;
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['budget', 'parent', 'paths', 'mandate', 'name', 'allow', 'agent', 'from', 'to', 'kind', 'subject', 'body', 'files', 'why', 'summary', 'n', 'root', 'title'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const [cmd, ...rest] = pos;
const root = flags.root ? path.resolve(flags.root) : core.findRoot(process.cwd());
const json = Boolean(flags.json);
const out = (obj, human) => console.log(json || !human ? JSON.stringify(obj, null, 2) : human);
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const die = (msg) => {
  console.error(`codeceo: ${msg}`);
  process.exit(1);
};

const HELP = `CodeCEO ${VERSION} — a hierarchy of module-scoped agents with persistent context

  Set up
    init                         Adopt this project: scan, build the org, write a context file per zone
    sync [--embed]               Re-scan; re-organise; refresh facts, indexes and contract checks
    status                       Org chart, stale contexts, open messages
    mode on|off|status           CodeCEO mode: route every ordinary message through the zone agents

  Work
    route "<request>"            Which agents should handle this, in what order
    packet <agent> "<task>"      The context brief for one agent  [--budget N]
    claim <agent> "<task>"       Take ownership of a zone (agents run this first) and get the brief
    begin | integrate [--allow a,b]   Snapshot before a change / verify it afterwards

  Knowledge
    ctx show <agent>             Print an agent's persistent context
    ctx touch <agent>            Mark its notes as reviewed against the current code
    ledger add --agent a --summary "…" [--why "…"] [--files f1,f2]
    ledger log [--agent a] | ledger why <file>

  Organisation (the CEO's levers)
    agent add <id> --paths p1,p2 [--parent p] [--mandate "…"]
    agent mandate <id> "<what this agent is responsible for>"
    agent move <id> --parent <agent>   |  agent move-file <file> <agent>
    agent freeze <id>            Never split this agent  |  agent unfreeze <id>
    agent remove <id>            Remove a manual agent
    link allow|deny <a> <b>      Who may message whom  |  link show
    reorg [--apply]              Suggestions to improve cohesion / coupling

  Collaboration
    send --from a --to b --subject "…" [--kind request] [--body "…"]
    inbox <agent> | ack <agent> <msgId>
    contracts [check|accept [agent]]

  Other
    graph [--mermaid]            Agent dependency graph
    bench <queries.json>         Estimate context savings vs a conventional agent
    guard                        Permission check: stdin {"agent","tool","path"} -> verdict
`;

const needInit = () => {
  if (!core.isInitialized(root)) die(`not initialised in ${root}. Run: codeceo init`);
};

function tree(s) {
  const by = Object.fromEntries(s.agents.map((a) => [a.id, a]));
  const lines = [];
  const walk = (id, pre, last) => {
    const a = by[id];
    const mark = a.unwritten || !a.written ? '○ unwritten' : a.stale ? `◐ stale (${a.drift})` : '● fresh';
    const msg = a.openMessages ? `  ✉ ${a.openMessages}` : '';
    lines.push(`${pre}${id === 'root' ? '' : last ? '└─ ' : '├─ '}${a.id}  [${a.title}]  ${a.paths[0] || '/'}  ${a.files}f ${a.loc}loc  ${mark}${msg}`);
    a.children.forEach((c, i) => walk(c, pre + (id === 'root' ? '' : last ? '   ' : '│  '), i === a.children.length - 1));
  };
  walk('root', '', true);
  return lines.join('\n');
}

async function main() {
  switch (cmd) {
    case undefined:
    case 'help':
      return console.log(HELP);
    case '--version':
    case 'version':
      return console.log(VERSION);

    case 'init': {
      if (core.isInitialized(root) && !flags.force) {
        const r = await core.sync(root);
        return out(r, `Already initialised — synced instead (${r.agents} agents, ${r.files} files). Use --force to rebuild from scratch.`);
      }
      if (flags.force) fs.rmSync(storePath(root, 'org.json'), { force: true });
      const r = await core.sync(root, { init: true });
      const s = core.status(root);
      const pending = s.agents.filter((a) => !a.written).length;
      return out({ ...r, pendingContexts: pending }, `CodeCEO initialised in ${root}\n  ${r.files} files · ${r.edges} dependencies · ${r.agents} agent(s)\n\n${tree(s)}\n\nContext files written to .codeceo/contexts/ (${pending} still need their Purpose filled by the owning agent).\nCommit the .codeceo/ folder to keep this organisation across chats and machines.`);
    }
    case 'mode': {
      needInit();
      const [sub = 'status'] = rest;
      const file = storePath(root, 'config.json');
      const cfg = readJson(file, { version: 1 });
      if (sub === 'on' || sub === 'off') {
        cfg.auto = sub === 'on';
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      } else if (sub !== 'status') die('usage: codeceo mode on|off|status');
      const on = core.loadConfig(root).auto !== false;
      return out({ auto: on }, on ? 'CodeCEO mode is ON: every ordinary message is routed to the zone agents.' : 'CodeCEO mode is OFF: Claude works normally; /codeceo:ask and /codeceo:change still work.');
    }
    case 'sync': {
      needInit();
      if (flags['if-changed']) return out(await core.syncIfChanged(root), 'checked');
      const r = await core.sync(root, { embed: Boolean(flags.embed) });
      return out(r, `synced: ${r.agents} agents · ${r.files} files · ${r.edges} deps${r.reorg.added.length ? `\n  + agents: ${r.reorg.added.join(', ')}` : ''}${r.reorg.removed.length ? `\n  − agents: ${r.reorg.removed.join(', ')}` : ''}${r.contractChanges.length ? `\n  ⚠ contract changes: ${r.contractChanges.join(', ')} (${r.notified.length} notice(s) sent)` : ''}`);
    }
    case 'status': {
      needInit();
      const s = core.status(root);
      const issues = s.cycles.map((c) => `  ⚠ dependency cycle: ${c.join(' ↔ ')}`).join('\n');
      return out(s, `${tree(s)}${issues ? `\n\n${issues}` : ''}`);
    }
    case 'route': {
      needInit();
      const q = rest.join(' ');
      if (!q) die('usage: codeceo route "<request>"');
      const S = core.load(root);
      const r = core.route(root, S.org, q);
      return out(r, `intent: ${r.intent} · complexity: ${r.complexity} · coordinator: ${r.coordinator}\n${r.agents.map((a) => `  ${a.id} (${a.score}) ${a.paths[0] || '/'}`).join('\n')}\nwaves: ${r.waves.map((w) => `[${w.join(', ')}]`).join(' → ')}${r.review ? '\nreview: yes (cross-module change)' : ''}`);
    }
    case 'packet': {
      needInit();
      const [id, ...t] = rest;
      if (!id || !t.length) die('usage: codeceo packet <agent> "<task>"');
      const p = await core.packet(root, id, t.join(' '), { budget: flags.budget ? Number(flags.budget) : undefined, cli: CLI });
      return json ? out(p) : (console.log(p.text), console.error(`\n[~${p.tokens} tokens]`));
    }
    case 'claim': {
      // The Claude Code PreToolUse hook registers the claim (it sees which subagent ran this).
      // Here we validate the id and hand the agent its brief, so the packet never passes through the CEO.
      needInit();
      const [id, ...t] = rest;
      const known = Object.keys(core.load(root).org.agents);
      if (!id || !known.includes(id)) die(`unknown agent "${id}". Known: ${known.join(', ')}`);
      const p = await core.packet(root, id, t.join(' ') || '(no task given — read your context, then wait for instructions)', { cli: CLI });
      return json ? out(p) : (console.log(p.text), console.error(`\n[claimed ${id} · ~${p.tokens} tokens]`));
    }
    case 'ctx': {
      needInit();
      const [sub, id] = rest;
      if (!id) die('usage: codeceo ctx show|touch <agent>');
      if (sub === 'show') return console.log(core.readContext(root, id) || '(no context yet)');
      if (sub === 'touch') return core.touchContext(root, id), out({ ok: true }, `context of ${id} marked as reviewed`);
      return die('usage: codeceo ctx show|touch <agent>');
    }
    case 'graph': {
      needInit();
      const S = core.load(root);
      const m = S.metricsByAgent;
      if (flags.mermaid) {
        const lines = ['graph LR'];
        for (const a of Object.values(S.org.agents)) {
          lines.push(`  ${a.id.replace(/\W/g, '_')}["${a.id}<br/>${m[a.id]?.loc ?? 0} LOC"]`);
          if (a.parent) lines.push(`  ${a.parent.replace(/\W/g, '_')} --- ${a.id.replace(/\W/g, '_')}`);
        }
        for (const [id, x] of Object.entries(m)) for (const [to, n] of Object.entries(x.outTo)) lines.push(`  ${id.replace(/\W/g, '_')} -.->|${n}| ${to.replace(/\W/g, '_')}`);
        return console.log(lines.join('\n'));
      }
      return out(m, Object.values(m).map((x) => `${x.id}: out→ ${Object.entries(x.outTo).map(([k, n]) => `${k}(${n})`).join(', ') || '—'}  cohesion ${x.cohesion}`).join('\n'));
    }
    case 'reorg': {
      needInit();
      const S = core.load(root);
      const files = scan(root, S.cfg, { text: true });
      const edges = buildEdges(files);
      const sug = core.suggest(S.org, files, edges, S.cfg.org);
      if (!flags.apply) return out(sug, sug.length ? sug.map((s) => `- ${s.type}: ${s.file ?? s.agent ?? s.agents?.join(' + ')} — ${s.reason}`).join('\n') + '\n\nApply the safe ones (moves, graph splits) with: codeceo reorg --apply' : 'Organisation looks healthy: no suggestions.');
      const { charter, applied } = core.applySuggestions(S.org, S.charter, sug);
      core.saveCharter(root, charter);
      const r = await core.sync(root);
      return out({ applied, sync: r }, `applied ${applied.length} change(s); org now has ${r.agents} agents`);
    }
    case 'agent': {
      needInit();
      const [sub, a, b] = rest;
      const ch = core.loadCharter(root);
      const S = core.load(root);
      const ensure = (id) => (ch.agents[id] ??= {});
      if (sub === 'add') {
        if (!a || !flags.paths) die('usage: codeceo agent add <id> --paths p1,p2 [--parent p] [--mandate "…"]');
        Object.assign(ensure(a), { paths: csv(flags.paths), parent: flags.parent || 'root', ...(flags.mandate ? { mandate: flags.mandate } : {}), ...(flags.name ? { name: flags.name } : {}) });
      } else if (sub === 'mandate') {
        if (!S.org.agents[a] || !b) die('usage: codeceo agent mandate <id> "<text>"');
        ensure(a).mandate = rest.slice(2).join(' ');
      } else if (sub === 'move') {
        if (!S.org.agents[a] || !flags.parent || !S.org.agents[flags.parent]) die('usage: codeceo agent move <id> --parent <agent>');
        ensure(a).parent = flags.parent;
      } else if (sub === 'move-file') {
        if (!a || !S.org.agents[b]) die('usage: codeceo agent move-file <file> <agent>');
        ch.overrides[a] = b;
      } else if (sub === 'freeze' || sub === 'unfreeze') {
        if (!S.org.agents[a]) die(`unknown agent: ${a}`);
        ensure(a).noSplit = sub === 'freeze' ? true : undefined;
      } else if (sub === 'remove') {
        if (S.org.agents[a]?.origin !== 'manual') die('only manual agents can be removed (auto agents follow the code)');
        delete ch.agents[a];
      } else die('usage: codeceo agent add|mandate|move|move-file|freeze|unfreeze|remove …');
      core.saveCharter(root, ch);
      const r = await core.sync(root);
      return out({ ok: true, agents: r.agents }, `charter updated; org now has ${r.agents} agents`);
    }
    case 'link': {
      needInit();
      const [sub, a, b] = rest;
      let ch = core.loadCharter(root);
      if (sub === 'show') return out(ch.links, `allow: ${ch.links.allow.map((p) => p.join('↔')).join(', ') || '—'}\ndeny:  ${ch.links.deny.map((p) => p.join('↔')).join(', ') || '—'}`);
      if (!['allow', 'deny', 'reset'].includes(sub) || !a || !b) die('usage: codeceo link allow|deny|reset <a> <b> | link show');
      ch = sub === 'reset' ? core.unlink(ch, a, b) : core.link(ch, sub, a, b);
      core.saveCharter(root, ch);
      return out({ ok: true }, `${a} ↔ ${b}: ${sub}`);
    }
    case 'contracts': {
      needInit();
      const [sub = 'check', only] = rest;
      if (sub === 'accept') return out({ agents: core.acceptContracts(root, only) }, `contracts accepted${only ? ` for ${only}` : ''}`);
      const S = core.load(root);
      const files = scan(root, S.cfg, { text: true });
      const edges = buildEdges(files);
      const cur = core.computeContracts(S.org, S.cfg, files, edges);
      const diff = core.diffContracts(readJson(storePath(root, 'contracts.json'), {}), cur);
      const viol = core.boundaryViolations(S.org, cur, edges);
      return out({ diff, violations: viol }, `${Object.keys(diff).length ? Object.entries(diff).map(([id, c]) => `${c.breaking ? '✗ BREAKING' : '+'} ${id}: +${c.added.length} −${c.removed.length} ~${c.changed.length}`).join('\n') : 'contracts unchanged'}${viol.length ? `\n${viol.map((v) => `⚠ ${v.reason}`).join('\n')}` : ''}`);
    }
    case 'send': {
      needInit();
      if (!flags.from || !flags.to || !flags.subject) die('usage: codeceo send --from a --to b --subject "…" [--kind request] [--body "…"]');
      const v = core.talk(root, flags.from, flags.to);
      if (!v.ok) return out({ ok: false, why: v.why }, `✗ ${flags.from} may not message ${flags.to}: ${v.why}\n  Escalate to your parent (${core.load(root).org.agents[flags.from]?.parent ?? 'root'}) instead.`);
      const m = core.send(root, { from: flags.from, to: flags.to, kind: flags.kind || 'request', subject: flags.subject, body: flags.body || '', files: csv(flags.files) });
      return out(m, `sent ${m.id} → ${flags.to}`);
    }
    case 'inbox': {
      needInit();
      const m = core.inbox(root, rest[0], { all: Boolean(flags.all) });
      return out(m, m.length ? m.map((x) => `[${x.id}] ${x.from} → ${x.to} (${x.kind}) ${x.subject}${x.body ? `\n    ${x.body.replace(/\n/g, '\n    ')}` : ''}`).join('\n') : 'inbox empty');
    }
    case 'ack': {
      needInit();
      core.ack(root, rest[0], rest[1], flags.note === true ? '' : flags.note ?? '');
      return out({ ok: true }, 'acknowledged');
    }
    case 'ledger': {
      needInit();
      const [sub, arg] = rest;
      if (sub === 'add') {
        if (!flags.agent || !flags.summary) die('usage: codeceo ledger add --agent a --summary "…" [--why "…"] [--files f1,f2]');
        const e = core.decision(root, { agent: flags.agent, summary: flags.summary, why: flags.why || '', files: csv(flags.files) });
        return out(e, `decision ${e.id} recorded`);
      }
      const all = sub === 'why' ? core.whyFile(root, arg) : core.readLedger(root).filter((e) => !flags.agent || e.agent === flags.agent);
      const list = all.slice(-(Number(flags.n) || 30));
      return out(list, list.map((e) => `${e.ts.slice(0, 16)}  ${e.type.padEnd(8)} ${e.agent ?? ''}  ${e.summary ?? e.subject ?? e.file ?? ''}${e.why ? ` — ${e.why}` : ''}`).join('\n') || '(empty)');
    }
    case 'begin':
      needInit();
      return out(core.begin(root), 'snapshot taken');
    case 'integrate': {
      needInit();
      const r = core.integrate(root, { allow: flags.allow ? csv(flags.allow) : null });
      return out(r, `integration: ${r.verdict.toUpperCase()} — ${r.changedFiles} file(s) changed in ${Object.keys(r.byOwner).join(', ') || 'no agents'}${r.blockers.map((b) => `\n  ✗ ${b}`).join('')}${r.warnings.map((w) => `\n  ⚠ ${w}`).join('')}`);
    }
    case 'bench':
      needInit();
      return bench(rest[0]);
    case 'guard': {
      needInit();
      const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      return console.log(JSON.stringify(core.guard(root, input)));
    }
    default:
      die(`unknown command "${cmd}". Run: codeceo help`);
  }
}

// Offline proxy for context savings. NOT a substitute for live end-to-end runs (see docs/EVALUATION.md).
async function bench(file) {
  const queries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const S = core.load(root);
  const files = scan(root, S.cfg, { text: false });
  const size = new Map(files.map((f) => [f.path, f.size]));
  const whole = [...size.values()].reduce((s, x) => s + x, 0) / 3.7;
  const rows = [];
  for (const q of queries) {
    const r = core.route(root, S.org, q.q);
    let routed = 0;
    for (const a of r.agents) routed += (await core.packet(root, a.id, q.q)).tokens;
    // conventional agent: reads the whole files that the best global matches live in
    const hits = [];
    for (const id of Object.keys(S.org.agents)) hits.push(...(await searchShard(root, id, q.q, { k: 6 })));
    const topFiles = [...new Set(hits.sort((a, b) => b.score - a.score).slice(0, 10).map((h) => h.file))];
    const conventional = topFiles.reduce((s, f) => s + (size.get(f) ?? 0) / 3.7, 0);
    const owners = new Set(r.agents.map((a) => a.id));
    const own = core.makeOwner(S.org);
    const routedOk = q.expectFiles ? q.expectFiles.every((f) => owners.has(own(f))) : null;
    rows.push({ q: q.q, agents: r.agents.map((a) => a.id), complexity: r.complexity, routedTokens: Math.round(routed), conventionalTokens: Math.round(conventional), reduction: conventional ? +(1 - routed / conventional).toFixed(2) : 0, routedOk });
  }
  const okRows = rows.filter((r) => r.routedOk !== null);
  const summary = {
    queries: rows.length,
    wholeRepoTokens: Math.round(whole),
    meanReduction: +(rows.reduce((s, r) => s + r.reduction, 0) / (rows.length || 1)).toFixed(2),
    routingAccuracy: okRows.length ? +(okRows.filter((r) => r.routedOk).length / okRows.length).toFixed(2) : null,
  };
  out({ summary, rows }, `${rows.map((r) => `${String(Math.round(r.reduction * 100)).padStart(4)}%  ${r.routedTokens}t vs ${r.conventionalTokens}t  [${r.agents.join(', ')}]  ${r.q}`).join('\n')}\n\nmean reduction ${Math.round(summary.meanReduction * 100)}% · whole repo ≈ ${summary.wholeRepoTokens} tokens${summary.routingAccuracy !== null ? ` · routing accuracy ${Math.round(summary.routingAccuracy * 100)}%` : ''}\n(offline proxy — see docs/EVALUATION.md for live measurements)`);
}

main().catch((e) => die(e.message));
