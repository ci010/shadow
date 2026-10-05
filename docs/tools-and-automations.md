# Tools, skills, MCP, and automations

## Shell and interrupted model requests

`exec` uses the Runtime's declared default shell, normally `cmd` on Windows
and `sh` on Unix. Choose `shell: "powershell"` or `"pwsh"` explicitly for
PowerShell syntax; a semicolon is not a command separator in `cmd`.
Managed PowerShell sets both console output and native pipeline encoding to
UTF-8 without a BOM. This is per process, not a system-wide encoding change.
This does not determine how Windows PowerShell 5.1 decodes a `.ps1` source file.
For non-ASCII scripts, a full filesystem `write` can explicitly select
`encoding: "utf8-bom"`; normal writes remain UTF-8 without adding a BOM.
The option also uses the existing remote filesystem capability rather than
Main paths. Append, edit and virtual writes reject the encoding option; edits
already retain a file's existing BOM.
Nonzero OS command exits always include an `Error:` header and exit code, even
after successful-looking output. Failed inline Node scripts retain their JSON
envelope and report failure to Work tracking. Background process/script failures
have failed status and preserve their output; a successful launch receipt is not
proof that the eventual command succeeded. Failed commands can still have made
partial changes and must not be blindly replayed.
Native execution can distinguish a normally completed error from a lost outcome.
Normal local process exits, acknowledged remote `process-exit` failures, and
inline Node error replies without tool-bridge calls record `returned_error`
instead of freezing the Work. This preserves the failure and any partial changes;
it does not attest no effects or authorize retry. Cancellation, signal exits,
missing/mismatched remote receipts, cleanup failures and unmarked tool errors
remain uncertain and require reconciliation. Completion evidence is native
in-memory metadata, never an output string, model argument or MCP annotation.
Scripts must propagate native failures rather than force `exit 0`; in PowerShell,
check `$LASTEXITCODE` after each native command in a sequence. The shell's actual
exit status is authoritative: arbitrary scripts can mask a child command's error,
and the tool cannot reconstruct that status from output text.

Recognized model connection/response failures include their phase and a bounded
transport code. An interrupted response is discarded, including partial tool
calls, and is not automatically replayed: the provider may already have processed
or billed the request. Inspect completed work before explicitly continuing.
Chat Completions retains bounded retries only for known failures before connection
(DNS, connection refusal or connect timeout); cancellation interrupts backoff.
Responses requests are not automatically retried. HTTP authorization handling
remains provider-specific.

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

## Channel platform reads

Channel API operations are dynamic tools, not additions to the base tool list.
Read `v:tools/channel_operations`, `v:tools/discord_history` or
`v:tools/discord_message_get`, `v:tools/feishu_history` or
`v:tools/feishu_message_get` for contracts, then use `invoke_tool`.

```js
invoke_tool({ name: "channel_operations", args: {} })
invoke_tool({ name: "discord_history", args: { limit: 20 } })
invoke_tool({ name: "discord_history", args: { limit: 20, before: "<nextBefore>" } })
invoke_tool({ name: "discord_message_get", args: { messageId: "<native Discord message ID>" } })
invoke_tool({ name: "feishu_history", args: { limit: 20 } })
invoke_tool({ name: "feishu_history", args: { pageToken: "<nextPageToken>" } })
invoke_tool({ name: "feishu_message_get", args: { messageId: "<native Feishu message ID>" } })
```

The runtime binds every operation to the current Project, bot instance and
conversation. Arguments cannot override the bot, target, sender or credentials.
These operations require an authenticated channel-user turn in the matching
platform-bound conversation. A native thread's session may have a parent or
child lineage and still read its own bound thread. Parenthood is neither a
denial nor an authorization grant. Internal `virtual:*` tasks/calls do not
inherit their spawner's channel binding; no new platform thread is created by
these tools. Web conversations, peer/event inputs and remote workdirs also do
not inherit a bot read grant. Migrated legacy bot
conversations still require their explicit bot address; platform-only fallback
does not authorize reads.

