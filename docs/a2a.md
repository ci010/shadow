# A2A integration

Project-scoped A2A 1.0 text tasks over JSON-RPC, SSE task updates, persistent
lookup, cancellation, requested-input continuation and outbound agent tools.
Standalone CLI bridges expose user-installed Claude Code and Codex as
A2A agents. Copilot is currently unsupported (see below). A stdio MCP bridge lets those coding clients call Shadow or another
configured A2A agent. **Disabled by default.** This is a trusted-operator text
integration, not every optional A2A binding or a public multi-tenant service.

The backend uses `@a2a-js/sdk` **1.1.0**, the version available from the configured
dependency registry when this integration was implemented. SDK version and
protocol version are different. The routes use Hono, not Express or gRPC.

```text
Shadow session -- subagent/message --> A2A JSON-RPC --> coding CLI bridge --> coding agent
Coding client -- stdio MCP --> A2A JSON-RPC --> Shadow Project --> SessionManager
```

## Enable a Project

Stop the backend and edit the owning Project's `config/project.json`, adjacent
to its `workspace` directory under `${workspaceBase}.projects/projects/<id>`.
Do not put this setting only in the shared host configuration: Project settings
are not inherited from it.

Add this fragment, replacing the Project ID, endpoint URLs and caller names:

```json
{
  "a2a": {
    "server": {
      "url": "http://127.0.0.1:3000/projects/default/a2a",
      "agentType": "a2a-text",
      "callers": {
        "trusted-agent": "SHADOW_A2A_INBOUND_TOKEN"
      },
      "maxConcurrent": 4,
      "timeoutMs": 120000
    },
    "agents": {
      "peer": {
        "cardUrl": "http://127.0.0.1:3001/projects/default/a2a/.well-known/agent-card.json",
        "endpointUrl": "http://127.0.0.1:3001/projects/default/a2a",
        "tokenEnv": "SHADOW_A2A_PEER_TOKEN"
      }
    }
  }
}
```

The ports above are illustrative: use each backend's actual configured gateway
port. The `server.url` path must exactly match `/projects/<id>/a2a`. Configure its
externally reachable HTTPS URL when using a reverse proxy; it is never inferred
from an untrusted request Host header.

Provide the referenced environment variables to the backend process, using
distinct random secrets of at least 32 non-whitespace characters. Configure each
peer with the corresponding secret. Secrets are environment references, not
values stored in Project JSON. They authenticate external A2A callers, not model
providers or the owner's GitHub account; task/context ownership follows the
authenticated caller.

Missing/invalid or duplicate inbound credentials disable **only A2A inbound**,
not Project startup, local conversations or outbound A2A. An unavailable configured
role or mismatched Project URL has the same behavior. Project diagnostics record
the configuration problem without secret values. The Agent Card and RPC routes
return `503 a2a_unavailable` to authenticated gateway clients; external clients
without gateway credentials remain rejected by the host authentication boundary.
No anonymous access or fallback credential is enabled.

Fix the environment/configuration and restart the backend to re-enable inbound
A2A. Credential and A2A configuration changes require a backend restart; live
configuration writes reject them explicitly. An outbound peer's missing credential
fails that peer's operation rather than disabling local or inbound operation.

Omit `server` for client-only operation. Omit `agents` for server-only operation.
Remove `a2a` to disable the module. No network listener is created separately
from the existing gateway.

## Trust and permissions

Only give access to callers trusted with the **owning Project's context**.
The `a2a-text` built-in has an enforced empty tool allowlist, no skills loading
and no SOUL loading. It still uses Shadow's normal Project prompt composition;
this is not an isolated, context-free model endpoint.

An explicitly selected custom role must declare `allowedTools`. Those tools can
have real host/network effects. Tool filtering is not an OS sandbox. There is no
remote permission-approval UI; do not expose Shadow roles that require interactive
approvals or unreviewed capabilities. The endpoint does not interpret slash
commands, accept folder/workdir overrides, or adopt remote session IDs.

