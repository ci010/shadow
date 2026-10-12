# Tools, skills, MCP, and automations

## Learning outcomes and recovery

Learning aims to improve future decisions, not accumulate a transcript-shaped
wiki. A useful memory records **when / goal / why / guidance / exceptions /
evidence / revalidate when**. Inferred motivations remain hypotheses, not facts
about a person's identity. Easily recomputed environment facts and temporary
task state usually stay in source history. No durable change is a valid result.

The local Project learning roles use `learning_memory` to read a revision and save a scoped
decision. Existing general sessions retain normal `write` access to wiki memory;
there is no new approval step. Repeated evidence can support, correct or retire
a decision. Retired decisions are retained as historical evidence but must not
guide new actions. Source identities are checked against the assigned batch;
the model still owns the semantic interpretation.

In that local Project workflow, `learned_skill` writes lesson-only `SKILL.md` packages to the actual shared
Project skill space, using revision checks and the existing registry. It does
not grant executable tools, override bundled skills, install agents or make an
admin/core skill. Those changes use the established authoring route; a local
draft must be reported as **Draft only**, not as an installed skill.

Before ending, learning agents submit `learning_result`:

| Outcome | Meaning |
| --- | --- |
| Applied | Recorded effects persisted and passed artifact/event checks |
| No change | Assigned evidence was reviewed and nothing justified retention |
| Partial | Some effects exist but the batch is incomplete |
| Blocked | A prerequisite failed or a required receipt was absent |
| Draft only | A proposal is not yet usable shared knowledge |

Only Applied/No change plus completed execution advances progress. This is
separate from the normal session status; a completed conversation can still be
blocked as learning. Persistence checks do not prove that a learned claim is true.
Source review and semantic quality remain model-driven; later sessions should
identify useful decisions and counterexamples for the next reflection pass.
Receipt checks include direct Markdown writes and persisted tool failures, not
only writes through `learning_memory`. An unresolved write or source-read error
cannot be hidden by reporting No change. Reflector direct writes need a
provenance-bearing `log` event before Applied; the structured memory tool creates
that event automatically. Changed artifacts pause for reconciliation rather than
automatically overwriting another editor's change.

The narrow lesson/Soul tool contracts do not make ordinary filesystem access
an OS sandbox. Session tool permissions and existing authoring boundaries still
apply. Soul changes are described in the saved outcome; this is not a separate
push notification or an implicit approval from the user.

The Project `.learning/state.v1.json` journal stores pending bounded ranges,
events, receipts and retries. JSONL and SQLite session stores use the same
journal. Existing `memory/.reflect-watermark.json` progress is imported without
replaying already-consumed history or relabelling old runs. Historical missed
writes and run-local skill drafts are not automatically replayed or installed.

Encapsulation and Soul reflection consume explicit unconsumed event batches,
not a guessed daily filename. Their cursors are independent. A reflection with
no new events does not start these downstream model calls. Stable log keys
avoid duplicating an event when a retained batch is retried; already-persisted
effects are listed in recovery tasks.

Nonretryable model/configuration/authentication errors pause automatic runs.
Transient failures use increasing delays and pause after three attempts.
Configuration updates or `/learn <reflector|encapsulator|soul-reflector>` explicitly
resume paused work. Disabling learning stops active dispatch; it does not delete
pending source history or journal data. The current backend must load the new
code for these semantics to apply; old runs are never rewritten as successful.

### Discord conversation learning

Managed Discord conversations and their children are excluded from the legacy
Project source enumeration, including recovery of old pending batches.
`DiscordLearning` connects to the same `LearningService` schedule, but keeps
independent protected journals for each Bot/conversation/authorization
epoch/revision under the Project configuration's
`channel-integrations/learning`. Turning off learning stops this dispatch too.

Only current conversations with `read`, `memory_save` and `learned_skill`
grants are eligible. New input takes priority over background work. Every
worker rechecks its binding, verified platform sender, connection generation,
input generation, memory sources and epoch; none inherits global SOUL or
another conversation's prompt. Internal bounded calls use the existing
SessionManager/BaseSession loop with only `read`, `learning_record` and
`learning_result`, no Discord output transport.

Reflector batches pin at most four bounded source ranges from the current
epoch, materialize immutable history resources and record private decisions
and events. Encapsulation and Soul reflection consume exact unconsumed
decision/event **versions**, with separate cursors. Workers must read every
required input; changing a named record requires its read revision. Tool
failures or missing/invalid receipts prevent application and acknowledgment.
Per-worker limits include twelve model rounds, 128 tool calls and two minutes.