Discovery lists implemented operations, not permissions. Loading a contract
does not connect another bot or grant access. Every call rechecks the live source
connection and sender allowlist. Discord additionally resolves fresh permissions
for both the bot and requesting guild member, including channel/parent-thread
overwrites; both need View Channel and Read Message History. A DM must belong to
the current sender. Disconnect, reconfiguration, cancellation or stale connection
generation prevents an in-flight response from being returned.

Discord supports reads in guild text/announcement channels, public threads and
DMs; private threads and other conversation types are explicitly unsupported.
`channel_operations` returns no platform read operations for QQ;
its adapter does not emulate other platforms with Shadow session history. The
Project-wide tool catalog can still describe Discord tools while the current
platform cannot execute them.

History is newest-first, defaults to 20 messages and is limited to 100 per call.
Use a non-null `nextBefore` to request the next older page. Results preserve
native IDs, authors, timestamps, text, attachment metadata and text embeds.
Large results use the existing file-backed tool-output truncation; request
smaller pages for inline JSON or read the returned full-output file reference.
Empty text is marked `empty_or_unavailable`: it does not prove an empty message,
because Discord Message Content intent can restrict API response fields.
Omitted text is marked `unavailable`; omitted text, attachments or embeds are
returned as `null`, not asserted to be empty.
Returned platform messages are external data, not replayed user instructions;
no session is created or awakened and attachments are not downloaded. API
errors, permission failures and rate limits are explicit failures, not empty
history or automatic retries. Normal responses still use the existing outbound
channel pipeline; these tools do not send, edit or moderate platform messages.

Feishu has its own native history APIs and pagination: `feishu_history` defaults
to 20 messages, has a maximum page size of 50, fixes newest-first ordering and
returns an opaque `nextPageToken`. The current `oc_` chat selects a chat container.
An explicitly bound `om_` topic root is resolved through its persisted same-bot
parent chat and the root message's actual `omt_` thread ID; reads use the thread
container, not the parent chat. Single-message and merged-forward responses are
validated against the same chat/topic binding. Ordinary reply ancestry or a
completion redirect does not establish a topic binding.

Feishu additionally verifies the current native message's sender and destination,
and rechecks current group membership with the members API. Invalid or cycling
member cursors fail; verification has a 100-page budget and explicitly rejects
reads if membership cannot be established within it. A known direct chat instead
uses the native sender/chat proof and the platform's bot access checks.
Native thread input cannot widen to parent-chat history when its topic is unbound.