Every request, including Agent Card discovery, requires `Authorization: Bearer
<token>`. Caller identity is derived from that credential, not from message
metadata. Caller task/context ownership is checked within the selected Project;
`tenant`, if supplied, must equal that Project ID. Credentials do not authorize
the gateway's administration, configuration, session history or device APIs.
Do not reuse credentials across Projects unless you deliberately grant both.

Keep the gateway on loopback. To permit remote access, proxy **only** the desired
`/projects/<id>/a2a` and Agent Card paths over HTTPS; do not expose the entire
gateway, inspector or desktop ports. HTTPS URLs and explicit loopback-IP HTTP
URLs are supported. Browser cross-origin access is not enabled by this feature.

Outbound tools can only use operator-configured Agent Card and JSON-RPC URLs.
Redirects and card-selected alternative endpoints are rejected. No ambient
cookies or host administration credentials are forwarded. Register only trusted
URLs/DNS authorities; this is not a general-purpose URL fetcher or DNS-pinning
sandbox. Only the explicitly supplied message text leaves Shadow: history,
memory and local files are not automatically attached.

## Protocol surface

| Endpoint / operation | Behavior |
| --- | --- |
| GET `/projects/<id>/a2a/.well-known/agent-card.json` | Authenticated Agent Card |
| POST `/projects/<id>/a2a` | JSON-RPC with `Content-Type: application/json` and `A2A-Version: 1.0` |
| `SendMessage` | Waits for completion or requested input by default; `configuration.returnImmediately: true` returns an accepted task |
| `SendStreamingMessage` | Initial task snapshot followed by status/artifact updates |
| `GetTask`, `ListTasks` | Owner-scoped persisted snapshots; history limits and list pagination |
| `SubscribeToTask` | Current snapshot followed by future updates; not a replay of every missed event |
| `CancelTask` | Signals the owning execution and waits for its actual outcome |

Use SDK ProtoJSON serialization, not old v0.3 `message/send` examples. Input is
a `ROLE_USER` message containing `text` parts. Files, structured data, metadata,
extensions, task references, push notifications, gRPC, REST bindings and v0.3
compatibility are not supported.

The first response supplies a server-generated `contextId`. Reuse it with a new
`messageId` for a new task in the same conversation. One active task is allowed
per context. Native Shadow user questions produce `TASK_STATE_INPUT_REQUIRED` with
the question in `status.message`. Reply with a new `messageId` and the same
`taskId` (and optionally its matching `contextId`) to resume that task. Duplicate
replies are deduplicated, including after restart. A stream or blocking request
ends when input is required; submit the reply or subscribe again for updates.
An ordinary question in final prose does not become a suspended task. A Shadow
role explicitly allowed to use `ask` can call `ask({kind:"input", question:"..."})`;
the native runner publishes `INPUT_REQUIRED` and resumes that same tool call when
its authenticated A2A caller replies. This does not grant human decision authority.
The default `a2a-text` role remains tool-free.

The outbound client preserves `AUTH_REQUIRED` from remote agents but does not
send credentials through message parts or interpret text as permission approval.
Fix authentication with the remote operator, then query the task again.

SSE streams task state and the final text artifact, not private reasoning,
tool arguments/results, or token-level deltas. Disconnecting a stream does not
cancel the task. Clients can query or subscribe again. Proxies should allow
long-lived SSE connections.

## Shadow session tools

Read `v:skills/a2a` for the built-in workflow guide. Agent-facing discovery and
session operations share the existing Shadow tools:

```javascript
read({ path: "v:agents" }) // Local roles and configured a2a:<agent> targets.
subagent({ agent_type: "a2a:peer", mode: "task", description: "Review supplied text", task: "Review this text: ..." })
read({ path: "v:sessions/<returned-sessionId>" })
message({ sessionId: "<returned-sessionId>", content: "Explain your previous answer." })
read({ path: "v:sessions/<returned-sessionId>/executions" })
read({ path: "v:bg/<returned-executionId>" })
cancel({ executionId: "<returned-executionId>" })
```

