# Tools, skills, MCP, and automations

Shadow keeps the base tool list small. Search and read virtual paths to
discover skills or tool contracts; use `invoke_tool` for a known dynamic
tool. Search does not activate a skill or run a tool.

```js
search({ space: "grep:v:skills", query: "CSV" })
search({ space: "glob:v:tools/cron", query: "**" })
read({ path: "v:tools/cron/cron_add" })
```

Virtual `grep:` searches use JavaScript regular expressions; `glob:` searches
match paths. Results are paginated with `limit` and `offset`. Unknown mounts
fail rather than silently searching Main's filesystem. See
[tool layers](architecture.md#tools-skills-and-mcp) for their scope and
remote-workdir limitations.

For filesystem content, prefer explicit root and filter fields:

```js
search({ space: "grep", path: "src", include: "**/*.ts", query: "symbol", limit: 10 })
search({ space: "glob", path: "src", query: "**/*test.ts", limit: 10 })
```

`path` defaults to the effective workdir. Legacy `grep:*.ts` is still a file
filter; an absolute `grep:<path>` is a root, not a glob. Do not specify two roots
or two filters. File and virtual searches accept `limit` (1-100) and zero-based
`offset`; web searches do not. Ripgrep errors are failures, not "no matches".

`read` uses **one-based** line `offset`/`limit` for files, URL text and virtual
text. Local `v:sessions/<id>` line ranges use the same complete-history view as
grep, so a match's line number can be read directly. Physical segment references
returned by compact/handoff also support line ranges and exact-reference search:
their view contains that segment's full history, not the current segment or only
the most recent messages. Root session discovery still lists logical sessions.
Without a line range, session reads retain their recent-message window;
`?index=0&page_size=20` uses
message indices instead of lines. Plain URL text keeps its line structure;
`flag: "r"` preserves raw HTML. Large inline text must be paged.

## Inspect and cancel executions

`read({path: "v:bg"})` lists the current session's background work, local task/call,
and remote A2A executions. `grep:v:bg` and `glob:v:bg` search that same inventory.
Use a returned reference with `read({path: "v:bg/<executionId>"})` or
`cancel({executionId: "<executionId>"})`; background references start with `bg:`.
Keep that prefix: `bg:0123456789abcdef` is read at
`v:bg/bg:0123456789abcdef`, not `v:bg/0123456789abcdef`. The `v:bg` mount is an
inventory of several execution kinds, not an implied ID prefix. Background
downloads also return `outputPath`, which can be passed directly to `read`;
their raw `taskId` is compatibility metadata, not a public execution reference.
The old `kill` tool is removed. References do not grant access to another owner's
execution, even if its completion was routed to you.

This is a shared view, not a second task store: `v:sessions` retains history,
tasks still notify `report_to`, and blocking calls still return in their original
tool invocation. Avoid polling. Local cancellation waits for cleanup and reports
failures explicitly; remote cancellation returns the remote state. Cancellation
does not delete conversations or roll back side effects. Background completion
callbacks are suppressed on explicit cancellation; `continuation` accepts the
same `bg:` reference but does not change task/call or A2A delivery.
It only annotates a **running** background task. Completion notification is
automatic when a callback was registered; calling `continuation` after completion
reports no change and never replays the callback, including while delivery is
pending. Callback failures remain visible in the execution output; continuation
is not a delivery retry command.

## Work evidence and uncertain effects

`work` context includes `evidenceSchema`. Evidence entries are references
`{sessionId, physicalId, kind: "user" | "tool", id, quote}`, not strings or a
Decision brief. Use real recorded input/tool-call IDs and exact excerpts;
definitions may omit evidence, but completion and agent settlement still enforce
their required evidence checks.

A trusted native tool can explicitly attest to a failed operation with no
effect. For example, audio.cpp rejects malformed loader catalogs before saving
configuration, records `not_applied`, and does not leave an unknown Work effect.
Ordinary errors, failed probes, interrupted writes and arbitrary error text do
not make that guarantee: they retain the existing unknown-effect fence and
require reconciliation. This is not rollback or a blanket exemption for
validation-looking errors.

## Publish reusable apps

For a tool the user will use repeatedly, read `v:skills/micro-app` and discover
`micro_app`. It publishes immutable Project apps; the user reviews source and
permissions in coordinator **Apps** before opening. A normal button can call
the scoped model bridge without starting another agent turn. This is separate
from temporary I/O capture cards and A2A delegation. Optional local backends
have host privileges, not an OS sandbox. See [Micro Apps](microapps.md).

## Configure Project MCP servers

Use the current Project's `v:config/mcp.json` through the existing `read` and
`write` tools, not a committed source or App-wide configuration file. Read it
first to obtain its opaque `revision` and the complete `mcpServers` map:

```js
read({ path: "v:config/mcp.json" })
```

Retain unrelated entries and the returned revision when writing the complete
JSON document. For example, a new stdio entry has `command` and `args`; a
streamable HTTP entry has `type: "streamable-http"` and `url`. Optional `env`
and `headers` may contain secrets: keep credentials out of commits and chat.
Redacted placeholders from a read preserve unchanged secrets on write. A stale
revision is rejected; reread and merge rather than overwriting another edit.
The built-in `v:skills/mcp-config` skill documents exact, revision-checked edits.

Saving indexes tool metadata through temporary connections and then closes
them. Later tool search uses that index without connecting or executing;
`invoke_tool({name, args})` connects lazily, checks the live schema, and may
have side effects. An indexed server is not a guarantee it is online. MCP
loading errors surface diagnostics instead of silently retrying tool effects.

## Skills and script tools

Discover a Skill and read its exact `v:skills/<name>` path to activate any
declared script tools **for the current session only**. A skill's `SKILL.md`
defines the alias, `source`, `description`, `parameters`, and `imports`;
its module exports `async function run(args)`. Later invocations validate the
declared arguments. Reread after editing a skill to refresh its declarations;
search or bundled-resource reads alone do not activate them.

Project Skill edits use the scoped `skill_read` and `skill_save` tools. Read an
existing skill before saving so revision checks protect concurrent changes;
built-ins are read-only. Saving does not grant tool permissions or publish a
restricted conversation agent. Script execution is **not an OS sandbox**. See
[conversation agent authoring](agent-authoring.md) for the separate,
owner-reviewed publication workflow.

## Scheduled conversations

Discover `cron_add`, `cron_list`, and `cron_remove` under `v:tools/cron`;
read the selected contract, then call it via `invoke_tool`. `cron_add` takes
`schedule` and `task` and offers two contexts:

| `session` | Behavior |
| --- | --- |
| `existing` (default) | Append to the target/current durable conversation, preserving its agent and workdir |
| `fresh` | Start an independent context per run, grouped under **Automations** |

An existing job's target must be in the same Project and accessible to its
creator. A fresh job retains its Project and workdir reference, not the
conversation transcript; an unavailable remote workdir never falls back to
Main. `cron_remove` removes a definition, not retained session history.

**Upgrading old schedules:** Node cron weekdays use `0` (or `7`) for Sunday;
older Deno schedules used `1` for Sunday. The old unversioned
`<workspace>/.cron/jobs.json` array is rejected on startup without executing
or overwriting it. Back it up, review weekdays and timezone, and recreate
schedules with `cron_add`; wrapping the old array in a versioned object is not
a safe migration.
