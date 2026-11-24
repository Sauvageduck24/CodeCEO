// Persistent per-agent context.
//
// Each agent owns `.codeceo/contexts/<id>.md`: a machine-generated FACTS block (regenerated on
// every sync, so it never rots) plus curated sections written by the owning agent (purpose,
// design decisions, gotchas). `state.json` remembers which file hashes the curated notes were
// last reviewed against, so we always know when they are stale. Commit both: a new chat, a new
// machine or a teammate resumes the exact same organisation.
import fs from 'node:fs';
import { readJson, writeJson, writeText, sha1 } from './util.mjs';
import { storePath } from './config.mjs';

const FACTS_START = '<!-- codeceo:facts:start (regenerated automatically — do not edit) -->';
const FACTS_END = '<!-- codeceo:facts:end -->';
const PENDING = '_(pending — written by the owning agent)_';

export const contextFile = (root, id) => storePath(root, 'contexts', `${id}.md`);

const skeleton = (a) => `# ${a.name} — ${a.title} (\`${a.id}\`)

${FACTS_START}
${FACTS_END}

## Purpose
${PENDING}
<!-- 2–4 sentences: what this module is for, and what it is NOT responsible for. -->

## Design decisions
${PENDING}
<!-- Non-obvious choices and WHY. Link ledger decisions when relevant. -->

## Invariants & gotchas
${PENDING}
<!-- Things a newcomer would break. Conventions the code relies on. -->
`;

export function writeFacts(root, agent, factsMd) {
  const file = contextFile(root, agent.id);
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : skeleton(agent);
  if (!text.includes(FACTS_START)) text = text.replace(/^(# .*\n)/, `$1\n${FACTS_START}\n${FACTS_END}\n`);
  const a = text.indexOf(FACTS_START);
  const b = text.indexOf(FACTS_END);
  const next = `${text.slice(0, a)}${FACTS_START}\n${factsMd.trim()}\n${text.slice(b)}`;
  if (next !== text || !fs.existsSync(file)) writeText(file, next);
}

export const readContext = (root, id) => {
  try {
    return fs.readFileSync(contextFile(root, id), 'utf8');
  } catch {
    return '';
  }
};

/** Curated part only (everything except the generated facts block). */
export function curated(text) {
  const a = text.indexOf(FACTS_START);
  const b = text.indexOf(FACTS_END);
  return (a >= 0 && b >= 0 ? text.slice(0, a) + text.slice(b + FACTS_END.length) : text).replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function purposeOf(text) {
  const m = text.match(/## Purpose\s*\n+([^\n#][^\n]*)/);
  const line = m?.[1]?.trim() ?? '';
  return line && !line.startsWith('_(pending') ? line : '';
}

export const isWritten = (text) => Boolean(purposeOf(text));

// ── state: what the curated notes were last reviewed against ─────────────────────────────
export const loadState = (root) => readJson(storePath(root, 'state.json'), { agents: {} });
export const saveState = (root, s) => writeJson(storePath(root, 'state.json'), s);

export function staleness(state, id, ownFiles) {
  const rec = state.agents[id];
  const cur = Object.fromEntries(ownFiles.map((f) => [f.path, f.hash]));
  if (!rec) return { unwritten: true, stale: true, changed: [], added: Object.keys(cur), removed: [] };
  const changed = [];
  const added = [];
  for (const [p, h] of Object.entries(cur)) {
    if (!(p in rec.files)) added.push(p);
    else if (rec.files[p] !== h) changed.push(p);
  }
  const removed = Object.keys(rec.files).filter((p) => !(p in cur));
  return { unwritten: false, stale: Boolean(changed.length || added.length || removed.length), changed, added, removed };
}

export function touch(root, state, id, ownFiles) {
  state.agents[id] = { updated: new Date().toISOString(), files: Object.fromEntries(ownFiles.map((f) => [f.path, f.hash])) };
  saveState(root, state);
}

export const fingerprint = (ownFiles) => sha1(ownFiles.map((f) => `${f.path}:${f.hash}`).sort().join('\n')).slice(0, 10);

export function archiveContext(root, id) {
  const f = contextFile(root, id);
  if (!fs.existsSync(f)) return;
  const dest = storePath(root, 'archive', `${id}-${Date.now()}.md`);
  fs.mkdirSync(storePath(root, 'archive'), { recursive: true });
  fs.renameSync(f, dest);
}
