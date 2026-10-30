# Tools, skills, MCP, and automations

## Model discovery for delegation

The runtime's **Virtual resources** prompt advertises `v:models`. Read
`v:models` for the current configured selectable model catalog, or
`v:models/<exact-model-id>` for one entry. Glob/grep virtual search supports
names and content, including slash-qualified IDs. Copy the complete ID (including
`@provider`) into `subagent.model`; the source is the same configured provider
catalog used by inference validation, not every model in the context registry.
Provider discovery can fail or use provider-specific cached/fallback metadata;
this resource does not probe availability or grant delegation/provider permission.

Each entry separates provider metadata, configured context overrides, registry
fallbacks and curated task heuristics. Image support, output/context limits and
supported Shadow efforts are shown where advertised; unknown size, tool support
and measured performance remain unknown. Runtime context fallback is not a model
capacity claim. No credentials, provider endpoint URLs or whole configuration
objects are exported. The catalog is regenerated from current runtime dependencies
on read/search, including after Project configuration changes.

Omitting model and effort preserves task role defaults or call caller settings.
Effort omission inherits existing defaults; it does not choose a supported effort
for a newly selected model. A known incompatible inherited effort is rejected by
existing validation, so select an advertised Shadow effort explicitly when needed.
Unknown effort metadata is not evidence of support. Curated guidance is a starting
heuristic, not a benchmark, cost/latency ranking or guarantee of task quality.


## Learning outcomes and recovery

Learning aims to improve future decisions, not accumulate a transcript-shaped
wiki. A useful memory records **when / goal / why / guidance / exceptions /
evidence / revalidate when**. Inferred motivations remain hypotheses, not facts
about a person's identity. Easily recomputed environment facts and temporary
task state usually stay in source history. No durable change is a valid result.

Reflector is the first-stage evidence learner: independently assess Wiki
knowledge updates, key events/corrections/challenges, long-term memory and
material for downstream skills. A useful unresolved challenge can be logged with
its source, attempted approaches, observed outcome and uncertainty before it
supports a mature rule. Do not invent a resolution or force writes to all four
destinations. Knowledge facts need not be behavioral lessons; prefer updating an
existing Wiki item over duplicate pages. Stable event keys deduplicate retries,
not repeated user actions into a behavior counter: counting is not implemented
by this workflow.

Reflector actively looks for user corrections, repeated failed approaches,
promise/execution gaps, overturned assumptions, and successful reusable methods.
A candidate connects the situation, actual choice, observed result, supported
explanation, next-time adjustment and exceptions. It should identify which future
decision or action changes, rather than only retelling the conversation. Durable
stated requirements can still be scoped facts; they need not become universal
behavioral principles. There is no quota of new memories.

When assigned evidence shows an existing memory used or contradicted, reflection
evaluates that outcome to support, narrow, correct or retire the guidance. It does
not expand source scope to manufacture follow-up evidence. Receipts explain
learning signals and concrete changes separately from unread/truncated evidence
and unobserved future usefulness. Attachment markers are not image understanding;
relevant inaccessible evidence requires Partial/Blocked, not No change.
These are model instructions, not a semantic-quality validator or proof that later
behavior improved. Verified completion is still required to advance message
cursors; prompt instructions alone do not prove source coverage.

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
cannot be hidden by reporting No change. A failed source read can be recovered
by later successful complete pages covering its failed line range on the exact
same resource; identical offset/limit arguments are not required. Different
aliases or `/full` and `/overview` are not interchangeable coverage proofs.
Diagnostics retain the failed path and range for explicit recovery. Unresolved
write failures remain blocking, independently of read recovery.
Reflector direct writes need a
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

### Dedicated Project automation budgets

Source defaults and triggers are unchanged; these are ceilings, not promised
completion counts, observed costs or live configuration values.

