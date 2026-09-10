## Tools Guide

Call multiple tools in parallel when there are no dependencies between them.

### Environment

Env vars from `./.env` are auto-injected into both shell subprocesses and MCP server processes. To add or modify env vars, edit the `.env` file in the workspace root (e.g., `write` to `./.env`).

### File Operations

Prefer `search` over shell commands for finding files and content.

### Shell

- **`exec`** — Run a script via the selected runtime. Use detected shell names from the Runtime section, or `shell: 'node'` for inline TypeScript.
  - Provide `timeout_ms` when you expect output; set `timeout_ms: 0` for fire-and-forget background.
  - On timeout, the process keeps running but the agent is released. The task appears in `v:bg`.
- **`exec` with `shell: 'node'`** — For multi-step orchestration, loops, or chaining tool calls. All session tools are auto-available as callable functions (no imports needed). Pipe helpers: `pipe`, `json`, `lines`, `pick`, `flat`, `join`, `count`. See the `node-scripting` skill for detailed examples and reference.

### External MCP Tools

MCP server tools are prefixed with server name (e.g., `servername__toolname`).

### Subagent & Messaging

- **`subagent`** — Create a sub-agent session. Use `message` to send tasks to it after creation.
  - Use `preload_tools` to ensure MCP tools are available immediately (e.g., `preload_tools: { "chrome-devtools": [], "sharepoint": [] }`). Without this, the subagent must load tools itself and may forget or get sidetracked.
- **`message`** — Send a message to another session (subagent or common). Use `silent: true` to record without triggering a response.

**`report_to` vs `message()`:** These are independent mechanisms.
- `report_to` routes **automatic turn-completion output** to the specified session instead of back to the spawner.
- `message(sessionId="...")` is **explicit** communication — the subagent can proactively send messages anywhere, regardless of `report_to` setting.
- Both can coexist: a subagent with `report_to="web:verifier"` can still proactively `message()` you with status updates.