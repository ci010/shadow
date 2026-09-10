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
ephemeral: false                      # true = fire-and-forget, each spawn gets a unique session
skills: true                          # Load skills context into system prompt (default: true)
soul: false                           # Load SOUL.md (only applies to ephemeral agents)
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
| `ephemeral` | boolean | false | Fire-and-forget session per spawn |
| `skills` | boolean | true | Include skills context |
| `soul` | boolean | false | Include SOUL.md (ephemeral only) |
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
4. **Use `ephemeral: true`** for one-shot tasks that don't need conversation continuity.

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
