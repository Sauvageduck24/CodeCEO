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
      emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CodeCEO plugin is installed but this project is not started. If the user wants module-scoped agents with persistent context, suggest `/codeceo:start` (one command; after it, ordinary messages are routed automatically).' } });
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
        unwritten ? `${unwritten} zone context(s) still empty — /codeceo:start fills them.` : '',
        stale ? `${stale} zone context(s) are stale relative to the code.` : '',
        mail ? `${mail} open inter-agent message(s) — see /codeceo:status.` : '',
        core.loadConfig(root).auto !== false
          ? 'CodeCEO mode is ON: the user just talks normally; every message about the code is routed to the owning zone agents (a per-message hint tells you how). The user can pause it with /codeceo:stop.'
          : 'CodeCEO mode is OFF (paused). Work normally; /codeceo:ask, /codeceo:change and /codeceo:start are still available.',
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
  } else if (event === 'user-prompt' && active && core.loadConfig(root).auto !== false) {
    // CodeCEO mode: every ordinary message is handled by the zone agents, with no command to type.
    const prompt = String(input.prompt ?? '').trim();
    if (prompt && !prompt.startsWith('/')) {
      const S = core.load(root);
      const route = prompt.split(/\s+/).length >= 3 ? core.route(root, S.org, prompt) : null;
      const lines = [
        '[CodeCEO mode ON] This project is run by CodeCEO. If the message asks about or changes this codebase, handle it by invoking the `codeceo:work` skill: it routes the request to the zone agents that own the code. Do not read the repository yourself first.',
        'Do NOT use CodeCEO for: requests unrelated to the code (chit-chat, general knowledge, questions about Claude or its tools), follow-ups to a flow already in progress, or when the user asks to work without CodeCEO.',
        route && `Pre-computed route (use it, skip the route step): intent=${route.intent}, complexity=${route.complexity}, zones=[${route.agents.map((a) => a.id).join(', ')}], waves=${JSON.stringify(route.waves)}${route.review ? ', integration review needed' : ''}.`,
      ].filter(Boolean);
      emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } });
    }
  } else if (event === 'stop' && active) {
    backgroundSync();
  }
} catch (e) {
  if (process.env.CODECEO_DEBUG) console.error(`codeceo hook (${event}): ${e.stack}`);
}