| Automation | Default trigger | Provider request ceiling | Tool calls / argument bytes |
| --- | --- | --- | --- |
| Organizer delta | Explicit delta action | 4 | 12 / 96,000 |
| Organizer full | Explicit action | 8 | 24 / 192,000 |
| Reflector | 30-minute check, pending evidence only | 6 | 18 / 96,000 |
| Encapsulator | 2-hour check, unconsumed events only | 8 | 24 / 192,000 |
| Soul reflector | 12-hour check, unconsumed events only | 4 | 12 / 48,000 |

Learning ceilings are selected by the trusted LearningRuntime pipeline, not an
editable cron override; ordinary cron jobs retain their existing execution defaults.
New reflector batches target an overview reading budget of 12,000 characters /
160 lines across at most four sources; persisted cursors still count messages,
not display lines. This leaves room for relevant lookups, writes and receipts,
but is not a guarantee of completion within the tool ceiling. A single oversized
atomic message is isolated, not skipped; Partial pauses for explicit recovery.
Existing pending batches preserve their scope and effects rather than silently
shrinking or acknowledging unread evidence.

Writers need separate read, validated-write and learning_result/final stages and
are not one-shot. Exhaustion may leave partial effects, which are retained for
recovery; no cursor advances without the existing verified receipt and successful
completion. No new
cooldown, polling schedule, one-shot organizer or profiling model call is introduced.
See src/runtime/main/project-runtime.ts, src/projects/work-organizer.ts and
src/agent/learning/pipelines.ts for the enforced limits; src/agent/learning/service.ts
schedules the intervals; src/config/schema.ts supplies their defaults. The general session inference default remains 1000.

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

Ordinary administrator Web sessions discover the opt-in `channel_config` tool through `v:skills/project-administration` and invoke it on demand.
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

## Per-call execution device selection

`read`, `write`, `exec` and `search` accept optional `nodeId` **and**
`capabilityId` together. Omitting both preserves the committed session locality.
The selection applies only to that call: it does not switch the selected Folder,
change session cwd, or affect concurrent calls. `nodeId` identifies a device;
`exec.shell: "node"` still means the inline TypeScript runtime, not a device.

Use the exact workdir reference from a registered remote Folder's
`read("v:project/folders/<folder-uuid>")` details. For example:

```json
{"nodeId":"child-device-id","capabilityId":"approved-workdir-id","path":"notes.txt"}
```

Pass this to `read`, or add `content` for `write`. For an OS command:

```json
{"nodeId":"child-device-id","capabilityId":"approved-workdir-id","script":"pwd","shell":"sh","cwd":"subdirectory"}
```

Relative file paths and remote `exec.cwd` are interpreted by the Child within
that capability, **never** relative to Main or a remote display path. Existing
Child path/symlink and operation-permission checks still apply. Merely pairing a
Child does not grant every Project access to all of its folders: the workdir
must also belong to the current Project (for example through a registered
remote Folder). The Project-scoped lookup and executor remain authoritative;
unknown, offline, revoked, unauthorized or incompatible targets fail without a
Main fallback. An execution context without host target lookup also fails closed.

Current remote support is deliberately limited:

- UTF-8 text and directory `read`, and the existing text overwrite/edit/append
  `write`, use the existing capability filesystem operations.
- OS `exec` uses the existing bounded remote process protocol. Its existing
  lifecycle/time-limit/permission restrictions are unchanged. Inline
  `shell: "node"`, Node-only exec policy, call-mode remote foreground execution,
  and remote background execution remain unsupported.
- Remote filesystem `search` (glob/grep) remains unsupported and explicitly
  rejects the route; it does not run Main's ripgrep. Use Child OS `exec` within
  its granted workdir when that process capability is authorized. Local explicit
  targets retain ordinary filesystem search behavior.
- Explicit targeting does not route virtual resources, URLs, web search, remote
  images or legacy `search.space`. Omit the selection for control-plane virtual
  resources. Remote image reads and explicit remote encoding overrides reject
  without opening a Main file.

