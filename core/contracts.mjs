// Contracts between modules: each agent's public surface, hashed, diffed and enforced.
import path from 'node:path';
import { extractExports, ENTRY_RE } from './lang.mjs';
import { makeOwner, ancestors } from './organize.mjs';
import { sha1 } from './util.mjs';

/**
 * Surface files of an agent: declared public files (config.public), else its entry points
 * (index.ts, __init__.py, mod.rs …), else — for flat modules — whatever others import.
 */
export function surfaceFiles(org, cfg, files, edges) {
  const owner = makeOwner(org);
  const byAgent = {};
  for (const f of files) (byAgent[owner(f.path)] ??= []).push(f);
  const importedFrom = {};
  for (const [a, b] of edges) if (owner(a) !== owner(b)) (importedFrom[owner(b)] ??= new Set()).add(b);

  const out = {};
  for (const id of Object.keys(org.agents)) {
    const mine = byAgent[id] ?? [];
    const declared = (cfg.public?.[id] ?? []).filter((p) => mine.some((f) => f.path === p));
    const entries = mine.filter((f) => f.lang && ENTRY_RE.test(f.path) && path.posix.dirname(f.path) === (org.agents[id].paths[0] || '.')).map((f) => f.path);
    const imported = [...(importedFrom[id] ?? [])];
    out[id] = { files: declared.length ? declared : entries.length ? entries : imported, strict: Boolean(declared.length || entries.length) };
  }
  return out;
}

export function computeContracts(org, cfg, files, edges) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const surf = surfaceFiles(org, cfg, files, edges);
  const out = {};
  for (const [id, s] of Object.entries(surf)) {
    const symbols = {};
    for (const p of s.files) {
      const f = byPath.get(p);
      if (!f?.lang) continue;
      for (const e of extractExports(f.lang, f.text ?? '')) symbols[`${p}#${e.name}`] = e.sig;
    }
    out[id] = { hash: sha1(JSON.stringify(Object.entries(symbols).sort())).slice(0, 12), files: s.files, strict: s.strict, symbols };
  }
  return out;
}

export function diffContracts(base, cur) {
  const changes = {};
  for (const [id, c] of Object.entries(cur)) {
    const b = base?.[id];
    if (!b || b.hash === c.hash) continue;
    const added = [];
    const removed = [];
    const changed = [];
    for (const [k, sig] of Object.entries(c.symbols)) {
      if (!(k in b.symbols)) added.push(k);
      else if (b.symbols[k] !== sig) changed.push({ symbol: k, from: b.symbols[k], to: sig });
    }
    for (const k of Object.keys(b.symbols)) if (!(k in c.symbols)) removed.push(k);
    if (added.length || removed.length || changed.length) changes[id] = { added, removed, changed, breaking: removed.length + changed.length > 0 };
  }
  return changes;
}

/** Imports that bypass a module's public surface (only checked when the surface is explicit). */
export function boundaryViolations(org, contracts, edges) {
  const owner = makeOwner(org);
  const out = [];
  for (const [from, to] of edges) {
    const a = owner(from);
    const b = owner(to);
    if (a === b) continue;
    if (ancestors(org, b).includes(a) || ancestors(org, a).includes(b)) continue; // parent<->child is fine
    const c = contracts[b];
    if (c?.strict && !c.files.includes(to))
      out.push({ from, to, importer: a, owner: b, reason: `${from} reaches into the internals of "${b}" (${to}); use its public entry point` });
  }
  return out;
}

/** Agents whose code imports from `agentId` — i.e. who must be told when its contract changes. */
export function dependentsOf(org, edges, agentId) {
  const owner = makeOwner(org);
  const deps = {};
  for (const [a, b] of edges) {
    if (owner(b) === agentId && owner(a) !== agentId) (deps[owner(a)] ??= []).push(`${a} -> ${b}`);
  }
  return deps;
}
