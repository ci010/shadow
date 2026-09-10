---
name: project
description: "Manage long-running projects that coordinate multiple subagents with shared context, progress tracking, and verification."
metadata:
  category: scheduling
---

# Project Management

The `project` tool is lazy-loaded automatically on its first `invoke_tool` call:

```json
{
   "name": "project",
   "args": {
      "action": "create",
      "name": "my-project",
      "goal": "...",
      "context": "..."
   }
}
```

## Tool Contract

`invoke_tool.args` for `project` is an object with these fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | string | yes | `create`, `update`, `status`, `close`, or `list` |
| `name` | string | create/update/status/close | Lowercase letters, digits, and hyphens; max 64 chars |
| `goal` | string | create | One-line goal |
| `context` | string | create | Initial project context |
| `content` | string | update | Text to append or replace |
| `section` | string | no | `progress` (default), `notes`, or `full` |

## When to Use

Use projects for **multi-phase work** that needs shared context across subagents — e.g., a multi-day feature, deep research with follow-up tasks, or any work too large for a single subagent.

For simpler parallel tasks, just use `subagent` directly without a project.

## Workflow

### Phase 1 — Plan and create

1. Do a brief orientation (2-4 tool calls) to understand scope.
2. Discuss **verification criteria** with the user:
   - **Formal verification**: measurable conditions (tests pass, file exists, type checks, etc.)
   - **Human verification**: send results to user via `message` tool and wait for approval
3. Create the project:
   ```
   invoke_tool(name: "project", args: { action: "create", name: "my-project", goal: "...", context: "..." })
   ```
4. Tell the user the project is created and what you plan to do.

### Phase 2 — Execute with subagents

1. Spawn subagents scoped to the project:
   ```
   subagent(description: "...", agent_type: "sub")
   → message(sessionId: "<session-id>", content: "Your task: ...")
   ```
   Each subagent sees `project.md` and can update it.
2. Check progress: `invoke_tool(name: "project", args: { action: "status", name: "my-project" })`
3. Update progress: `invoke_tool(name: "project", args: { action: "update", name: "my-project", section: "progress", content: "..." })`
4. Spawn more subagents as needed — each picks up shared context via `project.md`.

### Phase 3 — Verify and close

1. Check all verification criteria are met.
   - All met → close the project.
   - Not met → update progress with what remains, spawn more subagents.
2. Close: `invoke_tool(name: "project", args: { action: "close", name: "my-project" })`
3. Report back to the user with highlights of what was accomplished.

## Actions

| Action | Description |
|--------|-------------|
| `create` | Create a new project with goal and context |
| `update` | Append to `progress`, `notes`, or replace `full` content |
| `status` | Read current project state |
| `close` | Mark project as complete |
| `list` | Show all active projects |

## Verification

**Verification is mandatory for projects.** Include concrete criteria in the project context when creating:

- Formal: _"`pnpm typecheck` passes"_, _"skill file exists covering X, Y, Z"_, _"all tests green"_
- Human: _"screenshot sent to user for approval"_, _"user confirms the output is correct"_

This prevents early exit and ensures subagents know when the work is truly done.

## Naming

Project names must be lowercase alphanumeric + hyphens, max 64 chars. Example: `auth-migration`, `q2-reporting`.
