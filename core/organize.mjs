// Self-organising agent topology.
//
// The org chart is a deterministic function of (repo layout, dependency graph, config, charter).
// Re-running it after the code grew or shrank splits / merges agents with hysteresis, keeping
// stable ids so persistent contexts survive. The *charter* is the CEO's intent and always wins:
// it can re-parent agents, pin or freeze them, create manual agents, reassign files and give each
// agent a written mandate. More levels are NOT better: depth only grows when size demands it.
import { slugify } from './util.mjs';
import { adjacency, cycles } from './graph.mjs';

export const ROOT = 'root';

function makeTree(files) {
  const mk = (p) => ({ path: p, own: 0, total: 0, count: 0, dirs: new Map() });
  const root = mk('');
  for (const f of files) {
    const w = f.lang ? f.loc : 0; // only code counts towards module size
    const segs = f.path.split('/');
    let n = root;
    n.total += w;
    n.count++;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join('/');
      if (!n.dirs.has(p)) n.dirs.set(p, mk(p));
      n = n.dirs.get(p);
      n.total += w;
      n.count++;
    }
    n.own += w;
  }
  return root;
}

export function buildOrg(files, prev, cfg, charter = {}) {
  const c = cfg;
  const tree = makeTree(files);
  const prevAgents = prev?.agents ?? {};
  const autoByPath = new Map(Object.values(prevAgents).filter((a) => a.origin === 'auto').map((a) => [a.paths[0], a]));
  const agents = {};
  const used = new Set([ROOT]);

  const idFor = (p) => {
    const base = slugify(p);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };
  // Reuse the previous id for the same path so contexts/state stay attached.
  const stableId = (p) => {
    const prevA = autoByPath.get(p);
    if (prevA && !agents[prevA.id]) {
      used.add(prevA.id);
      return prevA.id;
    }
    return idFor(p);
  };

  const qualifies = (n) => n.total >= (autoByPath.has(n.path) ? c.minModuleLoc * c.hysteresis : c.minModuleLoc);
  const children = (n) => {
    const kids = [...n.dirs.values()].filter(qualifies);
    if (kids.length === 1 && n.own < c.minModuleLoc) {
      const deeper = children(kids[0]); // collapse wrapper dirs such as `src/`
      return deeper.length >= 2 ? deeper : [];
    }
    return kids;
  };

  const make = (n, parent, level) => {
    const id = n.path === '' ? ROOT : stableId(n.path);
    agents[id] = {
      id,
      name: n.path === '' ? 'CEO' : n.path.split('/').pop(),
      title: c.titles[Math.min(level, c.titles.length - 1)],
      level,
      parent,
      paths: [n.path],
      children: [],
      origin: 'auto',
    };
    if (parent) agents[parent].children.push(id);
    return id;
  };

  const expand = (n, id, level) => {
    const had = (prevAgents[id]?.children?.length ?? 0) > 0;
    const k = had ? 0.8 : 1;
    const big = n.total > c.maxModuleLoc * k || n.count > c.maxFilesPerModule * k;
    if (!big || level >= c.maxDepth || charter.agents?.[id]?.noSplit) return;
    for (const kid of children(n)) expand(kid, make(kid, id, level + 1), level + 1);
  };
  expand(tree, make(tree, null, 0), 0);

  applyCharter(agents, charter, c);

  const present = new Set(files.map((f) => f.path));
  const overrides = Object.fromEntries(
    Object.entries(charter.overrides ?? {}).filter(([f, id]) => present.has(f) && agents[id]),
  );
  return { version: 1, root: ROOT, agents, overrides };
}