A remote `sessionId` is a stable, owner-scoped conversation reference
(`remote:<local-id>`); each send/reply produces a distinct `executionId` under
that conversation. These are A2A journal views, not local executable sessions:
no local parent relationship, workdir, transcript or Initiative is adopted.
Only explicitly supplied task/message text leaves Shadow. Remote subagent
delegation supports `task`, not blocking `call`, and rejects `report_to`,
`preload_tools` and Initiative selectors. Remote `message` accepts only
`sessionId` and `content`; silent/archive, attention and attachment semantics
are not silently approximated.

Conversation/execution reads refresh known nonterminal tasks; VFS lists and
searches use cached local records and do not make network requests. Listings
include only the acting session's remote calls, not the provider's session
inventory or private history. Read/search alone do not grant A2A access: the
native entrypoints retain the corresponding dynamic A2A tool permission checks
(the existing `invoke_tool` grant for allowlisted roles, or named restrictions
for blocklisted roles). Remote-workdir support is unchanged.

`v:bg` is the unified owner-scoped execution view: background tools/processes,
local task/call, and remote A2A executions. It reads the existing background
manager, SessionStore, and A2A journal without copying their state. `v:sessions`
remains the history/conversation entrypoint, including its remote execution views.
Lists/searches never start or poll remote work.

`cancel({executionId})` accepts references from this view, `exec`, or `subagent`;
background references use `bg:<id>`. It replaces the public `kill` tool. Local
cancellation waits for actual execution/cleanup before returning `cancelled`;
pending cleanup remains `cancelling`, and cleanup failures remain visible rather
than claiming a stop. Already terminal results are preserved. It does not delete
a durable conversation or roll back effects. `task` keeps its `report_to`
notification and `call` keeps its blocking return without an extra callback.
Explicit background cancellation suppresses its old completion callback.

**Requested input uses `ask` / `reply`.** A waiting execution exposes
`request: {kind:"input", request_id, question}`. Use
`reply({request_id:"<returned-id>", text:"TypeScript"})`, then follow its returned
execution reference. The remote task and conversation remain the same. Request
references bind the execution and question; stale or duplicate answers cannot
silently become new tasks. `message` rejects active/waiting conversations.

If the owning Shadow session needs missing information, it can first use
`ask({kind:"input", question:"..."})`; consequential decisions use `kind:"decision"`
with the existing brief, options and authority rules. A local answer is not
automatically forwarded remotely. Plain input never grants new permissions.
Cancellation and deadlines stop waiting without fabricating input. Restart
interrupts active inbound tasks rather than replaying them.

New journal records preserve conversation and predecessor references across
restart. Old outbound records without these fields remain readable via their
existing handles, initially exposed as individual conversation views; subsequent
messages retain the known remote context. No JSONL/SQLite session format changes
are required.

### Low-level and MCP tools

The `a2a_*` tools enter the lazy catalog when A2A is configured; their use requires
`invoke_tool` and the corresponding dynamic-tool permissions. `reply` is the
native pending-request tool. The MCP server exposes its own owner-scoped `reply`.
These operations are not additional LLM providers or local `subagent` executions.

```json
{"name":"a2a_agents","args":{}}
{"name":"a2a_send","args":{"agent":"peer","message":"Summarize the following explicitly supplied text: ..."}}
{"name":"a2a_get","args":{"handle":"<local-handle-returned-by-send>"}}
{"name":"reply","args":{"request_id":"<returned-pending-request-id>","text":"TypeScript"}}
{"name":"a2a_cancel","args":{"handle":"<local-handle-returned-by-send>"}}
{"name":"a2a_calls","args":{}}
```

`yield` and `a2a_reply` are not registered aliases. Shadow's base `reply` tool
handles local and remote requests; the stdio MCP `reply` handles that MCP client's
owned remote requests. Other low-level A2A operations retain their existing names.

