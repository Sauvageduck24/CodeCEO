// The charter (the CEO's intent) and the rules derived from it: who may write what,
// who may read what, and who may talk to whom.
import path from 'node:path';
import os from 'node:os';
import { globToRegExp, readJson, writeJson } from './util.mjs';
import { storePath } from './config.mjs';
import { ancestors, makeOwner, ROOT } from './organize.mjs';

export const EMPTY_CHARTER = { version: 1, agents: {}, overrides: {}, links: { allow: [], deny: [] } };

export function loadCharter(root) {
  const c = readJson(storePath(root, 'charter.json'), {});
  return { ...EMPTY_CHARTER, ...c, links: { allow: [], deny: [], ...(c.links ?? {}) } };
}
export const saveCharter = (root, charter) => writeJson(storePath(root, 'charter.json'), charter);

const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * May agent `a` message agent `b` directly?
 * Default: parent <-> child, plus any pair connected by a real dependency edge.
 * The CEO widens or narrows this with `link allow|deny`. Anything else must escalate via the LCA.
 */
export function canTalk(org, charter, metricsByAgent, a, b) {
  if (a === b) return { ok: true, why: 'self' };
  const deny = new Set(charter.links.deny.map(([x, y]) => pairKey(x, y)));
  const allow = new Set(charter.links.allow.map(([x, y]) => pairKey(x, y)));
  const k = pairKey(a, b);
  if (deny.has(k)) return { ok: false, why: 'denied by the CEO charter' };
  if (allow.has(k)) return { ok: true, why: 'allowed by the CEO charter' };
  if (org.agents[a]?.parent === b || org.agents[b]?.parent === a) return { ok: true, why: 'parent/child' };
  const m = metricsByAgent;
  if (m && ((m[a]?.outTo[b] ?? 0) > 0 || (m[b]?.outTo[a] ?? 0) > 0)) return { ok: true, why: 'dependency edge' };
  return { ok: false, why: 'no relation — escalate to your parent or a common ancestor' };
}

export function link(charter, kind, a, b) {
  const next = structuredClone(charter);
  const other = kind === 'allow' ? 'deny' : 'allow';
  const k = pairKey(a, b);
  next.links[other] = next.links[other].filter(([x, y]) => pairKey(x, y) !== k);
  if (!next.links[kind].some(([x, y]) => pairKey(x, y) === k)) next.links[kind].push([a, b]);
  return next;
}
export function unlink(charter, a, b) {
  const next = structuredClone(charter);
  const k = pairKey(a, b);
  for (const kind of ['allow', 'deny']) next.links[kind] = next.links[kind].filter(([x, y]) => pairKey(x, y) !== k);
  return next;
}

const norm = (root, p) => {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return { abs: path.normalize(abs), rel: path.relative(root, abs).split(path.sep).join('/') };
};

/** Write permission: an agent edits only the files it owns, its own context, and shared globs. */
export function canWrite({ root, org, cfg }, agentId, target) {
  const { rel } = norm(root, target);
  const owner = makeOwner(org);
  if (rel.startsWith('..')) {
    const abs = path.normalize(path.isAbsolute(target) ? target : path.join(root, target));
    return abs.startsWith(os.tmpdir()) ? { ok: true } : { ok: false, why: `outside the project (${rel})` };
  }
  if (rel === `.codeceo/contexts/${agentId}.md`) return { ok: true };
  if (rel.startsWith('.codeceo/')) return { ok: false, why: 'agents change .codeceo/ only through the `codeceo` CLI' };
  if (cfg.permissions.sharedWritable.some((g) => globToRegExp(g).test(rel))) return { ok: true };
  const o = owner(rel);
  if (o === agentId) return { ok: true };
  return { ok: false, why: `${rel} belongs to agent "${o}", not "${agentId}". Send a request to "${o}" (codeceo send) instead of editing it.` };
}

/** Read permission: open by default; `strictRead` limits to own files + dependencies + ancestors. */
export function canRead({ root, org, cfg, metricsByAgent }, agentId, target) {
  if (!cfg.permissions.strictRead) return { ok: true };
  const { rel } = norm(root, target);
  if (rel.startsWith('..') || rel.startsWith('.codeceo/')) return { ok: true };
  const o = makeOwner(org)(rel);
  const allowed = new Set([agentId, ...ancestors(org, agentId), ...Object.keys(metricsByAgent?.[agentId]?.outTo ?? {})]);
  return allowed.has(o) || o === ROOT ? { ok: true } : { ok: false, why: `strictRead: "${agentId}" may not read files of "${o}"` };
}
