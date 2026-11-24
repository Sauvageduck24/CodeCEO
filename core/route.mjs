// Query routing: who should answer or change this, in what order, and how big is the job?
import { readJson } from './util.mjs';
import { storePath } from './config.mjs';
import { scoreAgents } from './retrieve.mjs';
import { lca, makeOwner, ROOT } from './organize.mjs';

const CHANGE = /\b(add|fix|implement|refactor|rename|remove|delete|change|update|migrate|replace|create|build|optimi[sz]e|rewrite|move|a[ñn]ade|a[ñn]adir|arregla|arreglar|implementa|cambia|cambiar|elimina|borra|crea|crear|renombra|mueve|actualiza|migra|reescribe)\b/i;
const GLOBAL = /\b(architecture|overview|big picture|whole (?:app|project|system|repo)|entire (?:app|project|system|repo)|how does the (?:app|project|system) work|arquitectura|visi[oó]n general|todo el proyecto|toda la app|c[oó]mo funciona (?:el proyecto|la app|todo))\b/i;

export function detectIntent(q) {
  return CHANGE.test(q) ? 'change' : 'ask';
}

function mentionedFiles(query, manifestPaths) {
  const out = new Set();
  for (const tok of query.match(/[\w@./\\-]+\.[A-Za-z0-9]{1,6}|[\w@.-]+\/[\w@./-]+/g) ?? []) {
    const t = tok.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const p of manifestPaths) if (p === t || p.endsWith(`/${t}`)) out.add(p);
  }
  return [...out];
}

function waves(ids, metricsByAgent) {
  // providers (what others depend on) go before consumers; independent agents run together
  const left = new Set(ids);
  const out = [];
  while (left.size) {
    const ready = [...left].filter((a) => [...left].every((b) => a === b || !(metricsByAgent[a]?.outTo[b] > 0) || (metricsByAgent[b]?.outTo[a] > 0)));
    const wave = ready.length ? ready : [...left]; // cycle: run together, owners must negotiate
    out.push(wave);
    for (const w of wave) left.delete(w);
  }
  return out;
}

export function route(root, org, query, { maxAgents = 4 } = {}) {
  const routes = readJson(storePath(root, 'routes.json'));
  const graph = readJson(storePath(root, 'graph.json'), { metrics: {} });
  const manifest = readJson(storePath(root, 'manifest.json'), {});
  const intent = detectIntent(query);
  const owner = makeOwner(org);

  const raw = routes ? scoreAgents(routes, query) : {};
  // explicit file mentions are the strongest signal
  const files = mentionedFiles(query, Object.keys(manifest));
  for (const f of files) raw[owner(f)] = (raw[owner(f)] ?? 0) + 100;

  // Every agent competes on score. The CEO's own text is residual (docs, config, glue), so its score
  // is damped: it wins only for global questions or when its own files are clearly the best match.
  if (raw[ROOT] && !files.some((f) => owner(f) === ROOT)) raw[ROOT] *= 0.5;
  const ranked = Object.entries(raw).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const isGlobal = GLOBAL.test(query) || top <= 0 || Object.keys(org.agents).length === 1;

  const picked = isGlobal
    ? [[ROOT, 1]]
    : ranked.filter(([, s]) => s >= top * 0.75).slice(0, maxAgents).map(([id, s]) => [id, +(s / top).toFixed(2)]);

  const ids = picked.map(([id]) => id);
  const complexity = ids.length === 1 && ids[0] === ROOT ? 'global' : ids.length === 1 ? 'local' : 'multi';
  const plan = intent === 'change' && ids.length > 1 ? waves(ids, graph.metrics) : [ids];

  const total = Object.values(manifest).reduce((s, f) => s + f.s, 0);
  return {
    query,
    intent,
    complexity,
    coordinator: lca(org, ids),
    agents: picked.map(([id, score]) => ({ id, score, title: org.agents[id].title, paths: org.agents[id].paths })),
    waves: plan,
    review: intent === 'change' && (complexity === 'multi' || (complexity === 'global' && org.agents[ROOT].children.length > 0)),
    mentionedFiles: files,
    estimate: { wholeRepoTokens: Math.round(total / 3.7) },
  };
}