`write` records the selected node/capability with its historical edit, including
remote writes from an ordinary local session. `view_edit` continues to read the
session's persisted patch (not a current file on either device) and displays
that recorded identity. Old records without identity remain readable; their
device is not inferred from the session's current locality. Existing JSONL and
SQLite log readers retain the optional identity through the shared file-change
schema.

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
policy: at most five retries after the initial attempt. Rejected HTTP 429s wait for
`Retry-After` or exponential jittered backoff; known pre-connection failures (DNS,
connection refusal or connect timeout) back off from 0.5 seconds, doubling to an
8 second cap with ±25% jitter (nominally 0.5, 1, 2, 4 and 8 seconds). Cancellation
interrupts backoff and prevents another request.
Ambiguous connection failures, interrupted responses and non-429 HTTP errors are
not retried by this mechanism. Copilot retains its separate single refresh/retry on
HTTP 401; other HTTP authorization handling remains provider-specific.

Shadow keeps the base tool list small. Search and read virtual paths to
discover skills or tool contracts; use `invoke_tool` for a known dynamic
tool. Search does not activate a skill or run a tool.

```js
search({ handler: "grep", path: "v:skills", query: "CSV" })
search({ handler: "glob", path: "v:tools/cron", query: "**" })
read({ path: "v:tools/cron/cron_add" })
```

