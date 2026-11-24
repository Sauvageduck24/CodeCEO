# Porting CodeCEO to another harness

The core knows nothing about Claude Code. A new harness (Codex, Pi.dev, a custom runner) needs a thin
adapter that does four things. The reference is `adapters/claude-code/hook.mjs` (about 100 lines).

| Need | Core call | Claude Code uses |
|---|---|---|
| Restore the organisation in a new session | `codeceo status --json` | `SessionStart` hook |
| Route a request | `codeceo route "<request>" --json` | the `work` skill |
| Give a worker agent its brief | `codeceo claim <zone> "<task>"` (stdout = the brief) | `module-owner` subagent |
| Enforce write scope | `echo '{"agent":"<zone>","tool":"Edit","path":"<file>"}' \| codeceo guard` → `{"ok":false,"why":"…"}` | `PreToolUse` hook |
| Trace edits | `codeceo ledger …` / `core.record()` | `PostToolUse` hook |
| Keep contexts fresh | `codeceo sync --if-changed` | `Stop` / `SubagentStop` hooks |
| Verify a change | `codeceo begin` … `codeceo integrate --allow a,b` | the `work` skill |

## Mapping notes

- **Worker agent** = any isolated agent context that can run shell commands. Its system prompt is
  `agents/module-owner.md`; it must run `codeceo claim <zone> "<task>"` first.
- **Delegation** needs a way to spawn workers. Without nesting, let the orchestrator run the waves from
  `codeceo route` itself and feed `REQUESTS`/`ESCALATE` from each report into the next wave.
- **No hooks?** Call `codeceo guard` from whatever tool-execution layer you control, or rely on
  `codeceo integrate --allow …` after the run.
- **Programmatic use**: `import * as core from 'codeceo'` exposes the same functions the CLI uses.
- **Embeddings**: set `retrieval.embeddings.module` in `.codeceo/config.json` to a module exporting
  `async embed(texts: string[]): number[][]`; run `codeceo sync --embed`. A ready provider for any
  OpenAI-compatible endpoint (including Ollama) ships in `providers/openai-compatible.mjs`.

The on-disk format (`.codeceo/`) is the contract between harnesses: a project initialised from Claude
Code works unchanged from another harness.
