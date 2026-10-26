# Conversation agent authoring

This framework lets a Project owner author conversation-specific roles, skills
and tools in a durable administrator Web session. It does not install a predefined feedback
collector, GitHub workflow or group bot. The normal Home agent/skill loader
remains separate: published resources are immutable snapshot contents, not
files imported into unrestricted Node execution.

## Primary local BOT directory flow (Discord / QQ / Feishu service Bots)

Project **Bots → BOT directory releases** imports a registered **local** folder
(or a relative subdirectory). Edit that directory with ordinary development
tools; nothing in it is live. Freeze and review snapshots every supported source
file and compiles the runtime resources without executing scripts. One existing
owner publication card reviews the complete source diff, binding permissions,
affected conversations and exact content-addressed Release. Approving it uses
the same live validation, idle-context retirement and atomic active snapshot
switch as existing publication. No per-agent, binding or skill approvals follow.
Later disk edits have no effect until another snapshot is reviewed. Use retained
Release → Review rollback to review and activate a prior snapshot; current draft
edits are replaced only by this explicit action. Up to 20 unique Releases are
retained, subject to the existing 32 MiB private document limit.

Each BOT has a stable `name` identity, its own active content-addressed Release,
and up to 20 retained releases. Importing or restoring one package preserves
unrelated packages and legacy configurations. Resource/binding identity collisions
are rejected, not overwritten. QQ/Feishu package sources are retained under
`bot/<name>/` in the aggregate private resource snapshot; the active aggregate
switch remains atomic. Discord packages use the existing Discord integration
store, platform inspection, authorization epochs and processor runtime, with one
`bot.save` aggregate review and one atomic state switch. There is no Agent →
binding → processor approval cascade. All access checks remain on Main.

Existing configurations and the prior single-directory release envelope remain
compatible; they are not silently adopted by a new package. Use explicit owner-reviewed
legacy adoption (below) to retain an identical legacy policy, or choose new Agent
and binding identities for a new package. Source directory paths are not identities. Changing `name` creates a
new package and never renames or removes an old one. A package is limited to one
connection/platform; different connections use different packages. Packages do
not create connections or provision credentials.

Example directory (no credentials):

```text
BOT.md
channels/support.json
skills/status/SKILL.md
skills/status/status.ts
```

```markdown
---
name: support
allowedTools: [read, service_status]
allowedModules: ["@shadow/service-read"]
channels: [channels/support.json]
---
Answer using only approved documentation and service status.
```

Channel JSON is an array of existing ConversationBinding objects **without
agent**: botInstanceId, platform, conversationId, enabled, skills, readFolders,
allowFrom, parameters and grants. Bot IDs reference privately managed connections;
HTTP credentials contain secretRef/header/prefix only. Skill format and scoped
@shadow grants are unchanged (see below). Omitted allowedTools defaults to none;
no permission is inferred from a directory or existing binding. Omitted allowFrom
still inherits channel admission; [] admits nobody.

Supported local dependencies are declared skill JS/erasable TS source plus pure
Node builtins and scoped @shadow grants. Every source is included in the hash,
along with the deterministic compiled representation. Symlinks/hardlinks,
unreferenced channel configs, extra files, node_modules, package manifests,
initialize hooks and arbitrary SDK/native network/filesystem imports are rejected,
not ignored or executed. Source must fit the bounded 2 MiB/240-file import limit.
There is no trusted plugin execution mode in this flow.

### Discord directory

Use the same **Bots → BOT directory releases** import. Discord BOT.md uses:

```markdown
---
name: discord-support
platform: discord
botInstanceId: <existing Discord connection ID>
channels: [channels/support.json]
tools: [discord_history]
readDomains: []
---
Answer support questions using only approved information.
```

#### Owner-reviewed source and platform-history resources

Two optional permissions can be frozen in the same Discord BOT release:

```yaml
# BOT.md frontmatter: Agent ceilings, not implicit binding grants.
sourceFolders: [<registered local source Folder UUID>]
discordHistory:
  guildId: "<guild snowflake>"
  channelIds: ["<exact channel snowflake>", "<another exact channel snowflake>"]
  threads: public-archived  # none, public-active, or public-archived
  preEpoch: true           # explicit pre-authorization PLATFORM history opt-in
```

Repeat these fields in each channel JSON binding that should receive them. A
binding can only narrow its Agent's Folder IDs, guild/channel IDs, thread tier,
and preEpoch flag. Omission defaults closed. These fields grant no write,
terminal, trusted execution, arbitrary Discord API, private-thread or internal
pre-epoch session-memory access. Existing Agent UUID (`agentId`), optional exact
`agentMarkdown`, unrelated prompt rules, binding IDs and participant restrictions
can be preserved. Updates of a packaged BOT do not use `adoptLegacy` and cannot
change its Agent UUID. Draft edits never affect the active release; an owner must
approve the exact frozen hash. Review displays both Agent and binding resource
scopes, including the preEpoch flag, alongside complete frozen source.

Source tools use only the current Project's registered local Folder IDs:

- `read {path:"v:source"}` lists approved IDs.
- `read {path:"v:source/<Folder UUID>/src/file.ts",offset:1,limit:200}` reads lines.
- `search {folderId:"<Folder UUID>",query:"literal",mode:"names"}` finds names;
  `mode:"content"` finds matching lines. Optional `path` is a relative subtree;
  `limit` is at most 100 matches. Search scans at most 10,000 entries, about 8 MiB
  of source text and 32 levels; results report truncation. No regex or execution.