Records, summaries and instruction-only skills remain in the Conversation
domain, with observed source restrictions. The conversation's `learned_skill`
tool uses this catalog, not the Project `skills` directory. Soul reflection
produces a private `soul-draft` and a **Draft only** receipt; it never updates
global SOUL or treats repeated single-conversation evidence as independent
cross-conversation support. Sharing requires separately reviewed fixed-copy
publication and explicit domain grants.

Prepared effects are saved before atomic/idempotent catalog application.
Successful recorded application advances only that domain's cursors and
downstream consumption, including acknowledged Soul drafts. Restart recovery
can finish a prepared commit without another model call or duplicate effects.
An external conflicting edit is not silently overwritten. Failed domains
back off independently and pause after three attempts; their progress is not
merged into the Project learning journal. In **Discord access > Knowledge**,
expand **Conversation learning** for per-context status and paused reasons.
Worker IDs and receipts remain available in owner APIs and session history.
Use `/learn <pipeline>` in an owner chat to retry after reconciliation.

## Discord configuration tools

The Project coordinator explicitly exposes the opt-in `channel_config` tool.
Read `schema` for formats, `list` for named Bot connections and the current
revision, and `directory`/`members` for server/channel/role/person discovery.
`resource` and `agent_file` inspect owner-visible catalog records or current
instructions; `propose` requests a human review in **Discord access**.
There is no approval action. Forwarded peer/event inputs, scoped channel
executions and internal calls cannot impersonate a direct owner web turn.

An authorized Discord management assignment instead receives a same-Bot,
ceiling-limited version. It cannot discover private Project memory, administer
another Bot or expand its own authority. The exact human confirmation flow and
audience implications are documented in [Messaging channels](channels.md).
Use `authoring_change` for QQ/Feishu managed deployment, not Discord.

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
envelope and remain failures. Background process/script failures
have failed status and preserve their output; a successful launch receipt is not
proof that the eventual command succeeded. Failed commands can still have made
partial changes and must not be blindly replayed.
Native execution can distinguish a normally completed error from a lost outcome.
Normal local process exits, acknowledged remote `process-exit` failures, and
inline Node error replies without tool-bridge calls carry native `returned_error`
metadata. This preserves the failure and any partial changes without adding a
notebook reconciliation gate.
An acknowledged infer-only script error also follows this completed-error path,
without claiming its model request was free or safe to retry.
It does not attest no effects or authorize retry. Cancellation, signal exits,
missing/mismatched remote receipts, cleanup failures and unmarked tool errors
remain uncertain and require reconciliation. Completion evidence is native
in-memory metadata, never an output string, model argument or MCP annotation.
Scripts must propagate native failures rather than force `exit 0`; in PowerShell,
check `$LASTEXITCODE` after each native command in a sequence. The shell's actual
exit status is authoritative: arbitrary scripts can mask a child command's error,
and the tool cannot reconstruct that status from output text.

For an opt-in Node-only execution surface, set `tools.exec.nodeOnly: true` in
the Project configuration before starting its backend (restart to apply).
`exec` then advertises only inline TypeScript;
omitting `shell` selects Node even if a session or `defaultShell` prefers an
OS shell. Explicit non-Node requests fail before execution, including nested
tool-bridge requests. Runtime discovery and tool guidance match that policy.
Remote workdirs reject this mode rather than falling back to Main or an OS shell.
Other tools and the normal background/cancellation lifecycle are unchanged;
the default configuration still offers detected OS shells.

Use native `node:child_process` `execFile`/`spawn` with a program and argument
array (`shell: false`) for external programs. `exec`/`execSync`, shell binaries
and Windows `.cmd`/`.bat` wrappers reintroduce shell parsing; use actual
executables or a Node CLI entrypoint instead. Node-only is **not an OS sandbox**:
privileged Node imports can still launch arbitrary programs. Avoiding indirect
shell launch is a scripting policy, not a claim of OS-level enforcement.

Node `exec` also exposes `await infer({instructions, input, schema, model?,
maxTokens?, reasoningEffort?})`. This is a separate host RPC, never a registered
tool, `invoke_tool` target, or application capability. Other script runtimes do
not receive it. It works independently of the Project's Node-only shell flag.
The host sends only explicit input/instructions/schema to the configured
provider with no tools or conversation history, then validates the returned
JSON. Invalid output and provider errors reject without an automatic repair
call; validation does not establish truth, test coverage or permission.

