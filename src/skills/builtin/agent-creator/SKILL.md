---
name: agent-creator
description: "Create custom agent types by writing AGENT.md files under workspace/agents/. Use when a user wants to define a new specialized subagent type."
metadata:
  category: meta
---

# Creating Custom Agent Types

Custom agent types are defined as `AGENT.md` files placed in `workspace/agents/<agent-name>/AGENT.md`. The file watcher auto-detects changes — no restart needed.

## AGENT.md Format

```markdown
---
name: my-agent
description: One-line description shown in agent type listings
allowedTools: [read, search, exec]    # Whitelist (takes precedence over blockedTools)
blockedTools: [subagent]              # Blacklist (ignored if allowedTools is set)
defaultMode: session                  # session | task | call; callers may override
skills: true                          # Load skills context into system prompt (default: true)
soul: true                            # Load SOUL.md, independently of execution mode
model: claude-sonnet-4-20250514         # Model override (optional)
temperature: 0.7                      # Temperature override (optional)
maxTokens: 8192                       # Max tokens override (optional)
---

System prompt body goes here in markdown.

This is the full prompt the agent receives as its identity and instructions.
```

## Frontmatter Fields

All fields are optional. Minimal AGENT.md can be just a prompt body with no frontmatter.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | directory name | Agent type identifier |
| `description` | string | first 200 chars | Shown in agent type listings |
| `allowedTools` | string[] | all | Tool whitelist (takes precedence) |
| `blockedTools` | string[] | none | Tool blacklist |
| `defaultMode` | string | session | Default execution contract: session, task, or call |
| `skills` | boolean | true | Include skills context |
| `soul` | boolean | true | Include SOUL.md independently of execution mode |
| `model` | string | inherited | LLM model override |
| `temperature` | number | inherited | Sampling temperature |
| `maxTokens` | number | inherited | Max response tokens |

## Guidelines

1. **Be specific about purpose** — the description helps the parent agent choose the right type.
2. **Restrict tools** — use `allowedTools` to limit the agent to only what it needs. Common sets:
   - Read-only research: `[read, search, exec]`
   - Code editing: `[read, search, exec, write, edit]`
   - Full capability minus spawning: use `blockedTools: [subagent]`
3. **System prompt best practices**:
   - Define the agent's role clearly in the first paragraph
   - Specify output format expectations
   - Include constraints and boundaries
   - Reference the audience (parent agent vs. human)
4. **Separate role from execution** — use `defaultMode: task` when independent
   one-shot work is a good default. The same role can still run in session or call
   mode. Role prompts must not claim a fixed lifetime or always-fresh context.
5. **Migrate old definitions** — legacy `ephemeral: true` is read as
   `defaultMode: task`, and false as session, with a deprecation warning.
   Replace the old field; do not specify both. Set `soul` explicitly when needed.

`defaultMode` is a preference, not permission to bypass the caller's delegation
scope. Root sessions can create session/task; reusable sub-sessions can create
task/call; tasks can create only call. Session/task start asynchronously; calls
block their caller and cannot yield, message, delegate, or schedule deferred
coordination. Calls return missing decisions as blockers for the caller to handle.
Sub-sessions and tasks must select mode explicitly. Only a root session may omit
mode to use an allowed role default; unsupported defaults or modes fail.
If a task role should be able to use leaf calls, include `subagent` in its tool
allowlist (or do not block it); the runtime still enforces the permitted mode.

## Example: Research Agent

```markdown
---
name: researcher
description: Deep research agent for investigating topics across web and codebase
allowedTools: [read, search, exec]
---

You are a research agent. Your job is to thoroughly investigate a topic and report findings.

## Instructions
- Search broadly first, then drill into specifics
- Cite sources (file paths, URLs)
- Structure findings with clear headings
- Your audience is the parent agent — be factual and concise
```