This deliberately conservative surface excludes hidden paths (including `.git`
and `.env*`), dependency/build/runtime directories, recognized credential/config
containers, non-source extensions, binary/invalid-UTF8 files, files over 256 KB,
hard links and all symlinks, including internal ones. Recognizable embedded keys
and credential fields also exclude a file. This is not a universal secret/DLP
classifier: owners should register a sanitized source checkout, not a Home,
credential or runtime-data directory. Filename search applies the same content
exclusions. Folder unregistration/revocation is rechecked before returning data
and before output/delivery. No Main-path fallback exists for missing/remote IDs.

Safe source reads currently support macOS and Linux, failing closed elsewhere.
A fixed, one-shot host-owned Node helper performs descriptor-verified directory
traversal and never evaluates source. Its executable, program, environment and
cwd are not model-selectable; it has no Bot exec/tool bridge. It uses a 64 MiB
V8 heap, bounded file/output sizes, a 5-second deadline, abort/child/descriptor
cleanup, and post-read registration/authorization checks. This implementation
detail does not grant the BOT terminal or script-execution rights.

Scoped Discord reads are bounded, explicit and live-authorized:

- `discord_history {channelId,limit,before,query?}` scans **one** page of at most
  100 messages. Query is a case-insensitive literal content filter within that
  page, not a server-wide search. `nextBefore` advances the scanned page.
- `discord_message_get {channelId,messageId}` fetches only that scoped location.
  IDs/links never grant authority. Results include guild, parent channel, thread
  and message identifiers.
- `discord_history {channelId,threads:"active",limit,threadAfter?}` discovers
  public threads under an allowlisted parent. The guild active-thread response
  is capped at 1,000 entries, filtered to that parent, then paged by ascending
  thread ID. This is a live view, not snapshot-consistent enumeration.
- `discord_history {channelId,threads:"archived",limit,archiveBefore?}` uses only
  Discord's **public archived** endpoint, at most 100 posts per page, with
  `nextArchiveBefore` timestamp pagination. `public-active` cannot read archived
  threads. Private/joined-private archives are never queried or included.
  Forum/media parents use these discovery operations; messages live in posts.

Every scoped read checks current caller and Bot membership, View Channel and Read
Message History in both source and output locations. Cross-channel output is
conservatively allowed only when effective same-guild parent permission
_overwrites are identical_ and source age restrictions do not exceed the output
location. This may reject a genuinely safe subset audience; there is no unsafe
"caller can see it, therefore everyone can" fallback. Parent and used-thread
permissions, active/archive boundaries and source registrations are rechecked
before inference/output and queued delivery, including later turns and persisted
JSONL/SQLite contexts. Permission changes can therefore stop a scoped conversation
rather than silently dropping provenance and continuing. `preEpoch:true` affects
platform messages only; an authorization change still starts a fresh internal
conversation epoch.

Channel JSON is an array of existing Discord binding declarations, omitting
`agentId` and server-owned `epochRevision`: each includes a stable UUID `id`,
`botInstanceId`, `botUserId`, exact `target`, `enabled`, `trigger`, participants,
tools, readDomains, inheritThreads and manage. See `channel_config schema` or
[channels](channels.md) for the full strict binding contract. The host derives a
stable package Agent UUID. Tools come only from the existing closed Discord
registry and bindings may narrow the Agent ceiling. This iteration always uses
restricted execution, never trusted exec. Optional ordinary `processor` and
owner-only `observation` declarations include the complete frozen program/code
and policy in the channel JSON; dependency snapshots already supported by that
contract remain frozen data, never evaluated during import. Skill SKILL.md files
are prompt-only for Discord, without executable declarations. Scope, participant,
role, live Bot identity/visibility and observation permissions use existing
Discord validation and per-input authorization, not QQ/Feishu grant semantics.

Review the exact source (including every channel audience and processor), hash,
base revision and previous package in the import card, then **Approve and apply**.
The same durable review is also available under **Discord access → Reviews**.
There is one approval, not one in each view. Pending reviews survive restart,
expire after 15 minutes and cannot be reused after cancellation or a configuration
change. Retained releases can be selected for review rollback. Package-owned
Agents/bindings cannot be changed through fragmented legacy proposals; edit the
complete package instead. Unrelated legacy Discord Agents/bindings continue to
use their existing flow. Removed assignments become default-deny; changed scopes
receive fresh authorization epochs. Published package Agents use frozen private
state directly, not mutable live AGENT.md files.

**Boundaries:** Remote folder import is rejected, never resolved on Main.
`initialize`, full SDK imports and arbitrary dependency execution are unsupported
and fail closed. No external installation, commands, webhooks or platform
mutations run during import/publication; rollback cannot undo later external
side effects. Reviews use the current aggregate platform base: concurrent
publications can stale a pending review, which must be recreated explicitly.
There is no cross-platform package/transaction. Retention is bounded by private
store size limits; an oversized publication fails without changing the active
release. The host development exec tool is not an OS sandbox; restricted
conversation tools do not expose filesystem writes or activation. Do not put
secrets in source: only private reference provisioning avoids model disclosure.

## Existing Change workflow and compatibility

Read the on-demand built-in `v:skills/project-administration` from any ordinary
administrator Web durable session. No main coordination session is required.
Use `invoke_tool` for `authoring_change`, `project_config`, or `channel_config`
and request `action: schema` for exact current inputs. Complex contracts stay in
the dynamic catalog rather than the resident system prompt. Reading a Skill or
registering a tool is not authorization.