For conversational continuity, add `"context": "<previous-local-handle>"` to
`a2a_send`. It must reference a call owned by the current session to the same
agent. Arbitrary remote task/context IDs are not accepted as tool handles.

The initial call requests a nonblocking remote task. `submitted` is not success.
Shadow polls a bounded batch every two seconds, survives restarts with known
task IDs, and queues completion or input-required updates to the **owning**
conversation. Updates are external event inputs, not privileged user messages.
Use `a2a_get` for an immediate refresh and `a2a_calls` to recover handles after an
interrupted tool call. `a2a_reply` returns a new durable handle: follow that handle
for the resumed task. A running context cannot silently start a second task.
Remote-workdir invocation through `invoke_tool` retains its existing restrictions.

## Call user-installed Claude Code or Codex

The separate `integrations/a2a` workspace launches **user-installed CLIs**, not
vendor SDKs. Shadow does not install, bundle, download, update, or log in coding
agents. Install and authenticate the official CLI yourself before starting a
bridge. Normal subscription/CLI authentication is supported; SDK API keys are
not required. Run bridges from the repository checkout.

Create an operator-owned JSON configuration outside source control:

```json
{
  "projectId": "coding",
  "stateDirectory": "C:/a2a-data/claude",
  "cwd": "C:/code/my-project",
  "port": 3001,
  "server": {
    "url": "http://127.0.0.1:3001/projects/coding/a2a",
    "callers": { "shadow": "SHADOW_TO_CLAUDE_TOKEN" },
    "timeoutMs": 300000
  },
  "backend": { "type": "claude", "tools": [] },
  "environment": []
}
```

Use absolute local paths appropriate to your OS. `cwd` is operator-authorized,
never remote-controlled. `stateDirectory` must be dedicated to one bridge and
outside its coding workdir. Set the A2A caller token in the bridge environment:

```powershell
pnpm a2a:bridge --config C:/a2a-config/claude.json
```

Optional `executable` is an absolute path to a native CLI executable or its
official `.js`/`.mjs` entrypoint. Otherwise Shadow resolves `claude` or `codex`
from PATH (including Windows `Path`). Windows npm `.cmd` shims are never run
through a shell: only a known sibling official JS entrypoint is supported;
other shims require an explicit executable path. Prompts are written to stdin,
not interpolated into shell commands. The listener binds only `127.0.0.1`.
Use distinct state directories, ports and caller credentials per bridge.

- Claude: `{"type":"claude","tools":[]}` defaults to text-only. Print JSON
  mode uses `--restricted` (Claude Code **v2.1.248+**), `dontAsk`, empty setting
  sources, disabled hooks/skills and strict empty MCP configuration. Explicit
  operator tools can be selected from Read, Edit, Write, Glob, Grep, Bash,
  WebFetch, WebSearch and NotebookEdit. These are real grants, not a sandbox;
  Bash is particularly powerful. No wildcard/default tool preset, subagent,
  skill, or permission-bypass mode is exposed. Permission denials fail the task.
  Normal CLI credential storage and session storage are used; Shadow generates
  a fresh UUID and resumes only its owner/policy-bound saved UUID. Managed
  enterprise settings are still authoritative and must be operator-trusted.
- Codex: `{"type":"codex","sandbox":"read-only"}` uses `exec --json`, never
  approval escalation, disabled web search and workspace network access. Only
  explicit `workspace-write` may widen the sandbox; no full-access mode exists.
  A private `CODEX_HOME` under bridge state excludes ordinary user config, MCP
  servers and existing session inventory. Before each task, Shadow refreshes a
  private copy of the ordinary CLI's `auth.json` from the operator's `CODEX_HOME`
  or `~/.codex`; protect bridge state as credential material. This does not copy
  config or conversations. CLI keyring-only/custom-provider authentication is
  not automatically migrated: unsupported auth fails, without login or fallback.
  Project instructions in the authorized cwd may still be read. Do not mark
  untrusted project configuration trusted in this dedicated Codex home.