Parent-loop and nested `infer` requests share the turn's 1000-request allowance;
infer reserves one remaining request for the parent. Each exec allows 8 attempts,
2 concurrent, with a 120-second inference deadline and existing cancellation.
Default output is 2048 tokens (32–4096, also capped by the parent's output
limit); request JSON is capped at 64 KiB, schema at 16 KiB, and output JSON at
64 KiB. Model/effort inherit the resolved parent settings unless explicitly
selected. OTel `script.infer` spans persist session/turn/outer-exec identity and
returned usage, including invalid model outputs. History-only assistant token
totals exclude these spans; do not equate one exec with one model request.
Provider transport policy and other runtime model consumers remain separate;
an evaluation's outbound proxy enforces its cross-turn, all-consumer cap.
See [Node scripting](../src/skills/builtin/node-scripting/SKILL.md) for composition
guidance. Each exec still starts a disposable worker, not a persistent REPL.

Recognized model connection/response failures include their phase and a bounded
transport code. An interrupted response is discarded, including partial tool
calls, and is not automatically replayed: the provider may already have processed
or billed the request. Inspect completed work before explicitly continuing.
Chat Completions, Responses and Anthropic Messages share the same bounded retry
policy: at most five retries after the initial attempt, with 1, 2, 3, 4 and 5 second
backoffs, only for known failures before connection (DNS, connection refusal or
connect timeout). Cancellation interrupts backoff and prevents another request.
Ambiguous connection failures, interrupted responses and HTTP errors are not
retried by this mechanism. Copilot retains its separate single refresh/retry on
HTTP 401; other HTTP authorization handling remains provider-specific.

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

Legacy channel API operations are dynamic tools, not additions to the base tool list.
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
inherit their spawner's channel binding through this generic dynamic route; no new platform thread is created by
these tools. Web conversations, peer/event inputs and remote workdirs also do
not inherit a bot read grant. Migrated legacy bot
conversations still require their explicit bot address; platform-only fallback
does not authorize reads.