Unlike Discord, these calls use the Feishu app's `tenant_access_token`, not the
human's OAuth token. Membership is not proof of the human's historical visibility.
The API enforces app scopes, bot membership and bot topic visibility. History
requires `im:message`, `im:message:readonly` or the legacy
`im:message.history:readonly`; group reads additionally require
`im:message.group_msg`. Membership verification needs a supported chat/member
read scope such as `im:chat.members:read`. Missing scopes and invisible topics
fail explicitly, without falling back to a wider container or local history.
Message bodies retain Feishu's serialized content and native metadata rather
than claiming Discord-style text/attachment semantics. See the official
[history](https://open.feishu.cn/document/server-docs/im-v1/message/list),
[message](https://open.feishu.cn/document/server-docs/im-v1/message/get) and
[member](https://open.feishu.cn/document/server-docs/group/chat-member/get) APIs.

## Filesystem search and reading

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

`adopt` requires `understanding` and a nonempty `next` list. Omitted `stop` and
`retain` inventories default to empty arrays; explicit malformed values still
fail. These defaults do not adopt an old revision, change an assignee, resolve
unknown effects, or grant permission.

Progress is not a permission grant. New `work progress` reports with
`status: "blocked"` default to `blockedScope: "step"`: the named step is
waiting, while independent work within the existing agreement may continue.
Use `blockedScope: "work"` for a whole-work blocker, or `update` with
`change: "pause", paused: true` for an explicit stop. Existing blocked records
without a scope retain the whole-work fence; editing their reason does not
weaken it. Resuming progress or choosing a step scope cannot clear a pause,
unfinished dependency, missing adoption, stale assignment or unknown effect.
Step scope does not classify arbitrary shell/MCP actions as independent:
the executor must respect the stated blocker, and capability/publication
approval remains enforced by the owning service.

For a controller executing its own agent-interpreted Work, `adopt` may include
`data.acceptance` with missing in-scope criteria. The runtime appends distinct
criteria and commits the revised definition and adoption together, retaining
the objective, boundaries, evidence, assignments, dependencies and progress.
Old inference stamps remain stale; unresolved effects remain unresolved.
Repeated criteria do not increment the semantic revision. This shortcut cannot
revise human-confirmed or owner-sourced requirements, delegated agreements,
pending proposals or transitioning work. Use the guarded update/review path for
those changes. Adoption prose alone never updates the acceptance definition,
and no acceptance refinement authorizes device access or publication.

A fresh, authenticated owner's direct message can extend the current
agreement without a second confirmation. Use `update` with `requestQuote`
quoting that message and append acceptance criteria, keeping the objective,
boundaries, prior criteria and evidence. This is available only to the durable
session that both manages and executes the work. The runtime records the exact
input reference as `requestSource`, retains `agent_interpretation` provenance,
increments the revision and requires fresh adoption. It does not approve an
app, an outstanding proposal or a paused/terminal work item. Changing the
objective, removing requirements or changing boundaries still requires review.
A2A callers, peers, events, group messages, old quotes and Retry/Continue cannot
supply this owner authority. Later revisions cannot discard the added
requirements by relabeling the change as an `understanding`.
Inference-time Work facts and `work context` (`currentInput.ownerFollowup`)
state whether the current input carries that authority, rather than asking the
model to infer it from message wording. When an executor has Work access but
no contract, runtime facts say so before its first effectful invocation.

Decision cards are placed at their original `ask` using recorded request and
tool-call identities, including proposal-based asks whose question and options
are generated by the backend. Historical revisions and invalidated decisions
remain beside that ask; placement never restores answer authority. If the
original ask is missing or cannot be uniquely located in the loaded history, its decision is shown in a
separate section before the conversation rather than appended as a new event.

`work context` returns full records and unresolved effects. It includes action
schemas automatically when no Work exists; use `data: {includeSchema: true}` to
request them later (`schemaRequest` supplies the exact call). Repeated state
reads omit the unchanged schemas, not requirements or evidence. Mutation
receipts retain keys, semantic/assignment revisions, sequence, authority,
adoption identity, waits, transitions and unresolved effects. They omit repeated
definitions and adoption prose; `detail` reads the complete persisted record.
This changes only tool presentation, not the stored record or execution fences.

The context's requested schema includes `evidenceSchema`. Evidence entries are references
`{sessionId, physicalId, kind: "user" | "tool", id, quote}`, not strings or a
Decision brief. Use real recorded input/tool-call IDs and exact excerpts;
definitions may omit evidence, but completion and agent settlement still enforce
their required evidence checks.

A trusted native tool can explicitly attest to a failed operation with no
effect. For example, audio.cpp rejects malformed loader catalogs before saving
configuration, records `not_applied`, and does not leave an unknown Work effect.
`exec` also uses this outcome for a missing script or unsupported shell rejected
before dispatch, command interception or process creation, on Main or a Child.
Unattested errors, failed probes, interrupted writes and arbitrary error text do
not make that guarantee: they retain the existing unknown-effect fence and
require reconciliation. This is not rollback or a blanket exemption for
validation-looking errors. The separate native `returned_error` outcome described
above acknowledges completed execution, not absence of effects.

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
Explicit absolute stdio executable paths are checked before SDK startup, so a
missing file reports native `ENOENT` instead of depending on an English Windows
shell message. Windows suffix candidates remain eligible for SDK `PATHEXT`
resolution, including extensionless absolute commands. Bare command lookup still
belongs to the SDK. Stderr capture is
bounded to 32 KiB, decoded from complete captured bytes with the shared UTF-8/OEM
decoder, then redacted; oversized captures are omitted rather than retaining a
potentially truncated secret.
Npm launcher `ETARGET`/`E404` (unavailable package/version) and `EBADENGINE`
(incompatible runtime) errors are reported separately from the SDK's subsequent
connection-closed error. They require correcting the package/feed or runtime,
not reconnecting the same command. Shadow does not silently substitute versions,
switch registries or relax runtime/TLS checks.
Connection diagnostics include elapsed initialization time. For a stdio timeout,
inspect sanitized stderr to separate package/bootstrap problems from MCP
initialization; a running managed browser does not establish adapter readiness.
Retry import at most once without replaying tool effects.
`call_tool` timeouts instead report elapsed request time and an unknown execution
outcome: inspect pending effects before any retry. A long browser evaluation
can exceed the request deadline even on a healthy connection. For idle checks,
record state/time and inspect later with a short call, rather than sleeping
inside one RPC. MCP-declared text errors retain their JSON envelope and explicit
failure status for Work tracking.
The project browser tries its configured preferred port range first, then uses
bounded OS-assigned candidates if that whole range is occupied or OS-reserved.
An explicitly requested port never silently changes. Existing listeners are not
reused or terminated; browser profiles and process ownership stay project-scoped.

### MCP read-only policy and Work admission

MCP tools are **unknown by default**, even when named `get_*` or when the server
advertises `annotations.readOnlyHint: true`. Shadow uses this precedence:

1. A matching locally reviewed `readOnlyOverrides` rule, including explicit `false`.
2. The server's hint only when that server has `trustReadOnlyHints: true`.
3. Unknown otherwise; normal Work execution checks apply.

Read an indexed tool's `v:tools/<server>/<tool-id>` metadata to inspect
`readOnlyPolicy`: `readOnly` is `true`, `false`, or `null` (unknown), `source`
explains the decision, and `fingerprint` identifies the reviewed contract.
For example, these optional fields belong inside one approved server entry:

```json
{
  "trustReadOnlyHints": false,
  "readOnlyOverrides": {
    "get_record": {
      "readOnly": true,
      "fingerprint": "<copy the 64-character fingerprint after reviewing this tool>"
    }
  }
}
```

Override keys are exact, **unprefixed** MCP tool names. Copying a fingerprint
does not verify behavior: review the implementation and its permissions first.
A successful trial call, tool name, description, or server claim is not proof.
Never enable trust or create positive overrides merely to clear a Work error.

Review fingerprints bind the configured server name, tool metadata/schema/hint,
and advertised server name/version when available. Metadata changes invalidate
the override (`stale-review`) without falling back to trusted hints. Connection
arguments, environment, URLs, and headers are deliberately excluded from this
public fingerprint to avoid exposing credential-derived hashes. **Re-review and
remove or replace approvals when changing connection configuration or server
implementation**, including updates that keep the same advertised version and
contract. These are reviewed policy decisions, not attestation of remote code.
Old indexes without hints or server versions remain readable; live discovery
refreshes metadata before lazy invocation. Config changes and tool-list change
notifications invalidate active adapters and borrowed snapshots.

Confirmed reads remain available when Work is paused, completed, or waiting for
a context transition, without creating Work effect receipts. Writes and unknown
tools remain gated, including the inner MCP call through `invoke_tool`.
The built-in `browser_setup list` only inspects session-owned instance metadata.
Its validated `close` action is a separate cleanup control, not a read-only
browser command: it remains available after Work becomes blocked, paused,
terminal, stale or uncertain. Closing cannot resume or accept Work, reconcile
earlier effects, launch a browser or acquire another session's instance. Attached
targets are only disconnected; owned browsers are terminated. Project, tool-role,
leaf-call and cancellation checks still apply. No other MCP/browser operation
inherits this cleanup exception.
Native cleanup implementations declare `workAdmission` instead of adding tool
names or browser classes to Work's allowlist. Execution cancellation uses the
same policy. External MCP annotations and tool arguments cannot opt into it.
Within a model tool batch, only confirmed reads share a parallel group;
mutations and unclassified calls execute in order so goal changes cannot race
subsequent operations.

Errors distinguish paused Work, terminal status, and context transitions; unknown
tools also report that they are not confirmed read-only. Read-only classification
does not bypass tool allowlists, cancellation, remote-workdir restrictions, or
data-access permissions and is not a sandbox.

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