/** Layer the CEO's intent over the derived topology. */
function applyCharter(agents, charter, c) {
  const entries = Object.entries(charter.agents ?? {});
  // 1. agents that only exist in the charter (manual)
  for (const [id, spec] of entries) {
    if (agents[id] || !spec.paths?.length) continue;
    const parent = agents[spec.parent] ? spec.parent : ROOT;
    agents[id] = { id, name: spec.name ?? id, title: 'Engineer', level: 0, parent, paths: [...spec.paths], children: [], origin: 'manual' };
    agents[parent].children.push(id);
  }
  // 2. per-agent settings
  for (const [id, spec] of entries) {
    const a = agents[id];
    if (!a) continue;
    if (spec.mandate) a.mandate = spec.mandate;
    if (spec.title) a.title = spec.title;
    if (spec.name) a.name = spec.name;
    if (spec.pinned) a.pinned = true;
    if (spec.paths?.length && a.origin === 'auto') a.paths = [...new Set([...a.paths, ...spec.paths])];
    if (spec.parent && spec.parent !== a.parent && agents[spec.parent] && id !== ROOT && !isDescendant(agents, spec.parent, id)) {
      agents[a.parent].children = agents[a.parent].children.filter((x) => x !== id);
      a.parent = spec.parent;
      agents[spec.parent].children.push(id);
    }
  }
  // 3. levels / titles follow the final shape
  const walk = (id, level) => {
    const a = agents[id];
    a.level = level;
    if (!charter.agents?.[id]?.title) a.title = c.titles[Math.min(level, c.titles.length - 1)];
    for (const k of a.children) walk(k, level + 1);
  };
  walk(ROOT, 0);
}

function isDescendant(agents, id, ofId) {
  for (let a = agents[id]; a; a = agents[a.parent]) if (a.id === ofId) return true;
  return false;
}

/** Returns file -> agent id (longest path prefix wins; overrides first). */
export function makeOwner(org) {
  const entries = [];
  for (const a of Object.values(org.agents)) for (const p of a.paths) entries.push([p, a.id]);
  entries.sort((x, y) => y[0].length - x[0].length);
  const cache = new Map();
  return (file) => {
    const o = org.overrides?.[file];
    if (o && org.agents[o]) return o;
    let id = cache.get(file);
    if (id) return id;
    id = ROOT;
    for (const [p, aid] of entries) {
      if (p === '' || file === p || file.startsWith(`${p}/`)) {
        id = aid;
        break;
      }
    }
    cache.set(file, id);
    return id;
  };
}

export const ancestors = (org, id) => {
  const out = [];
  for (let a = org.agents[id]?.parent; a; a = org.agents[a]?.parent) out.push(a);
  return out;
};

export function lca(org, ids) {
  if (!ids.length) return ROOT;
  const chains = ids.map((i) => [i, ...ancestors(org, i)]);
  return chains[0].find((a) => chains.every((c) => c.includes(a))) ?? ROOT;
}

export function isInSubtree(org, id, rootId) {
  return id === rootId || ancestors(org, id).includes(rootId);
}

/** Per-agent size and coupling metrics. */
export function metrics(org, files, edges) {
  const owner = makeOwner(org);
  const own = new Map(files.map((f) => [f.path, owner(f.path)]));
  const m = {};
  for (const id of Object.keys(org.agents)) m[id] = { id, files: 0, loc: 0, internal: 0, out: 0, in: 0, outTo: {}, inFrom: {} };
  for (const f of files) {
    const a = m[own.get(f.path)];
    a.files++;
    a.loc += f.lang ? f.loc : 0;
  }
  for (const [a, b] of edges) {
    const oa = own.get(a);
    const ob = own.get(b);
    if (!oa || !ob) continue;
    if (oa === ob) m[oa].internal++;
    else {
      m[oa].out++;
      m[ob].in++;
      m[oa].outTo[ob] = (m[oa].outTo[ob] ?? 0) + 1;
      m[ob].inFrom[oa] = (m[ob].inFrom[oa] ?? 0) + 1;
    }
  }
  for (const x of Object.values(m)) {
    const tot = x.internal + x.out;
    x.cohesion = tot ? +(x.internal / tot).toFixed(2) : 1;
    x.instability = x.in + x.out ? +(x.out / (x.in + x.out)).toFixed(2) : 0;
  }
  return m;
}

/** Cyclic dependencies between agents (excluding parent<->child edges, which are expected). */
export function agentCycles(org, m) {
  const succ = (id) => Object.keys(m[id].outTo).filter((o) => org.agents[o].parent !== id && org.agents[id].parent !== o);
  return cycles(Object.keys(org.agents), succ);
}