For existing resource-based authoring, the workflow is **create Change → edit files → check → request owner
review**. Delegate substantial implementation with a `changeId`, explicit resource
paths and acceptance cases, not copied bundles or checksum reports. Delegated
editors may edit/check their authorized paths; creating owner delegations and
publication proposals require direct administrator user input. Review buttons
still approve exact versions; ordinary ask/reply and tool calls cannot publish.

Each Change starts from the **published** snapshot and has its own title,
baseline, files, bindings, content revision, delegated editors and saved check
runs. It does not import or modify the legacy shared draft. Editing and testing
do not deploy anything. `expectedRevision` rejects stale edits/check admissions;
the host calculates hashes and records evidence automatically. Concurrent
Changes remain independent. After another publication, an explicit `rebase`
performs a three-way merge by resource path and binding identity; divergent
edits conflict instead of silently including another task's work.

Creation and delegation require a direct owner request in a durable local
Project authoring conversation. Delegated topics can then read, edit within
their assigned resource paths, run checks and request review on later
session/event-triggered turns. Delegation is persisted, revocable and
Project/session-scoped; forwarded text claiming owner approval grants nothing.
Reviews also pin the persisted delegation revision: revoking and regranting
access cannot revive an older approval, including after restart.
Only the Change owner session edits bindings, rebases or closes the Change.
Managed bot conversations and ephemeral calls cannot use this authoring path.

Use `authoring_change edit` with a map of file edits, or ordinary `read`/`write`
against `v:authoring/<changeId>/<resourcePath>?revision=<exactRevision>`.
The read response includes the exact writable path. Virtual writes support
overwrite or exact replacement, never fall through to the host filesystem, and
never materialize code in live loader directories. No business source folder
is needed. Changes to existing shared drafts must be deliberately selected and
applied; they are never smuggled into a prompt-only Change.

`check` records a durable `runId` for:

| Kind | What it proves |
| --- | --- |
| `validate` | Resource declarations and current live configuration references |
| `preview` | Prompt/tool assembly, not model behavior |
| `test` | Authored tool execution with synthetic grant receipts; explicit assertions distinguish passing cases from smoke execution |
| `scenario` | Configured model execution through the existing bounded session loop, with synthetic tools and mechanical scenario assertions, not live service effects |

`runs` lists evidence with current/stale version labels; `run` returns the
saved JSON result in explicit offset/limit pages. Do not recover receipts from
chat history or temporary tool-output files. Known stored credential values
are redacted before evidence persistence; this is not a general secret scanner.
Never put secrets or private production data in source, fixtures or scenarios.
Check results are untrusted data, not new execution authority.
Closing a Change stops new authoring work without deleting its evidence.
Authorized participants can still read history, and already-admitted checks
can save their final outcome for the original revision.

`request_probe` creates an owner review in the originating topic and in Project
coordination. Approval is one use, pins source, arguments and GET-only grant
scope, expires after ten minutes and permits at most eight broker calls in a
30-second run. It can explicitly approve a new test connection before any
production publication. Native network/filesystem access, HTTP writes and inbox
delivery remain unavailable. No live request runs merely because an agent
requested review. The saved result is linked by `runId`, and a completion event
returns it to the author. Pending requests survive restart; interrupted runs are
marked failed and never automatically replayed. Editing or revoking the Change
invalidates pending requests and interrupts active probes.

`propose` requests review of the exact Change snapshot against its published
base. The card summarizes affected bindings, prompt/tool/permission changes and
current-version checks, with full resource and binding details available.
Publishing this snapshot leaves any unrelated shared draft untouched.
Owner approval is separate from preparing a proposal; ordinary messages,
tool results, `reply` answers and silence never publish.

The owner-only `/api/agent-resources/probe-requests` endpoint lists saved probe
reviews. `POST /:id` approves one run and `DELETE /:id` cancels a pending review;
both require `{revision}`. Responses contain a result with `requestId`,
`revision`, terminal status and, after execution, `runId`. A timeout or lost
response is an uncertain outcome: reload the saved status, do not blindly
reissue an execution. All endpoints are Project-relative and non-cacheable.

### Legacy shared draft compatibility

`project_config` supports existing shared drafts and recovery in ordinary local
administrator Web durable sessions in the exact Project. All actions require a
direct authenticated administrator user turn. Background events, forwarded
session messages, temporary task/call executions, managed Bots and group chats
cannot acquire these rights by reading the Skill or claiming an owner identity.
Reads expose credential reference names, never stored secret values.
Credential and publication metadata identify the initiating Web session; its
private card is not rendered in another session. Authenticated group-setup HTTP reviews use `owner:service-groups` as
an explicit UI origin, not a fabricated live session or a model identity. This
retains group review without a dedicated management session.

For legacy draft work, read the required baseline before handing implementation to a developer topic.
Send complete context in one request when possible. Normal `message` delivery
queues the next turn without interrupting work; `silent: true` only archives,
does not inject into active context, and does not wake the recipient. Task
materials and unblocking instructions require a non-silent request. If context
must be split, send parts sequentially and finish with a non-silent request.
Intent labels such as `progress` describe purpose, not delivery policy.

The tool supports `schema`, `inspect`, `read`, `write`, `remove`, `bind`, `stage`,
`validate`, `preview`, `test`, `probe`, and `propose`. `schema` returns a complete resource
template, including skill tool declarations and grant examples.

