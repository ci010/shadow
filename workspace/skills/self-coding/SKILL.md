---
name: self-coding
description: Modify the shadow bot's own source code — architecture, tools, channels, skills, and internal components.
metadata:
  core: true
---

# Self-Coding

You are modifying your own source code. The shadow bot lives in the monorepo
at `packages/shadow/`.

## Architecture

### Core Loop

- `src/index.ts` — entry point, wires all subsystems together
- `src/agent/agent.ts` — Agent class, routes inbound messages to SessionLoop instances
- `src/agent/session-loop.ts` — per-session event loop, builds ExecutionContext, runs LLM loop
- `src/agent/context.ts` — ContextBuilder assembles system prompt from registered providers
- `src/agent/llm-loop.ts` — LLM ↔ tool execution cycle (async generator)

### Skills

- `src/agent/skills/loader.ts` — SkillsManager, loads from `workspace/skills/`
- `src/agent/skills/watcher.ts` — hot-reloads skills on file change, parses YAML frontmatter

### Tools

- `src/agent/tools/registry.ts` — ToolRegistry + SessionToolOverlay (per-session dynamic tools)
- `src/agent/tools/tool.ts` — Tool interface: `name`, `description`, `parameters`, `execute(args, ctx)`
- `src/agent/tools/filesystem.ts` — read, write (unified write/edit)
- `src/agent/tools/shell.ts` — exec, list_processes, await_process
- `src/agent/tools/load-tool.ts` — dynamic tool loading (MCP, scripts, factories)

### Channels

- `src/channels/base.ts` — AbstractChannel base class with admin support
- `src/channels/discord.ts`, `src/channels/feishu.ts`, `src/channels/web.ts`
- `src/channels/manager.ts` — ChannelManager, dispatches outbound messages

### Config

- `src/config/schema.ts` — Zod schemas for `bot.config.json`
- `bot.config.json` — runtime configuration

### Sessions & Memory

- `src/agent/session.ts` — SessionManager, persistent conversation storage
- `src/agent/memory.ts` — MemoryStore (long-term, daily, per-session memory)

### Message Flow

1. Channel receives external message → `handleIncoming()` → publishes to MessageBus
2. Agent.onInbound routes to SessionLoop by `channel:chatId` key
3. SessionLoop builds ExecutionContext, loads history
4. ContextBuilder assembles system prompt from providers (identity, memory, skills, etc.)
5. `runLlmLoop()` iterates LLM calls interleaved with tool execution
6. OutboundMessage published to bus → ChannelManager dispatches to channel

## Conventions

- Deno runtime, TypeScript strict mode
- `@std/path` for path operations
- Zod for config validation
- OpenTelemetry tracing via `@Span` decorator
- Tools receive `ExecutionContext` as second argument to `execute()`
- Skills use YAML frontmatter (`name`, `description`, `always`, `admin`, `tags`, `platform`, `arch`)

## Workflow: Git Worktree

**All self-coding changes MUST be made in an isolated git worktree.** Never edit
the running bot's source files directly.

### Steps

1. **Create worktree** from the repo root:
   ```bash
   git worktree add .worktrees/<branch-name> -b self-coding/<branch-name>
   ```

2. **Make changes** — use `read` and `write` with paths pointing
   into the worktree (e.g. `.worktrees/<branch-name>/packages/shadow/src/...`).

3. **Typecheck** in the worktree:
   ```bash
   cd .worktrees/<branch-name> && deno check packages/shadow/src/index.ts
   ```

4. **Run tests** (if applicable):
   ```bash
   cd .worktrees/<branch-name> && deno test packages/shadow/ --allow-all
   ```

5. **Ask user for approval** — show a summary of the changes and wait for
   explicit confirmation before merging.

6. **Merge** from the main working tree:
   ```bash
   git merge self-coding/<branch-name>
   ```

7. **Cleanup**:
   ```bash
   git worktree remove .worktrees/<branch-name>
   git branch -d self-coding/<branch-name>
   ```

After merging, the bot must be restarted to pick up source changes.
Skills in `workspace/skills/` are hot-reloaded automatically (no restart needed).
