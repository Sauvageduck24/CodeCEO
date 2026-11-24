---
name: status
description: Show the CodeCEO organisation — zones, who reports to whom, which contexts are stale, open messages between agents, dependency cycles and reorganisation suggestions.
argument-hint: [sync]
---

CLI (`ceo`): `node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"`

1. If `$ARGUMENTS` contains `sync`, run `ceo sync` first.
2. Run `ceo status`, `ceo reorg` and `ceo ledger log --n 10`.
3. Summarise for the user: the tree (● fresh, ◐ stale, ○ unwritten, ✉ open messages), cycles, the reorg
   suggestions worth acting on, and the last few decisions. Offer next steps: refresh stale zones with
   `/codeceo:init`, apply safe reorganisations with `ceo reorg --apply`, or adjust the organisation with
   `/codeceo:org`.

If `.codeceo/` does not exist, say so and point to `/codeceo:init`.