Virtual `handler: "grep"` searches use JavaScript regular expressions; `handler: "glob"` searches
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
search({ handler: "grep", path: "src", include: "**/*.ts", query: "symbol", limit: 10 })
search({ handler: "glob", path: "src", query: "**/*test.ts", limit: 10 })
```

`handler` selects only the implementation (`grep`, `glob`, or `web`); combined
values such as `grep:v:tools` are invalid. `path` sets a file/virtual root and
defaults to the effective workdir. `include` is a relative grep file filter, not
a root. File and virtual searches accept `limit` (1-100) and zero-based `offset`.
Ripgrep errors are failures, not "no matches".

For web scope use `search({ handler: "web", domain: "example.com", query: "docs" })`.
`domain` accepts a DNS domain, not a URL, path, or `site:` prefix, and is valid only
with web. Web searches warn when ignoring file-only options (`path`, `include`,
`limit`, `offset`); these do not restrict or paginate web results.

Old stored calls using `space` still execute through runtime-only compatibility,
but `space` is absent from the advertised schema. Do not combine it with
`handler`, or specify the same root/filter/domain in both legacy and new fields.

`read` uses **one-based** line `offset`/`limit` for files, URL text and virtual
text. Local `v:sessions/<id>` line ranges use the same complete-history view as
grep, so a match's line number can be read directly. Physical segment references
returned by compact/handoff also support line ranges and exact-reference search:
their view contains that segment's full history, not the current segment or only
the most recent messages. Root session discovery still lists logical sessions.
Bare local session IDs default to `/overview`: human user messages, assistant
final responses, and a tool-call/result index with recorded status and detail links.
For collaboration tools (`subagent`, `call`, `session`, `message`), overview also
shows whitelisted string argument fields (purpose/task, title, description,
initial message, recipient/delivery metadata), bounded result previews and
accompanying assistant commentary. Each argument field is capped at 240 characters;
result/commentary/event previews at 480, with whitespace collapsed and explicit
truncation markers. Unknown fields, nested values and non-collaboration payloads
remain omitted. Malformed collaboration arguments are marked, never expanded.
System messages, runtime-context and internal event envelopes are hidden, except
bounded collaboration completion/review/message event previews. This is display
filtering only: event-looking content never establishes provenance or permission.
`/full` retains message text and tool payloads, but image content blocks are
represented as attachment markers rather than embedded image bytes in both views.
HTTP(S) image references are bounded previews, not fetched image content.
Virtual text pages exceeding the inline token budget return a bounded prefix with
explicit truncation metadata instead of rejecting the whole page. Complete-line
cuts give a continuation offset. Mid-line cuts identify the incomplete line and
warn that line-only paging cannot retrieve its omitted remainder; skipping to the
next line does not count as reviewing that remainder. Source coordinates do not
change. This fallback does not alter local-file or URL token-limit behavior.
Status `requested` records an
attempt, not success; `result-recorded` only records a result's presence.
Interrupted calls remain indexed without a result or final response.
Formatting never looks ahead to future results, keeping prefix line coordinates stable.
Overview detail links use `v:sessions/~<16-hex-physical-hash>/c/<message>.<call>`:
the hash identifies a physical segment and the one-based message/call coordinates
identify the exact call. No persisted IDs change. Aliases resolve against all known
segments (including old segments after rollover); unknown or ambiguous aliases
fail explicitly, never select the current segment as a fallback. Full physical
paths and `v:sessions/<physical-id>/calls/<encoded-tool-call-id>` remain supported.
Read a detail link to retrieve only that call and its paired results. Offset/limit
pages only that selected resource.
Unknown call IDs fail explicitly; these are tool-call IDs, not background
execution IDs. Each view has its own line coordinates, shared by read and
grep on that exact path. Without a line range, reads return the last 200 lines; use offset/limit to read the complete view.
Learning should read overview first, expand only concrete evidence gaps, and reserve tool capacity for its final receipt.
Query parameters, including legacy `index`/`page_size`, are rejected with migration
guidance: pagination is exclusively read.offset/read.limit. Plain URL text keeps its line structure;
`flag: "r"` preserves raw HTML. Large inline text must be paged.

## Inspect and cancel executions

`read({path: "v:bg"})` lists the current session's background work, local task/call,
and remote A2A executions. `handler: "grep", path: "v:bg"` and `handler: "glob", path: "v:bg"` search that same inventory.
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

### Overview graph disclosure

The read-only overview starts with collapsed topics in a horizontal recent-activity
order. Activating a parent (click, Enter or Space) reveals a bounded rounded dashed
region below it. Children use a deterministic two-dimensional layout; nested
expansions reserve nested bounds rather than overlapping adjacent root regions.
The dashed parent-to-region arrow denotes disclosure/ownership, not causal impact.
Typed internal relationships retain their original direction and evidence. Cross-boundary
relationships use region ports; hovering or focusing a port identifies the actual
record endpoints, and clicking the relationship opens its original source/evidence.
Hidden-child cross links can remain as boundary summaries without opening a branch.
These are renderer projections only: no persisted relation is changed.

Deliberate expansion pans the parent to the top-center of available canvas space
(accounting for the inspector), retaining current zoom with a readable 0.85 floor.
Large regions remain pannable, not auto-fitted. Collapse and incoming data do not
reset the viewport; Fit all remains an explicit help action. Dense crossing edges
and very large nested regions may still require manual pan/zoom; the layout is not
a semantic DAG optimizer and does not reinterpret relationship cycles as ownership.

## Retired automatic observation

Automatic title/goal observation has been removed. Sessions publish explicit metadata via `write` of `v:session/self.json`; independent topic organization remains available.

Fresh local asynchronous `subagent` tasks have parent-owned identity: supply `title`
and `description` when creating one. `title` is a one-line display name (up to 120
characters); `description` is discovery text (up to 4000 characters). For compatibility,
existing description-only calls derive the title from its first 120 characters,
flattening control characters. Both are persisted as the task's name and description.
The task may use `write` of `v:session/self.json` with `completed:true` or
`completed:false` for non-reviewable tasks; unchanged title and description may be included in a full JSON roundtrip. Reviewable tasks submit a final response instead of self-completing. Title and description are immutable to
the child, including through legacy update. This does not grant parents a new
cross-session editing API. Blocking `call` forks keep their existing metadata and
cannot use session tools. Remote A2A retains its separate delegation contract.


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
premise through the ancestor editor, discuss it in an ordinary conversation, or answer
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
permissions in Project workbench **Apps** before opening. A normal button can call
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
initialization; a running managed browser does not establish adapter readiness. npm `E401`
during stdio initialization is non-retryable `authentication_required`, requiring
user action to repair the approved registry credential, never a silent registry
switch. The built-in Chrome adapter instead ships with the application and runs
directly on its Node runtime, without npx or business-folder npm/.env configuration.
For retryable initialization failures, retry import at most once without replaying
tool effects.
`call_tool` timeouts instead report elapsed request time and an unknown execution
outcome: inspect pending effects before any retry. A long browser evaluation
can exceed the request deadline even on a healthy connection. For idle checks,
record state/time and inspect later with a short call, rather than sleeping
inside one RPC. MCP-declared text errors retain their JSON envelope and explicit
failure status.
Use `browser_setup(action: "connect")` as the idempotent everyday entry. It reuses
this session's binding or binds the approved Project managed choice; after a managed
crash it restores the same copy. Multiple bindings require `instance`. With no approved
choice or binding it returns `needs-selection` candidates and confirmation guidance,
without launching or copying. Even a unique candidate requires profile-copy and
browser-wide Project access approval before the initial `managed` operation.
Successful connect returns actual `list_pages`, `ready: true`, source and usage.
`adapterReady` alone only means MCP initialization, not verified CDP access; a failed
probe is not success. Binding reuse never grants additional tool permissions.
`managed` retains its lower-level selection/copy setup contract. Explicitly approved
Chrome 144+ `autoConnect` and already-enabled loopback CDP `attach` remain compatibility
modes, never automatic fallbacks. The Project owns one shared managed process; sessions
own independent adapter bindings and disconnect only those bindings. CDP is browser-wide,
not tab ownership or profile isolation. Page operations require explicit pageId.

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
targets and autoConnect browsers are only disconnected, never terminated. Project, tool-role,
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


### Explicit topic organization (no automatic observation)

Built-in work-organizer executions use the normal SessionManager
execution/tool loop, but their UI home is **Automations**, not ordinary conversations.
New runs persist `automation.config.source: 'system'`. These explicitly requested
runs are not cron jobs, but their stable feature controllers appear in Automations
with the same enable/disable popup and detail controls. The controls apply to
`system:work-organizer` (话题整理), not to
individual saved runs. Full and delta organization share one organizer control.

The organizer shows its fixed manifest and plain final outcome by default; raw JSON and internal instructions remain collapsed in Technical details. Its bounded prompt permits only organization_read/organization_patch/organization_finish, without filesystem, shell, device, delegation or discovery tools. Ordinary sessions retain full context.

Preferences persist per Project as `organization.enabled` (default true) and optional `organization.model`. Disabling organization blocks full/delta requests and aborts active execution; committed presentation patches remain saved. Re-enabling does not backfill or retry work. Updates require host authorization on the owning Project router.

The existing automation workspace keeps the native execution trace and diagnostics.
Internal run history is expandable, with full/delta scope filters, execution state,
time, and saved organizer coverage receipts (including partial results). The input
manifest is collapsed rather than used as a title or dumped by default. Execution
completion and presentation coverage are separate: a completed tool loop can still
have a partial organization receipt. Older records without a receipt retain unknown
coverage rather than inferring success.

Historical internal addresses are classified for display only when their built-in
agent type matches the exact internal channel/address provenance. A same-named
custom agent in an ordinary conversation is not an automation. This compatibility
view does not rewrite historical records or inspect prompts to classify them.

### Evidence boundaries and coverage

- The organizer alone produces project hierarchy and display-purpose interpretation. Full and delta modes retain bounded manifests; meaningful child outcomes should appear in the parent's report.
- Project-private learning uses one provenance/lineage eligibility predicate for scheduling and source selection, including unfinished batch execution/recovery. Internal system and learning automation (and their descendants), known historical internal addresses, missing lineage and channel-scoped histories are excluded. Agent names alone do not exclude a human-owned session. User cron work remains eligible. Channel learning retains its separate journal.
- No additional model scoring, periodic project-summary generation or automatic outcome attribution was added. Existing correction/result evidence remains available; assistant completion reports are not independent verification. Provider-token aggregation, material semantic fingerprints, richer sourced outcome feedback and dedicated coverage UI remain candidates, not implemented features.

### Read-only automation profiling

Selected Automation details show a refreshable rolling 24-hour measurement and current frequency policy. Ordinary conversations expose on-demand Statistics in the conversation diagnosis panel: rolling 24 hours and conversation total, own versus including exact descendants (overlapping, not additive). `GET /api/sessions/:key/profile` and `GET /api/automations/:id/profile` adapt the same persisted source-event usage aggregation. Existing read/search tools expose `v:stats/project`, `v:stats/sessions/<URL-encoded logical ID>` and `v:stats/automations/<URL-encoded feature ID>` in the owning Project; discovery lists metadata without scanning logs. Read `v:skills/profiling` for interpretation and examples. There is no dedicated profiling tool or mandatory agent prompt injection. Reads do not invoke a provider, change frequency, schedule work, or run a profiling agent.

The UTC half-open window is `[asOf - 24h, asOf)`. Run counts use exact persisted automation metadata (or explicitly recognized legacy source addresses), run start time and current execution/organization status. Full/delta run counts distinguish organizer modes. Provider/token counts use persisted `model_usage` source events completed within that window, including exact child lineage in the same Project. Every distinct provider-chat event counts once; failure or missing usage remains an unknown-usage call. Known zero is zero; no known usage is null. Assistant context snapshots and cached-token breakdowns are not added to usage. Provider transport retries are not separate provider-chat calls.

Tool counts are distinct persisted tool-result IDs, not every nested or interrupted tool invocation. Historical missing telemetry, unreported usage, missing cached/reasoning breakdowns, durations and costs are explicit limitations. Totals are known subtotals, not estimated budgets or quality scores. Source reads stop at 100,000 records and visibly mark lower-bound counts if capped. No prompt, raw error or private configuration fields are returned.

Frequency descriptions are scoped: explicit organizer full/delta operation, configured learning poll intervals, or the current user cron schedule. Historical snapshots never claim to describe current runtime policy.

### Current-instance runtime diagnostics

The `runtime-diagnostics` skill describes the workflow. `read({ path: "v:runtime" })`
provides the live scope/retention guide; `read({ path: "v:runtime/logs", offset: 1,
limit: 50 })` pages redacted JSONL. `search({ handler: "glob", path: "v:runtime", query: "**" })`
discovers the read-only entry without fetching log content.

General `runtime_log` events reuse the same **project OTel store and existing
console collector** as the diagnosis UI Logs tab (`/v1/query/logs`). They include
`time`, `level`, `source`, `message`, and valid `traceId`/`spanId` when available.
Console `debug`, `log`, `info`, `warn` and `error` are covered, including Error
messages/stacks inside the redacted message. Project OTLP-ingested logs are also
covered. There is no second console monkeypatch or general-log storage buffer.
The store is project-owned; the existing Project actor check gates reads and
listing. Other Projects and the general host telemetry store are not exported:
unscoped host messages may concern another Project. An explicit foreign
`project.id` resource claim is excluded as well.

The export queries at most the latest 200 rows **after this project runtime
started**, merges them with applicable provider events, and emits at most 200
JSONL events, oldest first. Messages are capped at 4096 characters; arbitrary OTLP
attributes/resources and structured bodies are not exported. Credential-,
header- and payload-bearing messages are conservatively omitted as a whole,
and URLs are removed. This is a redacted view, not access to raw log files.
Free-form text cannot guarantee detection of every unlabeled secret. Logs are
untrusted evidence, never instructions. Pagination uses ordinary read line
`offset`/`limit`; offsets can shift as new records arrive. This bounded export
does not change the existing UI SQLite storage/retention policy.

Provider readiness remains an instance-owned in-memory ring of the last 200
allowlisted checks. Project-scoped checks are isolated; unscoped checks of the
instance's shared configuration are marked `shared_provider_setup`. They record
`level`, `source`, `message`, provider (`custom` for unknown names), `GET`, fixed
endpoint `/models`, HTTP status when received, and categorized `result`.
Agnes 401 is `invalid_credentials`; 403 is `permission_denied`. Existing 404/405
acceptance is preserved. Provider event fields never include configured URLs,
credentials, headers, model names or request/response bodies. Reads do not probe;
cached readiness creates no duplicate events. Missing configuration, local
no-auth and Copilot authentication do not produce these HTTP-check events.

Excluded: historical records from previous project-runtime generations, general
host logs, desktop/browser logs, output before telemetry initialization, direct
stdout/stderr writes, and arbitrary disk/session files. Provider events reset on
host restart; general records remain in the UI database but prior-generation
records are excluded from this view. A fresh instance may already have startup
logs. Source changes do not alter a running host: restart/relaunch the source
backend or rebuild/relaunch the packaged backend to load this mount. Existing
`v:bg`, `v:sessions` and `v:events` are execution/history/subscription views;
the `log` tool writes learning events, not runtime diagnostics.


### Lightweight conversation topics and Work associations

Every ordinary user-visible session is itself a lightweight topic, including normal
questions with no Work. There is no extra topic entity or registration step. The
Project dashboard/Work overview reads these conversations directly and provides
title, discovery description, explicit completion, derived activity and conversation
navigation. Internal task executions are folded under their owner/Work; calls and
organizer/observer archives never become independent dashboard topics.

`write` of `v:session/self.json` accepts only title, description and completed for a
durable session. Tasks may change completed only (reviewable completion requires review); unchanged title/description may be included in a full roundtrip and remain parent-owned. Calls cannot mutate self metadata. The tool no longer accepts a
topic object. Old persisted topic metadata and unrelated native topic routing stay
read-compatible. Formal outcomes, acceptance and boundaries belong in Work, not
this discovery metadata. Session completion ends that session's responsibility; it
does not complete associated Work.

Creating Work from a session automatically associates that conversation. Use
`work action=link key=...` to associate an existing Work explicitly. This historical
association persists independently of `work action=select` execution focus; linking
does not assign Work, change authority, select focus or set completion. Clearing or
switching focus does not erase associations. No title-similarity matching is used.
Associated sessions are displayed under their Work instead of duplicate top-level
conversation cards. Normal questions and subagents do not need to create Work.

Explicit full/delta organization accepts both Work and unassociated conversation
identities as its bounded source manifest; it reads existing semantic conversation
evidence, not an automatic observer or background model goal guess. Conversation
metadata/completion changes invalidate organization source versions. Lightweight
topics are never materialized as Work just to make organization possible.

Current session metadata is available at `v:session/self.json` via read/write. Writes accept nonempty partial JSON objects or the full read result, with only title (string, max 120), description (string, max 4000), completed (boolean). Exact match edits validate the full resulting JSON; append is unsupported. Identity is runtime-bound, not a JSON target. Tasks must preserve parent-owned title/description unchanged or omit them; reviewable task completion changes require review, not self-acceptance. Calls/automations cannot write. Ordinary new sessions set accurate title and description after understanding the first request, and update only for meaningful goal changes.

### Conversation schedule chip

Conversations targeted by existing-session cron jobs show a **Scheduled tasks**
chip beside background tasks and subagents above the composer. Its read-only
popover lists the task, schedule and next trigger time (displayed in the browser's
local timezone). Disabled jobs remain inspectable without a next trigger. The
inventory comes from persisted cron jobs and does not require the conversation
to be active in memory after a restart. Fresh-session automations remain in the
Automations workspace rather than the creating conversation's chip.