Managed Discord execution instead exposes approved `discord_history` and
`discord_message_get` directly in its closed scoped registry; it has no
`invoke_tool`. A blocking leaf call can use the explicitly borrowed parent
scope, never select a different Bot or conversation. Reads stop at the current
authorization epoch's start, including pagination and individual message
lookups. They do not import parent-thread or earlier-epoch history. See
[Discord access](channels.md#discord-agents-and-channel-access).

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
errors and permission failures are explicit failures, not empty history.
Discord rate limits use bounded abortable retry; exhausted or excessive delays
fail explicitly. Normal responses still use the existing outbound
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

## Shared work notes and the Project canvas

### Automatic observation (MVP)

`workObserver.enabled` defaults to `true`; set it to `false` to disable automatic
extra inference (explicit user-triggered organization remains available). Optional `workObserver.model` overrides `agent.quickModel`, falling
back to `agent.model`. The tool-free observer runs through SessionManager, not
a separate tool loop. It coalesces new evidence for 20 seconds and has a 90-second
deadline per inference; unchanged evidence does not trigger repeated calls.

It observes new authenticated inputs, actual-parent delegations and final turn
reports in Project-local web chats and their descendants. It does not backfill
existing histories, inspect tool dumps, or observe managed external channels,
automation, coordinators or itself. At most 12 bounded evidence entries per
conversation are retained in the Project Initiative database. The 200-entry
ledger evicts processed evidence before accepting new conversations, never
pending evidence or the resulting Work notes.

Generated notes are labelled as interpretations with source IDs and session
links. They remain unassigned: no forced worker bookkeeping, focus injection,
notifications or implicit authorization. Parent links reflect recorded delegation,
not a proven causal explanation. Manual/worker edits pause automatic replacement;
stale model results cannot overwrite newer evidence or edits. Invalid output and
inference failures remain visible, rather than manufacturing progress. This is
not semantic proof of intent, acceptance, or automatic contextual question routing.

The same per-session call can also save evidence-labelled semantic categories,
shared purpose and inferred recent user motivation. These are display hypotheses,
not user quotations or execution authority. Up to eight persisted category/purpose
snippets provide bounded naming context; no additional automatic model call is made.

The single Dashboard groups recent focus → separate topics → expandable evidence
and decision history. Missing semantic inference is honestly unclassified. Causal
structure, Board and Graph are advanced structure tools rather than a second homepage.
**Organize recent topics** explicitly calls the same configured tool-free model once.
It can classify already-recorded notes, not just pending observation events. Input is
at most 30 recently updated root notes / 32,000 characters of bounded fields, not
filesystem data or whole chat histories. Successful results persist in the Project
SQLite database with time and source note versions. Other topics remain unclassified.
The UI labels model interpretation, omitted inputs and subsequent source changes.
Opening the Dashboard never triggers this call. Duplicate concurrent requests return
409; strict input/authorization, the shared single-call slot, 90-second timeout and
shutdown cancellation apply. Invalid output, source-version conflicts or provider
failure keep the previous snapshot. No automatic retry or historical backfill occurs.

### Current-task steering and inference overrides

`message({sessionId, content})` defaults to `next-step` for actionable agent
messages. A running task accepts corrections only from its actual parent, not
another assignment or a peer. Corrections apply at the next inference boundary;
already executing tools are not interrupted, and obsolete tool calls returned
after a correction arrived are not executed. Pending/applied/unapplied correction
records are persisted. Admission is not application, completion or file ownership
transfer. Before taking over files, await completion or confirmed cancellation
and inspect the actual changes.

Routine progress is archived without waking agents. `delivery` is the single
model-facing scheduling control: `next-step`, `queue` or `silent`. Use
`message({sessionId, content, delivery: "next-step"})` to correct your running task;
use `queue` only for later work in a reusable session. Explicit queue delivery is
never silently converted into a correction. For older callers/history, the
unadvertised `silent` alias accepts `true` as `silent` and `false` as `next-step`
(previously false implied queue); callers needing queue must now request it.
Do not combine the alias with `delivery`. `attention` does not change an explicit
delivery; important updates still cannot be archived, and stale work still cannot
become a new instruction. Rejected task delivery identifies a delivery mismatch,
non-owner, or closed execution and is not a cancellation or ownership transfer.
Channel audience restrictions can still force queue delivery. Calls and terminal
tasks reject further input. Prefer concise, action-first messages; do not request
acknowledgments or repeat reports that require no action.

The [task-correction trace eval](../src/sessions/fixtures/task-correction-trace.md)
records the original failure, deterministic runtime replay commands and limits.

`subagent` accepts optional `model` and `effort` (`low`, `medium`, `high`, `xhigh`,
`max`). Explicit overrides are validated against the provider catalog before
admission. Omitted values retain task-role defaults or call inheritance. These
parameters do not change execution mode, permissions or workspace ownership.

Work is optional scaffolding, not tool admission. Untracked sessions execute
normally and remain visible in the Project overview, including pending questions.
Previously saved required-policy metadata does not re-enable enforcement.
Role, capability, channel, filesystem and dedicated owner approvals still apply.
Historical adoption, proposal and effect records remain readable; the public
`policy/adopt/progress/checkpoint/settle/propose` protocol is retired.

The public `work` actions are `context`, `list`, `tree`, `create`, `update`,
`assign`, `review` and `select`. `context` returns current notes and their host-built
goal paths; schemas are opt-in with `data: {includeSchema: true}`, even for a new
session. `list/tree` are compact paginated indexes. Writes return a small receipt,
not a repeated definition, HTML exhibit, history or instruction manual.

Create a note with `data: {title, definition: {objective}, notes: {kind}}`.
Kinds are `goal`, `approach`, `task` and `finding`. Children also supply parentKey
and notes.relation with a kind (`supports`, `requires` or `assumption`) and reason.
Distinguish a chosen approach from a real prerequisite or unverified premise.
An Initiative derives from a root and descendants; it has no second editable
goal/status store. Parent/completion-dependency cycles are rejected.

Parents maintain causal structure; assigned workers maintain current
`summary`, `plan`, `next` and `artifacts`. `update` takes key, the current note
`version`, and only changed fields in data. Versions reject stale writes;
semantic goal revisions change separately from routine progress.
Agent changes to human-set/source-backed goals need a genuine quote from the
current authenticated user input. Metadata, peer messages and old quotes are not
user authority. Boundary descriptions never grant protected-action access.

Routine notes refresh the UI through the existing Project live-state channel,
without waking agents. Use notes.attention only for a material premise, scope,
dependency, decision or blocker requiring the coordinator to act. Pending impact
notifications coalesce until reviewed. The coordinator reads the current branch,
updates affected reasoning and records `review` with a conclusion. Do not echo
the same report by message or ask for periodic acknowledgements.
Changed ancestors leave descendants explicitly **not yet reassessed**. Local note
edits do not silently acknowledge that change. Review is not approval for tools.
A notification failure reports that the note was saved but delivery failed.

Optional `session create` work:{key} links an unassigned note before kickoff;
the creator must control it. Stable keys survive ordinary note edits, and retries
do not replay the initial message. Optional task/call links select an owner note
without transferring assignment; an unambiguous parent focus can be inherited.
`select` changes context, not permissions. `assign` changes durable responsibility,
not running-process cancellation. Respect actual side effects during handoff.

Set data.status to pending, in_progress, blocked, done or cancelled. Blocked
needs a reason; done needs a current summary, not compulsory per-step evidence.
Work progress, actual execution state and human acceptance are distinct. A blocked
note does not freeze independent tools; a completed child does not prove the
root outcome. Cancellation of an execution remains a separate native operation.

### Questions at the right abstraction level

`ask` accepts an originating `workKey` and an ancestor `decisionKey` for both
input and decision questions. The host resolves and persists their causal path;
agents do not supply a fabricated tree. With one unambiguous assignment/focus,
the local path can be attached automatically. A work item and a large decision
brief are both optional.

The canvas puts native question controls at the affected ancestor, with the
lower technical origin available on demand. Explain consequences for the user's
outcome, not just a worker's implementation A/B choice. The user can correct a
premise through the ancestor editor, discuss it with the coordinator, or answer
in their own words. Changed goals/assignments invalidate related pending questions,
including requests still being persisted. An invalidation is not an approval.
Historical decisions retain their original path and exact ask identity in both
JSONL and SQLite history. Routine progress does not invalidate an answer.
A new question records which path nodes still need reassessment after an
ancestor changed. The warning is visible even when technical details are
collapsed. Current impact conclusions accompany reviewed nodes; an additional
ancestor change marks them unassessed again. This exposes stale reasoning,
not a semantic proof or another admission gate.

Temporarily hiding the mounted overview, including opening the coordinator on a
narrow screen, preserves local answer drafts. Reopening first reloads the pending
question; a draft is restored only for the same Project, session and request.
This does not persist an answer draft across a page reload.

HTML in notes.html is a read-only exhibit: sanitized and rendered in an opaque,
empty-sandbox iframe with a restrictive CSP. No scripts, network requests, forms,
navigation or privileged bridge; native controls outside it retain answer and
authorization authority. Use a Micro App for an actual executable reusable app.

Unknown operation outcomes still require inspection before retry, through the
owning service's recovery controls, not a general Work gate. Native no-effect
and returned-error metadata distinguish rejected inputs from completed errors;
neither means rollback or permission to replay an external effect.

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
failure status.
The project browser tries its configured preferred port range first, then uses
bounded OS-assigned candidates if that whole range is occupied or OS-reserved.
An explicitly requested port never silently changes. Existing listeners are not
reused or terminated; browser profiles and process ownership stay project-scoped.

### MCP read-only policy and execution ordering

MCP tools are **unknown by default**, even when named `get_*` or when the server
advertises `annotations.readOnlyHint: true`. Shadow uses this precedence:

1. A matching locally reviewed `readOnlyOverrides` rule, including explicit `false`.
2. The server's hint only when that server has `trustReadOnlyHints: true`.
3. Unknown otherwise; normal tool and capability checks apply.

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
Never enable trust or create positive overrides merely to suppress an error.

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

Read-only classification controls execution grouping, not a Work prerequisite.
Work status does not gate reads, writes or unknown tools, including inner calls
through `invoke_tool`. Actual tool permissions and capability checks still apply.
The built-in `browser_setup list` only inspects session-owned instance metadata.
Its validated `close` action is a separate cleanup control, not a read-only
browser command. Closing cannot resume or accept Work, reconcile
earlier effects, launch a browser or acquire another session's instance. Attached
targets are only disconnected; owned browsers are terminated. Project, tool-role,
leaf-call and cancellation checks still apply. No other MCP/browser operation
inherits ownership or cancellation permission.
Native cleanup metadata cannot be supplied by external MCP annotations or model
arguments.
Within a model tool batch, only confirmed reads share a parallel group;
mutations and unclassified calls execute in order.

Unknown tools are not assumed safe from their names. Read-only classification
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

Selecting an Automation opens its latest run in the normal conversation layout.
Previous, Next and Current use the same history navigation as compacted chats;
they switch between independent run conversations, without combining their
agent contexts or introducing a separate runs tab.

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
