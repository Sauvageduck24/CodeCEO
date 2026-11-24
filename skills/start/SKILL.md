---
name: start
description: Start CodeCEO in this project. Adopts an existing project (scans it, builds one agent per module, has each agent write its persistent context file) and switches CodeCEO mode on, so from then on every ordinary message about the code is handled by the zone agents with no extra command. Also refreshes empty or stale contexts when run again.
argument-hint: [--force]
disable-model-invocation: true
---

# CodeCEO — start

CLI (`ceo`): `node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"`

After this command the user just talks normally — questions, "add X", "fix Y", refactors — and every
message about the code is routed to the zone agents. Nothing else to type.

## 1. Build the organisation

Run `ceo init $ARGUMENTS`. It scans the project, resolves imports into a dependency graph, derives one
agent per module (more levels only where the code is big enough to need them — a small project is
a single agent), and writes `.codeceo/` with one context file per zone. Show the user the printed tree.

If it says the project is already initialised, it only synced. Continue with step 2 anyway: it picks up
only zones whose context is empty or stale.

## 2. Have each zone write its own context

Run `ceo status --json`. Collect the agents where `written` is false, or `stale` is true with meaningful
`drift`. Process them **bottom-up**: all deepest-level zones in parallel (one message with several Agent
calls, at most 8 at a time), then their parents, ending with `root`. Parents quote their children's
purposes, so children go first.

Spawn `codeceo:module-owner` for each, with:

```
Zone: <zone-id>
CLI: node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"
Intent: bootstrap — do not change any code.
Task: Read your zone and write its persistent context: fill Purpose (2–4 sentences: what it is for and
what it is NOT for), Design decisions (the non-obvious ones and why), Invariants & gotchas, in
.codeceo/contexts/<zone-id>.md. Base it on the code, its tests and README/docs, not on guesses; if
something is unclear, write that. Then run `ctx touch <zone-id>`. For zones with a Team, summarise how the
children fit together instead of re-describing their code.
```

For `root`, add: *"also capture the product goal and the architecture in two paragraphs, from the README and entry points."*

## 3. Turn CodeCEO mode on and report

Run `ceo mode on`, then `ceo status` and `ceo reorg` (advisory). Tell the user, briefly:

- the organisation (tree) and how many zone contexts were written;
- **CodeCEO mode is ON**: from now on they can ask questions and request code changes exactly as they
  would with plain Claude Code; each message is routed to the owning zones automatically. `/codeceo:stop`
  pauses it, `/codeceo:status` shows the organisation, `/codeceo:org` reshapes it;
- any dependency cycles or reorganisation suggestions worth acting on;
- **commit `.codeceo/`** (it already ignores derived data) so every future chat, machine and teammate
  resumes the same organisation; the SessionStart hook restores it automatically.
