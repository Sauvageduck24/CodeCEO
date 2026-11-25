// Selective retrieval. Every agent owns its own BM25 shard (so a query against one module never
// loads — or pays for — the rest of the repo). An optional embeddings provider adds a semantic
// layer; the dependency graph adds structural expansion.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from './util.mjs';
import { storePath } from './config.mjs';

const STOP = new Set(
  ('the a an and or of to in on for with is are was be this that it as at by from not no if then else return ' +
    'var let const function def class import export true false null none new del el la los las un una y o de del ' +
    'en con por para que es se su al lo como mas pero sus le ya ' +
    'how does do did what why where when which who whom fix add change make use using work works explain show ' +
    'want need please can could would should code file files function please quiero necesito explica arregla ' +
    'cambia haz hacer funciona donde cuando').split(' '),
);

const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export function tokenize(text) {
  const out = [];
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const raw of t.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((s) => s.toLowerCase())
      .filter(Boolean);
    if (parts.length > 1 && raw.length <= 40) out.push(raw.toLowerCase());
    for (const p of parts) if (p.length >= 2 && !STOP.has(p)) out.push(stem(p));
  }
  return out;
}

const DECL = /^(?:export |pub |public |async |def |class |func |fn |function |interface |type |impl |module |struct |enum )/;

export function chunkFile(file, maxLines = 60) {
  const lines = file.text.split('\n');
  const chunks = [];
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    const len = i - start;
    const boundary = i === lines.length || len >= maxLines || (len >= 18 && DECL.test(lines[i] ?? ''));
    if (!boundary) continue;
    const text = lines.slice(start, i).join('\n');
    if (text.trim()) chunks.push({ s: start + 1, e: i, text });
    start = i;
  }
  return chunks;
}

export function buildShard(agentId, files, cfg, vectors = null) {
  const docs = [];
  const post = Object.create(null); // null prototype: tokens like "constructor" must not hit Object.prototype
  const df = Object.create(null);
  let total = 0;
  for (const f of files) {
    const pathToks = tokenize(f.path);
    for (const ch of chunkFile(f, cfg.retrieval.chunkLines)) {
      const toks = [...tokenize(ch.text), ...pathToks, ...pathToks];
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      const idx = docs.length;
      docs.push({ f: f.path, s: ch.s, e: ch.e, l: toks.length, h: ch.hash });
      total += toks.length;
      for (const [t, n] of tf) {
        (post[t] ??= []).push([idx, n]);
        df[t] = (df[t] ?? 0) + 1;
      }
    }
  }
  return { agent: agentId, n: docs.length, avg: docs.length ? total / docs.length : 0, docs, df, post, vec: vectors };
}

export const saveShard = (root, shard) => writeJson(storePath(root, 'index', `${shard.agent}.json`), shard);
export const loadShard = (root, id) => readJson(storePath(root, 'index', `${id}.json`));

export function bm25(shard, qTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const scores = new Map();
  for (const q of new Set(qTokens)) {
    const p = Object.hasOwn(shard.post, q) ? shard.post[q] : null;
    if (!p) continue;
    const idf = Math.log(1 + (shard.n - shard.df[q] + 0.5) / (shard.df[q] + 0.5));
    for (const [d, tf] of p) {
      const len = shard.docs[d].l;
      scores.set(d, (scores.get(d) ?? 0) + (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / (shard.avg || 1))));
    }
  }
  return scores;
}

export async function loadProvider(root, cfg) {
  const spec = cfg.retrieval?.embeddings;
  if (!spec?.module) return null;
  const mod = await import(pathToFileURL(path.resolve(root, spec.module)).href);
  return { embed: mod.embed, name: spec.module };
}

export const cosine = (a, b) => {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return d / (Math.sqrt(x * y) || 1);
};

/**
 * Hybrid search inside ONE agent's shard. Returns the best chunks (with text re-read from disk).
 * Lexical BM25 always; if the shard has vectors and a provider is given, fused by RRF.
 */
