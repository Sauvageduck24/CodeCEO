---
name: org
description: Reorganise the CodeCEO agent hierarchy in plain language — change who is responsible for what, who reports to whom, who may talk to whom, create or freeze zones, move files between zones. The CEO's control panel.
argument-hint: <what you want, e.g. "billing may not talk to catalog directly">
disable-model-invocation: true
---

# CodeCEO — the CEO's levers

CLI (`ceo`): `node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"`

The organisation is derived automatically from the code, but **your charter always wins**
(`.codeceo/charter.json`, commit it). Turn the request below into the right commands, run them, and show
the resulting tree.

Request: **$ARGUMENTS**

| Intent | Command |
|---|---|
| Define what a zone is responsible for | `ceo agent mandate <zone> "<text>"` |
| Create a zone that does not match a directory | `ceo agent add <id> --paths a,b --parent <zone> --mandate "…"` |
| Change who a zone reports to | `ceo agent move <zone> --parent <zone>` |
| Give a file to another zone | `ceo agent move-file <file> <zone>` |
| Stop a zone from splitting further / allow again | `ceo agent freeze <zone>` / `unfreeze` |
| Remove a manual zone | `ceo agent remove <zone>` |
| Let two zones talk directly / forbid it | `ceo link allow <a> <b>` / `ceo link deny <a> <b>` / `ceo link reset <a> <b>` |
| See current relations | `ceo link show` |
| Apply suggested file moves and graph splits | `ceo reorg --apply` |

Defaults to keep in mind when advising: a zone may message its parent, its children and zones it has a real
dependency edge with; everything else escalates through the closest common ancestor. Every command re-syncs,
and the affected zones' contexts are marked for review.

**More levels is not better.** Each level adds a handoff where information is lost and a brief to
build. Prefer a flat team of well-bounded zones over a deep tree; add depth only for a zone that is
genuinely too large for one agent to hold. If the request would make the hierarchy deeper than the code needs,
say so and propose the flatter alternative before running anything.

Before running a command that moves ownership of many files or re-parents a zone, state in one line what
changes and for whom. If `ceo link deny` would cut an existing dependency edge, mention that the code
dependency itself remains — only direct messaging is blocked.
