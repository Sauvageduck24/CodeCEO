// Harness-neutral permission check. Any adapter (Claude Code hooks, Codex, Pi…) can call this
// with { agent, tool, path } and enforce the verdict however its platform allows.
import { load } from './engine.mjs';
import { canRead, canWrite } from './policy.mjs';

const WRITE = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'create', 'patch', 'apply_patch']);
const READ = new Set(['read', 'glob', 'grep', 'notebookread']);

export function guard(root, { agent, tool, path: target }) {
  const S = load(root);
  if (!S.org.agents[agent]) return { ok: false, why: `unknown agent "${agent}"` };
  const t = String(tool).toLowerCase();
  if (WRITE.has(t)) return canWrite(S, agent, target);
  if (READ.has(t)) return canRead(S, agent, target);
  return { ok: true };
}