- Copilot: **unsupported, rejected at startup**. The installed GitHub Copilot
  CLI 1.0.99-2 help says prompt mode requires `--allow-all-tools`, and additional
  MCP configuration augments user configuration. This is not a verified safe
  replacement for the old SDK permission callbacks. No permissive CLI fallback
  is used. Existing Copilot bridge configurations must not be treated as working.

Optional `model` selects the CLI model. Only basic OS environment plus explicitly
named `environment` entries are passed. Provider API keys are optional opt-ins,
not required bridge credentials. Ambient A2A secrets are not forwarded.
CLI account identity/authentication is reused, **not arbitrary user chats**.
Context IDs are generated by A2A, native UUIDs are private and bound to caller,
workdir, backend, executable, model and environment policy. Policy changes,
including migration from SDK bridges, require a fresh A2A context. No `--last`,
`--continue` or caller-supplied native session selector is accepted.

Structured results and a zero process exit are both required for success.
Missing final completion, invalid JSON, permission denials and nonzero exits fail
closed. Output is bounded; private stderr/tool events are not published as A2A
artifacts. Cancellation kills the CLI process group (POSIX) or process tree
(Windows taskkill) and waits for process close; cleanup errors remain failures.
This cannot roll back effects or control processes deliberately detached by tools.
After hard bridge termination, operators must inspect orphan processes before
restarting. The bridge does not supply an OS/container security boundary.

