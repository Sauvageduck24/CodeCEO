---
name: stop
description: Pause CodeCEO mode in this project, so Claude works normally again. The organisation and every context file stay; /codeceo:start turns it back on.
disable-model-invocation: true
---

CLI (`ceo`): `node "${CLAUDE_PLUGIN_ROOT}/bin/codeceo.mjs"`

Run `ceo mode off` and confirm in one line: CodeCEO mode is paused, nothing was deleted, and
`/codeceo:ask`, `/codeceo:change` and `/codeceo:status` still work. `/codeceo:start` resumes automatic routing.
