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