function components(paths, edges, minSize = 3) {
  const set = new Set(paths);
  const deg = new Map();
  const inner = edges.filter(([a, b]) => set.has(a) && set.has(b));
  for (const [a, b] of inner) {
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
  }
  const hub = Math.max(8, paths.length * 0.3); // shared utils/types would glue everything together
  const parent = new Map(paths.map((p) => [p, p]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const [a, b] of inner) if ((deg.get(a) ?? 0) <= hub && (deg.get(b) ?? 0) <= hub) parent.set(find(a), find(b));
  const groups = new Map();
  for (const p of paths) (groups.get(find(p)) ?? groups.set(find(p), []).get(find(p))).push(p);
  return [...groups.values()].filter((g) => g.length >= minSize).sort((a, b) => b.length - a.length);
}

/** Advisory reorganisation proposals beyond what buildOrg does automatically. */
export function suggest(org, files, edges, cfg) {
  const owner = makeOwner(org);
  const m = metrics(org, files, edges);
  const loc = new Map(files.map((f) => [f.path, f.lang ? f.loc : 0]));
  const out = [];

  // 1. misplaced files: most of their edges point into one other agent
  const perFile = new Map();
  for (const [a, b] of edges) {
    const oa = owner(a);
    const ob = owner(b);
    for (const [f, mine, other] of [[a, oa, ob], [b, ob, oa]]) {
      const r = perFile.get(f) ?? { mine: 0, to: {} };
      if (mine === other) r.mine++;
      else r.to[other] = (r.to[other] ?? 0) + 1;
      perFile.set(f, r);
    }
  }
  for (const [file, r] of perFile) {
    const [best, n] = Object.entries(r.to).sort((x, y) => y[1] - x[1])[0] ?? [];
    const from = owner(file);
    if (best && n >= 3 && n >= 2 * r.mine && !org.overrides?.[file] && org.agents[best].children.length === 0 && !isInSubtree(org, best, from) && !isInSubtree(org, from, best))
      out.push({ type: 'move', file, from, to: best, reason: `${n} dependencies point into ${best}, only ${r.mine} stay in ${from}` });
  }

  // 2. oversized leaves with several independent clusters
  for (const a of Object.values(org.agents)) {
    if (a.children.length || m[a.id].loc <= cfg.maxModuleLoc * 0.8) continue;
    const mine = files.filter((f) => owner(f.path) === a.id && f.lang).map((f) => f.path);
    const groups = components(mine, edges).filter((g) => g.reduce((s, p) => s + loc.get(p), 0) >= cfg.minModuleLoc);
    if (groups.length >= 2)
      out.push({ type: 'split-graph', agent: a.id, reason: `${m[a.id].loc} LOC with ${groups.length} independent clusters`, groups: groups.slice(0, 6) });
    else out.push({ type: 'oversized', agent: a.id, reason: `${m[a.id].loc} LOC and no natural seam — consider splitting by hand` });
  }

  // 3. sibling modules that mostly talk to each other
  for (const a of Object.values(org.agents)) {
    for (const [i, x] of a.children.entries())
      for (const y of a.children.slice(i + 1)) {
        const between = (m[x].outTo[y] ?? 0) + (m[y].outTo[x] ?? 0);
        const total = m[x].out + m[x].in + m[y].out + m[y].in - between;
        if (between >= 6 && between / Math.max(1, total) > 0.6 && m[x].loc + m[y].loc < cfg.maxModuleLoc)
          out.push({ type: 'merge', agents: [x, y], reason: `${between} cross dependencies, most of their coupling is with each other` });
      }
  }

  // 4. cycles
  for (const c of agentCycles(org, m)) out.push({ type: 'cycle', agents: c, reason: 'circular dependency between modules' });
  return out;
}

/** Turn accepted suggestions into charter edits (the charter, not org.json, is what persists). */
export function applySuggestions(org, charter, suggestions) {
  const next = structuredClone(charter ?? {});
  next.agents ??= {};
  next.overrides ??= {};
  const applied = [];
  for (const s of suggestions) {
    if (s.type === 'move') {
      next.overrides[s.file] = s.to;
      applied.push(s);
    } else if (s.type === 'split-graph') {
      for (const [i, g] of s.groups.entries()) {
        const id = `${s.agent}-g${i + 1}`;
        if (next.agents[id]) continue;
        next.agents[id] = { name: `${org.agents[s.agent].name}/cluster-${i + 1}`, parent: s.agent, paths: g };
      }
      applied.push(s);
    }
  }
  return { charter: next, applied };
}

export function diffOrg(a, b) {
  const A = new Set(Object.keys(a?.agents ?? {}));
  const B = new Set(Object.keys(b.agents));
  return {
    added: [...B].filter((x) => !A.has(x)),
    removed: [...A].filter((x) => !B.has(x)),
  };
}

export { adjacency };