export async function searchShard(root, agentId, query, { k = 8, provider = null } = {}) {
  const shard = loadShard(root, agentId);
  if (!shard || !shard.n) return [];
  const lex = [...bm25(shard, tokenize(query)).entries()].sort((a, b) => b[1] - a[1]).slice(0, k * 3);
  let ranked = lex.map(([d, s]) => ({ d, s }));

  if (provider && shard.vec) {
    const [qv] = await provider.embed([query]);
    const sem = shard.vec.map((v, d) => ({ d, s: cosine(qv, v) })).sort((a, b) => b.s - a.s).slice(0, k * 3);
    const rrf = new Map();
    for (const list of [ranked, sem]) list.forEach((x, i) => rrf.set(x.d, (rrf.get(x.d) ?? 0) + 1 / (60 + i)));
    ranked = [...rrf.entries()].map(([d, s]) => ({ d, s })).sort((a, b) => b.s - a.s);
  }

  const hits = [];
  const cache = new Map();
  for (const { d, s } of ranked.slice(0, k)) {
    const doc = shard.docs[d];
    if (!cache.has(doc.f)) {
      try {
        cache.set(doc.f, fs.readFileSync(path.join(root, doc.f), 'utf8').split('\n'));
      } catch {
        cache.set(doc.f, null);
      }
    }
    const lines = cache.get(doc.f);
    if (!lines) continue;
    hits.push({ file: doc.f, start: doc.s, end: Math.min(doc.e, lines.length), score: +s.toFixed(3), text: lines.slice(doc.s - 1, doc.e).join('\n') });
  }
  return hits;
}

// ───────── routing index: one small "document" per agent, for choosing who should answer ─────────
export function buildRoutes(agentDocs) {
  // agentDocs: { id: { text, weightedText } }
  // pass 1: full term frequencies and document frequencies over agents
  const full = {};
  const df = Object.create(null);
  for (const [id, d] of Object.entries(agentDocs)) {
    const tf = Object.create(null);
    for (const t of tokenize(d.text)) tf[t] = (tf[t] ?? 0) + 1;
    for (const t of tokenize(d.boost)) tf[t] = (tf[t] ?? 0) + 4;
    full[id] = tf;
    for (const t of Object.keys(tf)) df[t] = (df[t] ?? 0) + 1;
  }
  // pass 2: keep the most DISCRIMINATIVE terms (tf·idf), not merely the most frequent ones
  const n = Object.keys(full).length;
  const agents = {};
  const keptDf = Object.create(null);
  for (const [id, tf] of Object.entries(full)) {
    const top = Object.entries(tf)
      .map(([t, f]) => [t, f, f * Math.log(1 + n / df[t])])
      .sort((a, b) => b[2] - a[2])
      .slice(0, 2000);
    agents[id] = { len: top.reduce((s, [, f]) => s + f, 0), tf: Object.fromEntries(top.map(([t, f]) => [t, f])) };
    for (const [t] of top) keptDf[t] = (keptDf[t] ?? 0) + 1;
  }
  const lens = Object.values(agents).map((a) => a.len);
  return { n, avg: lens.reduce((s, x) => s + x, 0) / (lens.length || 1), df: keptDf, agents };
}

export function scoreAgents(routes, query) {
  const q = new Set(tokenize(query));
  const out = {};
  for (const [id, a] of Object.entries(routes.agents)) {
    let s = 0;
    for (const t of q) {
      const tf = Object.hasOwn(a.tf, t) ? a.tf[t] : 0;
      if (!tf) continue;
      const idf = Math.log(1 + (routes.n - routes.df[t] + 0.5) / (routes.df[t] + 0.5));
      // soft length normalisation (b = 0.3): a big module is not "less relevant" for being big
      s += (idf * tf * 2.2) / (tf + 1.2 * (0.7 + (0.3 * a.len) / (routes.avg || 1)));
    }
    out[id] = s;
  }
  return out;
}
