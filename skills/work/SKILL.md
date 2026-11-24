---
name: work
description: Handle any question about, or change to, the code of a project that has CodeCEO active (a `.codeceo/` folder exists or the session briefing mentions CodeCEO). Routes the request to the zone agents that own the affected code, keeps each answer scoped to its zone, and coordinates multi-zone changes. Use instead of reading the repository yourself.
argument-hint: <question or change request>
---

# CodeCEO — work protocol

You are the **CEO**: you route, delegate and integrate; you do not read zone code yourself. Each zone
agent has its own persistent context, so the conversation here stays small and nothing gets lost
between zones.

Request: **$ARGUMENTS**

CLI (call it `ceo` below): `node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"`

## 0. Preconditions

If `.codeceo/org.json` does not exist, stop and tell the user to run `/codeceo:init` first.

## 1. Route

```
ceo route "<the request, verbatim>"
```

Read `intent` (`ask` or `change`; if the invoking skill forced one, use that), `complexity`,
`agents`, `waves`, `review`. Trust the router, but override it when the user clearly named a zone
or file it missed. Tell the user the routing in one line, e.g. *"→ billing (local change)"*.

## 2. Delegate

Spawn **`module-owner`** subagents (agent type `codeceo:module-owner`) with the Agent tool. One per zone
in the current wave; **all agents of a wave in a single message** so they run in parallel. Give each
only this, nothing more (the brief is built by the agent itself, so the code never enters your context):

```
Zone: <zone-id>
CLI: node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"
Intent: <ask — read-only, do not edit | change — edit only your zone>
Task: <the part of the request that concerns this zone, self-contained>
Related zones: <other zones involved in this request, so the agent knows who to message>
```

- **ask**: owners must not edit. If several zones answer, you merge the answers, attributing each to its zone.
- **change** across several zones: run the waves in order (`waves` lists providers before consumers). Before
  wave 1 run `ceo begin`. Pass the new contract from a finished provider to its dependents in their task.
- A **global** request (architecture, overview) goes to `root`, which already holds its team's summaries.
- If a zone has a *Team*, its owner delegates to its children itself (nested subagents).

## 3. Close the loop

1. Read each report (`ANSWER/SUMMARY`, `CHANGED`, `CONTRACT`, `REQUESTS`, `ESCALATE`).
2. **REQUESTS / ESCALATE** → they mean another zone must act. Spawn that zone as the next wave (max 3 rounds), then continue.
   If an agent was refused permission to message someone, route it through their common ancestor yourself.
3. **change only**: run `ceo integrate --allow <zones that took part>`.
   - `blocked` → send the named zones back to fix the blockers (a new wave).
   - the change touched more than one zone (`review: true`) → also spawn `codeceo:integration-reviewer`, and act on its verdict.
   - Contract growth the reviewer calls intentional → `ceo contracts accept <zone>`.
4. Make sure every zone that changed refreshed its context notes (owners do this; check `ceo status` shows no stale zones you touched).

## 4. Answer the user

Short and concrete: what was found or done, per zone only when it matters, which files changed, anything
that needs their decision. Do not paste agent reports verbatim.

## Rules

- Never edit zone files from this thread when a zone agent can; the point is scoped ownership and a trace.
- A trivial request that clearly touches one file the user named still goes through its owner — it is cheap
  (a brief of a few thousand tokens) and keeps the zone's notes and the ledger accurate.
- Do not load more than the routed zones. If the router returns nothing useful, ask `root`.
