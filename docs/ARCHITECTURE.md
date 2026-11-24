# Architecture

CodeCEO has three layers. Only the last one knows about Claude Code.

```
core/                      pure Node, no model, no harness, no dependencies
  scan → lang → graph      files, imports, dependency edges
  organize                 the agent hierarchy, derived from code + charter
  retrieve                 per-agent BM25 shards, optional embeddings, routing index
  route                    which agents should handle a request, in which waves
  memory                   persistent per-zone context and staleness
  contracts                public surface, diff, boundary checks
  policy                   charter, write/read scopes, who may talk to whom
  ledger                   decision trace and mailboxes
  engine                   sync, packets, integration
bin/codeceo.mjs            the CLI: the stable interface for any harness
adapters/claude-code/      hooks translating Claude Code events into core calls
agents/ skills/ hooks/     the Claude Code plugin surface
```

## The organisation is derived, then steered

`org.json` is a deterministic function of **repo layout + dependency graph + config + charter**:

1. Build a directory tree weighted by lines of code.
2. A directory becomes an agent when it holds enough code (`minModuleLoc`); an agent is split into
   children only when it exceeds `maxModuleLoc` or `maxFilesPerModule`. Wrapper directories such as `src/`
   are collapsed. Hysteresis stops agents flapping around a threshold. Ids derive from paths, so contexts
   stay attached when the tree is rebuilt.
3. `charter.json` (the CEO's intent) is applied last and always wins: mandates, re-parenting, extra
   paths, frozen zones, manual agents, per-file ownership, and the allow/deny list for messaging.

`codeceo reorg` proposes improvements the automatic pass cannot see: misplaced files (most of their
dependencies point into another zone), oversized zones with independent clusters, siblings that are really
one module, and dependency cycles.

**Depth is a cost, not a goal.** Each level adds a handoff (information loss), a brief to build, and
latency. A repo under `maxModuleLoc` is one agent.

## Knowledge: persistent, scoped, selective

- **Context file** per agent: a generated *facts* block (scope, team, public surface, dependencies,
  cohesion/instability) refreshed on every sync, plus notes the owning agent curates. `state.json` records
  the file hashes the notes were last reviewed against, so staleness is exact and survives a `git pull`.
- **Retrieval** is sharded per agent (`.codeceo/index/<agent>.json`): BM25 over symbol-aware chunks, with
  path tokens. An optional provider (`retrieval.embeddings.module` exporting `embed(texts)`) adds vectors,
  fused by reciprocal rank. The graph adds structure: neighbours' contracts go into the brief.
- **Routing** uses one small document per agent (identifiers, paths, mandate, purpose, discriminative
  terms), scored with BM25, plus explicit file mentions as the strongest signal.
- **The brief** is assembled by the agent itself (`codeceo claim`), so it never passes through the CEO's
  context: that is where the multiplexing saving comes from.

## Coordination

- **Delegation** is recursive: the CEO spawns `module-owner` subagents, and an owner with a team
  delegates to its children (Claude Code allows three nested levels).
- **Horizontal messages** go through per-agent mailboxes (`codeceo send/inbox/ack`). A pair may talk if they
  are parent/child, share a real dependency edge, or the charter allows it; otherwise they escalate.
- **Waves**: provider zones before consumers, independent zones in parallel; cycles run together.
- **Contracts**: a zone's surface is its declared public files, else its entry points (`index.*`,
  `__init__.py`, `mod.rs` …), else what others import. Exports are hashed and diffed against
  `contracts.json`. A breaking change notifies every dependent; `integrate` blocks until they are updated.
- **Integration**: `begin` snapshots; `integrate` checks out-of-scope edits, non-owner writes recorded by the
  hooks, breaking contracts with un-updated dependents, boundary violations (imports bypassing a public
  entry), and stale notes. An `integration-reviewer` agent judges what tools cannot.
- **Trace**: every claim, change, message, decision and integration verdict is appended to `ledger.jsonl`;
  `codeceo ledger why <file>` answers "why is it like this?".

## Enforcement and its limits

`PreToolUse` denies `Write/Edit/MultiEdit/NotebookEdit` outside the claimed zone, and refuses edits before a
`codeceo claim`. Limits worth knowing:

- Shell commands are not path-sandboxed. A `Bash` redirect can write anywhere; `integrate` catches it afterwards.
- A claim is registered from the subagent's own `codeceo claim <id>` command, so it is honour-based but traced.
- Regex parsing misses dynamic imports, re-exports through aliases and generated code. Swap in tree-sitter behind
  `core/lang.mjs` without touching anything else.
- Routing is lexical unless an embeddings provider is configured.