**CLI limitations:** no verified print-mode interactive question/permission
callback is available here. Coding CLI final questions are ordinary completed
text, not `INPUT_REQUIRED`; send a new task in the same A2A context to answer.
No remote text is interpreted as tool approval. The A2A service and Shadow/MCP
requested-input protocol remain unchanged; SDK-specific question callbacks are
not silently approximated. No paid CLI smoke test was run. Claude/Codex binaries
were unavailable locally; argv/output contracts were checked against official
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and
[Codex CLI reference](https://developers.openai.com/codex/cli/reference/), with
Copilot `--help`/`--version` checked locally. Older CLIs may reject flags; update
manually rather than dropping safety flags.

To call this bridge, add an agent in the Shadow Project:

```json
{
  "a2a": {
    "agents": {
      "claude": {
        "cardUrl": "http://127.0.0.1:3001/projects/coding/a2a/.well-known/agent-card.json",
        "endpointUrl": "http://127.0.0.1:3001/projects/coding/a2a",
        "tokenEnv": "SHADOW_TO_CLAUDE_TOKEN"
      }
    }
  }
}
```

Restart Shadow, discover `a2a:claude` in `v:agents`, and delegate with `subagent`.
The compatibility equivalent is `a2a_send` with `agent: "claude"`. Repeat the same
pattern for Codex. Do not expose tool-enabled bridges to untrusted callers.

## Let coding clients call Shadow through MCP

Create a second operator-owned configuration:

```json
{
  "projectId": "default",
  "owner": "claude-work",
  "stateDirectory": "C:\\a2a-data\\mcp-claude-work",
  "agents": {
    "shadow": {
      "cardUrl": "http://127.0.0.1:3000/projects/default/a2a/.well-known/agent-card.json",
      "endpointUrl": "http://127.0.0.1:3000/projects/default/a2a",
      "tokenEnv": "SHADOW_A2A_INBOUND_TOKEN"
    }
  }
}
```

After `pnpm build`, configure a stdio MCP server in Claude Code or Copilot using
their normal MCP settings. Use `node` directly, not a package-manager wrapper
that could put banners on MCP stdout:

```json
{
  "mcpServers": {
    "shadow-a2a": {
      "command": "node",
      "args": [
        "C:\\code\\shadow\\dist\\src\\a2a\\mcp-cli.js",
        "--config", "C:\\a2a-config\\mcp-claude-work.json"
      ],
      "env": { "SHADOW_A2A_INBOUND_TOKEN": "<supply securely in the MCP launcher>" }
    }
  }
}
```

Copilot's MCP entry also uses `"tools": ["*"]` to expose this server's tools.
For Codex, the equivalent entry in its configuration is:

```toml
[mcp_servers.shadow_a2a]
command = "node"
args = ['C:\code\shadow\dist\src\a2a\mcp-cli.js', '--config', 'C:\a2a-config\mcp-codex.json']
env_vars = ["SHADOW_A2A_INBOUND_TOKEN"]
```

The MCP connection exposes the same six tools. Its owner is fixed by the
configuration, not a tool argument. Use separate state directories, owner names
and inbound caller credentials for clients that must not share tasks. All chats
using one MCP configuration share that configured identity; MCP does not supply
a reliable human-conversation identity here. It is not a public MCP HTTP server.
Background polling persists status, but stdio MCP does not automatically wake
the external coding conversation: that client calls `a2a_get`/`a2a_calls`.
For development only, `pnpm a2a:mcp --config <absolute-path>` runs the TS entry.

## Persistence and failure semantics

Protocol records live in the Project Home's `.a2a/inbound` and `.a2a/outbound`
directories as atomically replaced private JSON files. Session history remains
in the configured **JSONL or SQLite** SessionStore. No existing session schema
or migration is changed.

Inbound records bind authenticated owner, message ID, content fingerprint,
task/context IDs and the logical session. Repeating the same message ID/content
returns the original task without another execution; changing content under that
ID fails. A new task uses the existing logical session, not its physical segment.

Restart marks unfinished inbound work failed with an explicit interruption
reason. It does not replay provider/tool work. This can conservatively report
failure if a process died after side effects but before durable completion.
Do not retry such work blindly.

Outbound calls are journaled before sending. A lost response, disconnect, timeout
or interrupted submission becomes `uncertain`, not success. It retains a local
handle and does not automatically resend. If no remote task ID was received,
query/cancellation cannot recover that missing ID; investigate with the remote
operator before creating new work. A known task ID remains queryable after
restart by the owning session and resumes background tracking.

Notifications are journaled before queue admission. An interrupted or failed
notification admission is marked `uncertain` and is not automatically delivered
again: blindly repeating an agent wake can repeat side effects. `a2a_get` and
`a2a_calls` expose tracking/notification errors. This is not an exactly-once,
crash-durable message queue; a queued wake can be lost if Shadow stops before
processing it. The remote task result remains durable and queryable.

Cancellation/timeout does not roll back effects, and an uncooperative provider
can delay cancellation until it stops. An already completed execution may win
the cancellation race. A client-side 30-second request timeout alone does not
cancel remote execution.

Limits: 64 KiB input text, 256 KiB final text, 96 KiB incoming HTTP request,
1 MiB outbound response/record, 128 concurrent task subscriptions, and 10,000
records per direction per Project, with at most 64 input replies per task.
Storage exhaustion rejects new work.
No automatic retention/pruning is implemented; archive records only while
stopped, understanding that removing them removes their deduplication history.
Standalone bridges exclusively lock their state directories. After a hard
process kill, inspect the PID in `.lock`, verify that owner is no longer running,
then remove **that lock file only** before restarting. Never run two writers
against one state directory.

## Implementation and validation boundaries

`src/a2a/runtime.ts` composes the protocol service and client tools per Project.
The SDK owns wire conversion; `A2aService` implements its `A2ARequestHandler`
contract to keep admission, deduplication, task ownership and persistence in one
place. `sessionA2aRunner` delegates to `SessionManager.deliver()` and correlates
completion facts instead of treating input acceptance as completion.

Focused tests exercise live loopback HTTP, official A2A and MCP transports,
requested-input continuation, notification recovery, mocked CLI process adapter
contracts, fail-closed unsupported backends, and the actual SessionManager runner with both
session stores using a synthetic provider. Typechecking includes the separate
bridge workspace. These tests do not exercise real paid provider accounts,
certify every A2A implementation, or validate public TLS or native desktop
packaging. File/data parts, remote permission approval, webhooks, REST/gRPC and
v0.3 compatibility are intentionally unsupported, not silently approximated.
