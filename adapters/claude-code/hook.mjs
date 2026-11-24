#!/usr/bin/env node
// Claude Code adapter. The only file that knows Claude Code's hook protocol; all decisions come
// from the harness-neutral core. Fails open: a hook problem must never block the user's work.
//
//   session-start  → resume the organisation in a new chat (inject a short briefing)
//   pre-tool-use   → enforce write scopes for module-owner subagents; register `claim`s
//   post-tool-use  → trace every edit in the ledger
//   subagent-stop  → release the claim
//   stop           → keep contexts fresh (background sync, only if files changed)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../../core/index.mjs';
import { readJson, writeJson } from '../../core/util.mjs';
import { storePath } from '../../core/config.mjs';

const event = process.argv[2];
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'codeceo.mjs');
const OWNER_TYPES = /(?:^|:)module-owner$/;

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}

const emit = (obj) => process.stdout.write(JSON.stringify(obj));
const root = core.findRoot(input.cwd || process.cwd());
const active = core.isInitialized(root);
const claimsFile = () => storePath(root, 'run', 'claims.json');
const claims = () => readJson(claimsFile(), {});
const rel = (p) => path.relative(root, path.isAbsolute(p) ? p : path.join(input.cwd || root, p)).split(path.sep).join('/');

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function backgroundSync() {
  try {
    spawn(process.execPath, [CLI, 'sync', '--if-changed', '--root', root], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

try {
  if (event === 'session-start') {
    if (!active) {
      emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CodeCEO plugin is installed but this project is not initialised. If the user wants module-scoped agents with persistent context, suggest `/codeceo:init`.' } });
    } else {
      await core.syncIfChanged(root).catch(() => {});
      const s = core.status(root);
      const top = s.agents.filter((a) => a.parent === 'root');
      const unwritten = s.agents.filter((a) => !a.written).length;
      const stale = s.agents.filter((a) => a.written && a.stale).length;
      const mail = s.agents.reduce((n, a) => n + a.openMessages, 0);
      const lines = [
        `CodeCEO is active in this project: ${s.agents.length} agent(s), organisation restored from .codeceo/.`,
        top.length ? `Top-level zones: ${top.map((a) => `${a.id} (${a.paths[0]})`).join(', ')}.` : 'Single-agent project (small enough for one zone).',
        unwritten ? `${unwritten} zone context(s) still empty — /codeceo:init fills them.` : '',
        stale ? `${stale} zone context(s) are stale relative to the code.` : '',
        mail ? `${mail} open inter-agent message(s) — see /codeceo:status.` : '',
        'For questions about the code or changes to it, use /codeceo:ask or /codeceo:change (or the codeceo:work skill) instead of reading the whole repo yourself: they route to the owning zone agents and keep your context small.',
      ].filter(Boolean);
      emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
    }
  } else if (event === 'pre-tool-use' && active && input.agent_id && OWNER_TYPES.test(input.agent_type ?? '')) {
    const tool = input.tool_name;
    const known = claims();
    if (tool === 'Bash') {
      const m = String(input.tool_input?.command ?? '').match(/codeceo(?:\.mjs)?["']?\s+claim\s+([\w.-]+)/);
      if (m) {
        if (!core.load(root).org.agents[m[1]]) deny(`CodeCEO: unknown agent "${m[1]}".`);
        else {
          const taken = Object.entries(known).find(([aid, id]) => id === m[1] && aid !== input.agent_id);
          writeJson(claimsFile(), { ...known, [input.agent_id]: m[1] });
          core.record(root, { type: 'claim', agent: m[1], runtime: input.agent_id, shared: Boolean(taken) });
        }
      }
    } else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
      const id = known[input.agent_id];
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (!id) deny('CodeCEO: claim your zone first by running `codeceo claim <your-agent-id> "<task>"` (see the CLI path in your instructions).');
      else if (target) {
        const v = core.guard(root, { agent: id, tool, path: target });
        if (!v.ok) deny(`CodeCEO scope: ${v.why}`);
      }
    }
  } else if (event === 'post-tool-use' && active && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(input.tool_name ?? '')) {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (target) {
      const agent = input.agent_id ? claims()[input.agent_id] ?? null : 'main';
      core.record(root, { type: 'change', agent, file: rel(target), tool: input.tool_name });
    }
  } else if (event === 'subagent-stop' && active && input.agent_id) {
    const c = claims();
    if (c[input.agent_id]) {
      delete c[input.agent_id];
      writeJson(claimsFile(), c);
    }
    backgroundSync();
  } else if (event === 'stop' && active) {
    backgroundSync();
  }
} catch (e) {
  if (process.env.CODECEO_DEBUG) console.error(`codeceo hook (${event}): ${e.stack}`);
}