1. Inspect the current draft revision and this Project's bot, conversation and
   folder inventory. Use exact identities, not chat display names.
2. Implement and test the candidate before deployment. `preview` and `test` accept
   a complete `{version: 1, files, bindings}` in `bundle` without staging it.
   Without `bundle`, they use the current draft. Use `toolName`, `testArguments`,
   `capabilityResults` and the conversation identity; `assertion.expected` checks
   the result. These nonmutating steps can continue on a worker-completion turn.
3. When the owner requests real access verification, `probe` runs that same
   candidate/draft source through existing approved GET grants. It does not
   change the draft or deployed code. See [execution and testing](#execution-and-testing).
4. Only when preparing deployment, write snapshot files or stage the tested
   bundle using the current draft `expectedRevision`, then validate and preview
   affected conversations. Conflicting edits are rejected. `bind` replaces one
   exact binding. Use `propose` to open an owner publication review card. Review the exact changed
   code and prompts, and all previous/new bindings, readable folders, endpoints,
   credential references and inbox targets. The owner chooses **Publish** or
   **Cancel** in that card. `/agent-publish <exact-draft-revision>` in Project
   coordination remains a fallback when the card is unavailable.

The model cannot publish through `project_config`, `ask` or `reply`. Ordinary yes/no
questions, chat answers, commands copied into group messages and other-session
messages are not authoritative publication approval. `propose` is nonblocking:
it returns request identity, revisions, changed paths and binding counts without
echoing full source or bindings into the tool result. The owner UI fetches exact
review content separately. Reviews are persisted with the exact candidate and
published base. Re-proposing the same pending review reuses its ID. A shared
draft edit invalidates its legacy review, not an independent Change review;
an edited Change or changed published base requires fresh review. Runtime
restart preserves pending review, never implies approval. A cancelled review
never publishes. Validation does not establish that business logic is correct.

The authenticated owner-only Project-relative
`GET /api/agent-resources/publication-requests` returns `requests` plus the
backward-compatible `request` field (one pending review or `null`).
Reading this endpoint never creates or approves a request.
`POST /api/agent-resources/publication-requests/:id` publishes and `DELETE` cancels;
both require exactly `{revision, baseRevision}` from the review. Success returns
`{result: {requestId, revision, status: "published" | "cancelled" | "waiting"}}`. Prefix paths
with `/projects/<projectId>` at Main. Responses are non-cacheable. Stale IDs,
foreign Project requests, changed revisions and repeat clicks cannot publish.
Failures are shown to the owner, never treated as approval; permanent failures
require correction and a fresh explicit decision. The legacy slash command uses the same guarded
publication path and invalidates pending review metadata.

Publication revalidates the exact candidate and live targets under the
publication guard and serializes activation. Only actually affected bindings'
contexts are retired. If their input admission, active turn or queued work is
still busy, the owner's recorded card approval becomes `waiting`. The runtime
rechecks these approved requests every two seconds, and after session startup
on restart. Every attempt rechecks the exact candidate/base and current author
scope; it never approves an unapproved request or silently rebases one.
Permanent errors remain visible instead of entering an automatic retry loop.
Cancellation revokes a waiting approval.

Publication does not cancel accepted work or silently drop a mailbox. Affected
idle contexts are retired so their next input uses the new prompt and tools.
New channel input during activation is explicitly rejected for retry. The
legacy slash-command path still reports a busy boundary to its caller; it does
not create a waiting card implicitly.

`/agent-rollback <historical-revision> <current-published-revision>` restores a
retained release and keeps the draft. Twenty distinct historical revisions are
retained. Rollback restores configuration, not external actions or credentials.
Folder availability and inbox ownership are still checked during use.

## Resources and bindings

Allowed snapshot paths are:

- `agents/<name>/AGENT.md`
- `skills/<name>/SKILL.md`
- `skills/<name>/<source>.js` or `.ts`

Names start with a lowercase letter and contain lowercase letters, numbers,
underscores or hyphens. Every managed role must declare an explicit
`allowedTools` array. For imported modules, explicitly declare an `allowedModules`
ceiling as well. Every tool import must occur in that role's list; absent or
empty `allowedModules` denies all imports. Use exact module identifiers, never
wildcards. This role ceiling adds to controlled skill-tool import policy;
ordinary host `exec` does not use the authored role ceiling. For example:

```markdown
---
description: Read-only group support
defaultMode: session
allowedTools: [read, search, service_status]
allowedModules: [node:path, '@shadow/service-read']
---
Answer this group's questions using the approved documentation.
Ask for a reproducible example when a report lacks context.
```

The binding chooses the role and selected skills:

```json
{
  "botInstanceId": "<exact bot instance ID>",
  "platform": "qq",
  "conversationId": "group:<exact group ID>",
  "enabled": true,
  "agent": "support",
  "skills": ["service"],
  "allowFrom": ["<permitted member ID>"],
  "readFolders": ["<current Project folder ID>"],
  "parameters": {},
  "grants": [{
    "id": "service-read",
    "kind": "http",
    "origin": "https://example.com",
    "routes": [{"method": "GET", "path": "/public/status"}]
  }]
}
```

QQ/Feishu resource bindings use the contract above. Discord packages compile
through the Discord integration contract instead, preserving its default-deny
admission and authorization epochs. Generic resource authoring still rejects
Discord bindings; it is not an alternate Discord authority.

Different groups may choose different
roles, prompts, skill selections, folder scopes and grants. `parameters` are
model-visible data, not secrets. Missing `allowFrom` allows any sender admitted
by the channel; an explicit empty list admits nobody. Sender restrictions are
checked on every user input, including an already active conversation.

Published prompts contain only the selected role, skill bodies and scoped
binding metadata. They bypass normal Project memory, SOUL, workspace and
global tool-discovery prompt providers. Ordinary diagnostic context endpoints
show these effective prompts and tool definitions, including their revision.
Existing conversation history is retained; revocation does not erase previously
disclosed content from history.

There is no general-role fallback for a disabled or removed previously managed
binding, including after restart. Legacy bot session identities resolve through
the Project's legacy bot instance. Conversations never enrolled in a published
binding on this QQ/Feishu path retain their prior behavior. Discord is instead
default-deny even for never-assigned channels and DMs. Configure a group before allowing it to
handle untrusted requests; installing this framework alone does not restrict
all existing bots.

## Read-only resources

`read({path: "folder:<id>/<relative path>"})` reads bounded UTF-8 text or lists
a directory. `search({path, query})` matches literal text in that one resource
and returns at most 50 matching lines. It is not web search, recursive repository
indexing, skill discovery or a general virtual-filesystem interface.

Only bound folders from the current Project can be read. Access is checked
again for every operation. Remote folders use the Child filesystem capability;
their display paths are never opened on Main. Offline/revoked folders fail
explicitly, without local fallback. General shell, write and dynamic tool
invocation tools are not present in this registry. Authored Node tools can have
separately approved native module authority; `readFolders` does not constrain
their native filesystem calls. Managed conversation messages are queued rather than
mixed into the authority of an active input.

Grant only directories whose contents may be disclosed to the group. Common
environment/config and Git metadata paths are blocked, but this is not a general
secret scanner or data-loss-prevention system. A permitted document may itself
contain confidential text.

## Authored tools and capabilities

Selected skill declarations identify relative `.js` or erasable `.ts` source files,
descriptions, object-shaped JSON argument schemas and imports. The keys under
`tools` are the exact exposed aliases; there is no automatic skill-name prefix.
Declare only the aliases selected by the role's `allowedTools`.
For `skills/service/SKILL.md`:

```markdown
---
name: service
description: Read service status
tools:
  service_status:
    source: status.js
    description: Read current service status
    imports: [node:path, '@shadow/service-read']
    parameters:
      type: object
      properties: {}
      additionalProperties: false
---
Use service_status when current status is needed.
```

The source remains a relative snapshot resource, here
`skills/service/status.js`; all tools export an ESM entrypoint:

```javascript
import {call as request} from '@shadow/service-read'
import path from 'node:path'

export async function run(args) {
  return await request({method: 'GET', path: '/public/status'})
}
```

Each `@shadow/<grant-id>` module exposes named `call` and the same function as
its default export. Service access is derived only from these imports, without a
second `capabilities` declaration. Imports do not
authorize reuse of all main-agent tools. The selected conversation binding must
still grant the exact HTTP target/routes/secretRefs or inbox recipient ID.
Every static or dynamic import uses the controlled resolver and must be in both
the tool's `imports` and the role's `allowedModules`.

The supported `node:` builtin catalog lives in
[`src/script-runtime/module-policy.ts`](../src/script-runtime/module-policy.ts).
This increment supports no npm installs or arbitrary package, file, `data:` or
HTTP imports; identifiers must be exact, without wildcards. No global
`process`, `require`, `fetch` or default Node module loader is exposed.

**Raw filesystem and network modules require explicit author/owner approval.**
They operate with the child user's OS authority, are **not limited by
`readFolders`**, and bypass named HTTP-grant restrictions by design when
granted. Prefer `@shadow` grants for scoped HTTP and credentials. Neither module
policy, `node:vm` nor a separate child process is an OS sandbox. Treat approved,
immutable main/developer-authored scripts as trusted implementations; the VM is
an execution context for module routing, not a hostile-code security boundary.
The owner controls role/module declarations; the bot invokes only approved
entrypoints with schema-validated data arguments, never replacement code.
Production native filesystem tools execute on Main with `cwd` set to Project
Home, not a selected folder or remote display path. They are rejected for remote
workdir sessions, without fallback to Main's filesystem. Raw native I/O may
produce nontransactional side effects even if cancellation or a revision change
later causes the result to be rejected; process isolation does not roll those
effects back.

Tool argument and HTTP body schemas use a bounded subset: a single `type`,
`properties`, `required`, boolean `additionalProperties`, object-schema `items`,
`enum`, `const`, string length, numeric bounds and array length bounds.
`description`, `title` and `$schema` are annotations. References, regex,
combinators and unknown keywords are rejected; nesting is limited to 32.
### Execution and testing

Authored tools, generic skill tools and host `exec` share the
[`src/script-runtime/runtime.ts`](../src/script-runtime/runtime.ts) child/VM core,
not separate execution mechanisms. The controlled tool policy uses
`vm.SourceTextModule` and explicit imports; host exec retains trusted host
authority under its host policy. Metadata comes from `SKILL.md`; source modules
are never imported into Main to discover metadata.
The child
is killed/cleaned on timeout, cancellation, completion or crash. Defaults are
15 seconds wall time **including startup**, 64 MiB V8 old-space (**not RSS or
total OS memory**), 32 capability calls and 256 KiB source/JSON payload bounds.
Abort and deadline signals propagate to broker operations.

New tools must use the ESM/import contract; runtime selectors and `capabilities`
declarations are not accepted for new revisions. Existing persisted legacy tools
are supported through an atomic v1-to-v2 resource-store envelope upgrade. It
preserves original snapshots, revision hashes, grants, source and release history,
and records exactly which legacy revisions are grandfathered.
Their `run(args, capabilities)` interface adapts declared capability IDs to exact
`@shadow/<grant-id>` imports without granting native module access. Explicit
module ceilings and binding grants remain authoritative. This preserves the
grant boundary, not the former QuickJS execution engine. Missing grants, malformed
declarations, mixed imports/capabilities and unsafe source fail explicitly;
newly introduced legacy revisions remain rejected after restart.

Tests and live use the shared runner, but tests/probes apply an explicitly
narrower module policy. Only `PURE_NODE_MODULES` from the catalog are permitted
native imports; effectful native modules are rejected entirely, even if unused.
`project_config` action `test` and `agent_tool_test` use synthetic `@shadow`
receipts, not actual service requests or inbox delivery. HTTP mock receipts are
`{status, body}`, not a raw response body; inbox receipts use
`{status: "admitted", sessionId, inputId}`. Draft tests check script flow, not
a service's live behavior or authorization. They cannot execute native effects.
Non-2xx HTTP mocks throw `http_status` with `status` rather than returning their
body, matching the broker. Use `{throws:{code:"network_error"}}` for other safe
capability failures, or `{sequence:[{status:200,body:[]},{status:401,body:{}}]}`
for repeated requests. Sequences fail explicitly when exhausted. Both developer
and authoring tests use the same mock responder and engine; a second VM
test harness is unnecessary. Safe `code` and optional `status` are available to
script catch handlers without raw host error messages.

The authoring session delegates exact runner/configuration/source/hash/tests to a
developer topic; its own tool boundary still excludes shell, writes and dynamic
invocation. The developer uses `agent_tool_test` through `invoke_tool` with
`imports` and `allowedModules` (the role ceiling is required even when empty),
`code`, optional `.js`/`.ts` `source` filename, `parameters`, typed `grants`
mock metadata and `cases` containing `args`, `capabilityResults` and `expected`.
Results include source hash, policy/module manifest and actual/expected evidence:
a small self-evaluation foundation, not an evaluation framework or proof of
live permissions. Developer assertions use the small shared
[`evaluateScriptCases`](../src/script-runtime/evaluate.ts) helper; mock types and
grant checks remain authoring adapters. Draft `test` can include
`assertion: {expected: <any JSON value>}` to use the same helper and return
`evaluation` with `passed`, `actual`/`error` and `expected`. Without `assertion`,
it is a single synthetic smoke execution, not a passing assertion.
No persisted evaluation jobs are created. Native fs/http implementations must
instead be tested by the developer with normal `exec` and project-local
disposable fixtures; synthetic authoring tests cannot validate those effects.

An explicit owner request can use `project_config` action `probe` with binding
identity, `toolName` and `testArguments`. Its default source is **draft**, or
**candidate** when `bundle` is supplied. Candidate snapshots are validated,
hashed and immutable in memory; no import, staging, publication review or bot
activation is needed just to test their code. `target: "published"` is reserved
for deliberately diagnosing the deployed version. `expectedRevision` is optional
for preview/test/probe; if supplied it must match the selected source. No source
selection silently falls back to published code.

Real probes reuse an enabled published binding's **unchanged** service grants.
They do not approve new endpoints, credentials or route permissions; that
permission-review boundary is separate from selecting source code to test.
Only HTTP GET is permitted, never writes or inbox delivery, even if the source
catches a denial. Native filesystem/network modules remain disallowed. A
candidate can use a new tool alias while reusing an approved service grant.
Changing the draft during a draft probe or revoking the published policy during
any probe invalidates the result.

Receipts include `target`, `revision`, `source`, `sourceHash`, and a separate
`authorizationRevision`. Calls are recorded before broker invocation, including
denials, credential failures, transport attempts, response status and safe error
codes. `execution: "failed"` remains failed even if the script catches the error.
`requestAttempted` means the transport was started, not that the server received
it. `httpVerified` requires a successful response; no recorded response is not
proof of connectivity. The probe does not run a bot turn, send QQ messages,
validate writes/comments/wakeups, or assert business success merely because the
script returned a value. No live service was contacted by repository tests:
integration tests exercise the real broker with an injected synthetic transport.

Non-2xx probe calls also include `calls[].diagnostics`, marked as
`source: "untrusted-http-response"`. It contains only a JSON top-level `message`
(or a non-JSON text excerpt), capped at 2,048 characters, and allowlisted
`x-github-request-id`, `x-ratelimit-limit/remaining/reset/resource`, `retry-after`
and `x-github-sso` response headers, capped at 256 characters each. SSO headers
retain only the status, not URLs or organization lists. `truncated` marks
length-limited text. The configured credential and its URL/base64 encodings are
redacted before truncation; arbitrary JSON fields and other headers are omitted.
This is not a general secret scanner. Treat all diagnostics as untrusted remote
data, not instructions. Diagnostics are returned only in the owner probe receipt,
not script errors, automatic logs or durable mutation receipts. Existing cached
mutation failures retain only their safe code/status and are never retried to
obtain diagnostics.

### Binding grants

An authored tool imports the service as `@shadow/<grant-id>` and the binding
must grant it. There is no second access declaration or legacy bridge. The
broker checks current policy before execution and external dispatch. Editing
tool source cannot add a broker grant or choose another Project. These broker
checks do not constrain separately approved raw native filesystem/network calls.

The broker supplies `User-Agent: Shadow` and `Accept: application/json`, plus
the approved credential header and JSON content type when needed. Guest code
cannot supply arbitrary headers. This applies to live execution and probes;
no additional grant or tool-source change is needed for the default User-Agent.

An HTTP grant fixes an HTTPS origin and method/path routes:

```json
{
  "id": "service-read",
  "kind": "http",
  "origin": "https://example.com",
  "routes": [{"method": "GET", "path": "/public/status"}],
  "credential": {
    "secretRef": "service-token",
    "header": "Authorization",
    "prefix": "Bearer "
  }
}
```

Paths are exact except that `*` matches one segment. Calls may supply
`method`, `path`, `query`, `body`, and a mutation `idempotencyKey`; they cannot
override origins or headers. Optional route `bodySchema` restricts bodies.
Use narrow routes and narrowly scoped credentials: a broadly granted search
endpoint still has that endpoint's broad semantics.

The production transport checks and pins public DNS addresses, rejects private
and loopback destinations and redirects, and bounds responses and timeouts.
Credential values are injected on the host and redacted from echoed responses.
Non-success responses are errors, not successful-looking receipts. Mutations
need idempotency keys; lost write responses are uncertain outcomes and cannot
be blindly replayed. Persisted receipts survive restart.

An inbox grant fixes a durable recipient in the same Project:

```json
{"id": "investigate", "kind": "inbox", "sessionId": "web:<investigator ID>"}
```

The caller supplies `{content, idempotencyKey, reference?}`. The recipient cannot
be chosen in tool arguments or be the sender itself.
Delivery has session-origin provenance and queue semantics, never admin/user
impersonation. A receipt means **admitted**, not investigated or completed.
Retries retain the original persisted input ID. Recovery requires an explicit
retry; there is no autonomous background outbox sweeper.

## Credentials and operational boundaries

Credential values must be provisioned outside the model conversation. In a direct
direct administrator Web session turn, the assistant can request private entry:

```json
{"action": "request_secret", "secretRef": "github-issues", "purpose": "Read and collect issues for the reviewed repository."}
```

These are `project_config` arguments, **not** a place for the credential value.
The requesting session pauses while the owner enters a masked value in a separate
composer card. The card submits directly to the Project credential endpoint, not
to chat or the generic question/answer endpoint. The assistant receives only
`requestId`, `secretRef`, and `status: "saved" | "cancelled"`. Values do not enter
tool results, provider messages, conversation history, prompt captures, resource
snapshots, or realtime events through this entry flow.

The UI requires owner administration access and HTTPS or a loopback connection
to Main. It clears the input when the request or visible Project/session changes,
access is lost, the card is hidden/unmounted, or a submission completes. Requests
are in memory, one per Project, and close on session abort or runtime shutdown;
they do not survive restart. Stale submissions cannot write. A failed save keeps
the request pending so the owner can retry. Saving replaces any existing value
under the reference, but does not publish drafts or expand grants. Cancellation
resumes the requesting session without a value.

Authorized Project gateway routes are:

| Method | Project-relative path | Result |
| --- | --- | --- |
| GET | `/api/agent-resources/credentials` | Names only |
| PUT | `/api/agent-resources/credentials/:name` | Store JSON `{value: "..."}` without echoing it |
| DELETE | `/api/agent-resources/credentials/:name` | Remove the value |
| GET | `/api/agent-resources/credential-requests` | Pending request metadata only |
| POST | `/api/agent-resources/credential-requests/:id` | Store JSON `{value: "..."}` and return reference/status only |
| DELETE | `/api/agent-resources/credential-requests/:id` | Cancel without storing a value |

Prefix these paths with `/projects/<projectId>` at the main gateway. The same
gateway authorization applies; responses are non-cacheable, and there is no
value-reading endpoint or tool. Resource snapshots, receipts and credentials live in the Project's private
`config/agent-resources` sibling of Home, not the authored source directories.
Private file modes are used; Shadow does not encrypt this file or use an OS
credential vault. This flow prevents accidental model disclosure, not access by
host administrators or unrestricted host tools. Do not paste credentials into
ordinary chat, prompts, authored code, or test arguments.

Runtime/session persistence and receipt bookkeeping still write host-owned data.
The permission boundary restricts what the conversation agent can invoke; it
does not make the whole Shadow process or ordinary unrestricted agents an OS
sandbox. Existing host-configured event subscriptions remain independent.
Keep the gateway authenticated and loopback-bound as documented elsewhere.
Crash-held capability-store locks require explicit host recovery; do not remove
a live process's lock or replay an uncertain external mutation.

Remote deployment/release hardening remains work in progress. Successful local
fixtures are not evidence that every Child version or installed release supports
the current filesystem protocol.


## Reusable Agent capability profiles

Agent creation/configuration owns capabilities; QQ/Feishu group binding only
selects an Agent, reads its capabilities and requests owner approval. Creators
can use `authoring_change schema` to discover `configure_capabilities`:

1. Inspect the runtime-bound Project Bot inventory; create an isolated Change
   from the published base and create/edit the Agent and skill resources.
2. Call `configure_capabilities` with `changeId`, exact `expectedRevision`, and
   `input: {agent, profiles:[...]}`. This replaces `capabilityProfiles` in that
   Change's `agents/<agent>/AGENT.md`, including for an unbound Agent.
3. Each profile has `botInstanceId`, `platform`, `skills`, `grants`, `readFolders`,
   optional `allowFrom` and `parameters`. The strict contract is the existing
   conversation policy minus `agent`, `conversationId` and `enabled`. There can
   be at most one profile per Bot/platform per Agent (32 total). Grant fields
   retain the existing exact HTTPS origin/routes/body-schema and inbox contracts.
   `credential.secretRef` is only a reference for the authoring layer, never a
   credential value or a field the group-binding user must supply.
4. Decide real repository targets, GET versus writes, allowed request bodies,
   sender limits, readable folders and tool/module ceilings explicitly. Do not
   invent business permissions or convert historical conversation grants into
   public defaults. For an intentionally basic Agent, publish a profile with
   empty skills, grants and folders and an empty Agent tool/module ceiling.
5. If credentials are needed, the owner uses `project_config request_secret`
   in an ordinary administrator Web session and enters the value in its private card.
   The group setup link opens an ordinary Web draft; it neither requests
   credentials automatically nor accepts secrets in ordinary chat. Credentials
   are Project-owned; a separate Bot requires an explicitly scoped profile even
   when reusing an existing Project connection. No host CLI tokens are imported.
6. Run `check validate`, synthetic tool tests as appropriate, and `propose`.
   Only exact owner publication makes the profile selectable for group setup.
   Validation checks unbound profiles too: skills, tool/module/grant ceilings,
   safe routes, and live Bot, folder, inbox and credential references.

Profiles are part of content-addressed file resources and existing Change review,
not a new approval system or mutable runtime default. Existing bindings retain
exact approved policies; profile edits do not silently migrate them. Old Agent
resources remain valid with no profile and retain their original revisions on
reopen; they appear incomplete for new group setup until explicitly configured.
An explicitly empty profile differs from a missing profile. Summary and readiness
responses do not expose credential reference names or values. Group requests reject
skills, grants, folders, parameters, prompts and any other override fields.

### 中文：创建者配置一次，群里只选 Agent

- 能力属于 Agent 创作/配置层：创建者通过 `authoring_change configure_capabilities`
  在独立 Change 中填写本 Project、指定 Bot/platform 的能力 profile，再检查并提交原有
  exact-revision 发布审核。可以先创建尚未绑定任何群的 Agent；无需先给某个群授权。
- 群设置只选 Agent，查看真实工具用途、外部目标及 HTTP 读写方法/路径、只读文件夹和
  私密连接使用情况，再批准启用。不让群绑定人勾 skills、填路由、JSON 或 secretRef。
- 缺 profile 或连接时显示“待完善”，禁用提案，并链接 Project 协调入口，由创建者完善。
  连接需使用原有 `project_config request_secret` 私密输入卡；聊天中不要发送秘密。
  不自动读取本机 GitHub/gh 令牌，不替真实 XMCL 决定仓库、写权限或凭据。
- profile 存在 versioned `AGENT.md` 文件中，不是无审核的全局默认值。旧群授权不会自动
  提升为 Agent 公共模板；旧 Agent/已发布 binding 保持兼容，没有 profile 的 Agent
  不能新启用群。显式空 profile 可用于无工具 Agent。更改 profile 不自动扩大既有群权限。
- Project 数据与凭据隔离；另一个 Bot 必须有自己的明确 profile。每个群仍使用独立候选、
  精确 candidate/base revision 和原发布审批，未批准不执行，不覆盖无关脏 draft。

### Explicit legacy BOT adoption

The one-off migration checkbox has been removed from the normal BOT directory
form after existing packages were adopted. Normal imports, exact owner review,
retained releases and rollback remain available. The explicit adoption API and
legacy metadata reader remain for compatibility; adoption is never automatic
and still requires exact owner approval. Ordinary imports retain their collision
guards. Existing package updates must use normal import, not adoption.

To retain approved legacy metadata, BOT frontmatter may include `agentMarkdown`
(the complete approved AGENT.md, not a manually edited file). QQ/Feishu verify
its prompt, description, tool/module ceilings against BOT fields, then preserve
its full metadata, including capability profiles and inference settings. Discord
also accepts `agentId` to retain the approved UUID and uses `description` as the
existing display name. Normal policy validation still applies.

Adoption requires byte-identical legacy resource files and all exact Agent
bindings for QQ/Feishu; shared skill ownership is refused. Discord requires the
complete identical approved Agent and assignments, excluding only stored
publication/epoch bookkeeping from the equality check. Existing identities,
publication metadata and binding epochs are retained on adoption. Existing
packages cannot be adopted again. Discord adopts Agent, assignments and package
ownership in the same private-document transition. QQ adoption checks both
active Release and draft revision before staging and binds review to that exact
base. No credentials, pairing, connection state or external platform registration
are changed. Stale revisions or changed policy require a fresh export/review.

### BOT directory publication from owner chat

In a direct administrator Web conversation in the owning Project, import `bot_package`.
Use `status` to discover registered Folders and current service/Discord revisions, then
`propose` with `folderId`, relative `directory` and the exact status revisions. This
uses the same safe snapshot staging as the Settings API. Publication is not a tool
action: the owner reviews the frozen source and permission scope in chat and clicks
the explicit approval button. Proposal alone never changes active policies. Directory
edits after proposal are excluded; changed configuration invalidates stale approvals.
Existing package updates do not need `adoptLegacy`; legacy adoption is explicit and
requires the exact active Release. Remote directories fail closed with no Main fallback.
