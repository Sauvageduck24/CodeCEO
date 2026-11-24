import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../core/index.mjs';
import { makeRepo } from './helpers.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'claude-code', 'hook.mjs');

const run = (event, input) => {
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), encoding: 'utf8' });
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const verdict = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'allow';

test('hook: subagents must claim a zone, then may only edit their own files', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const base = { cwd: root, agent_id: 'sub-1', agent_type: 'codeceo:module-owner' };
  const edit = (file) => run('pre-tool-use', { ...base, tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } });

  assert.equal(verdict(edit('src/billing/charge.js')), 'deny', 'no claim yet');
  assert.match(edit('src/billing/charge.js').hookSpecificOutput.permissionDecisionReason, /claim/);

  run('pre-tool-use', { ...base, tool_name: 'Bash', tool_input: { command: 'node "/x/bin/codeceo.mjs" claim src-billing "fix it"' } });
  assert.equal(verdict(edit('src/billing/charge.js')), 'allow');
  const other = edit('src/auth/login.js');
  assert.equal(verdict(other), 'deny');
  assert.match(other.hookSpecificOutput.permissionDecisionReason, /src-auth/);

  run('post-tool-use', { ...base, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/billing/charge.js') } });
  assert.ok(core.readLedger(root).some((e) => e.type === 'change' && e.agent === 'src-billing' && e.file === 'src/billing/charge.js'));

  run('subagent-stop', base);
  assert.equal(verdict(edit('src/billing/charge.js')), 'deny', 'claim released');
  rm();
});

test('hook: the main thread and foreign agents are never restricted', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const target = { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/auth/login.js') } };
  assert.equal(verdict(run('pre-tool-use', { cwd: root, ...target })), 'allow');
  assert.equal(verdict(run('pre-tool-use', { cwd: root, agent_id: 'x', agent_type: 'general-purpose', ...target })), 'allow');
  rm();
});

test('hook: session start restores the organisation in a new chat', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const out = run('session-start', { cwd: root });
  assert.match(out.hookSpecificOutput.additionalContext, /CodeCEO is active.*5 agent/s);
  assert.match(out.hookSpecificOutput.additionalContext, /src-billing/);
  rm();
});

test('hook: projects without CodeCEO are left alone', () => {
  const { root, rm } = makeRepo();
  assert.equal(verdict(run('pre-tool-use', { cwd: root, agent_id: 'a', agent_type: 'codeceo:module-owner', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'x.js') } })), 'allow');
  rm();
});

test('hook: in CodeCEO mode every ordinary message is routed with no command typed', async () => {
  const { root, rm } = makeRepo();
  await core.sync(root, { init: true });
  const out = run('user-prompt', { cwd: root, prompt: 'fix the stripe payment invoice rounding' });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /CodeCEO mode ON/);
  assert.match(ctx, /codeceo:work/);
  assert.match(ctx, /intent=change.*zones=\[src-billing\]/s, 'route precomputed by the hook');

  assert.equal(run('user-prompt', { cwd: root, prompt: '/codeceo:status' }), null, 'slash commands untouched');

  // pausing the mode makes the hook silent; the organisation stays
  const cli = path.join(path.dirname(HOOK), '..', '..', 'bin', 'codeceo.mjs');
  spawnSync(process.execPath, [cli, 'mode', 'off', '--root', root]);
  assert.equal(run('user-prompt', { cwd: root, prompt: 'fix the stripe payment invoice rounding' }), null);
  assert.match(run('session-start', { cwd: root }).hookSpecificOutput.additionalContext, /mode is OFF/);
  spawnSync(process.execPath, [cli, 'mode', 'on', '--root', root]);
  assert.ok(run('user-prompt', { cwd: root, prompt: 'explain the overall architecture please' }));
  rm();
});
