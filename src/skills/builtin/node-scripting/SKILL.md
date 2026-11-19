---
name: node-scripting
description: "Migration notice for the removed privileged Node exec entry. Use javascript-scripting for current behavior."
---

The `exec` tool no longer accepts `shell: "node"`. Use `v:skills/javascript-scripting` for bounded JavaScript with Workspace-bound filesystem calls. Native Node imports, ambient environment, external programs and recursive tool orchestration are not available in the JavaScript entry.
