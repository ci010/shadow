# A2A integration

Project-scoped A2A 1.0 text tasks over JSON-RPC, SSE task updates, persistent
lookup, cancellation, requested-input continuation and outbound agent tools.
Standalone official-SDK bridges expose Claude Code, Codex and GitHub Copilot as
A2A agents. A stdio MCP bridge lets those coding clients call Shadow or another
configured A2A agent. **Disabled by default.** This is a trusted-operator text
integration, not every optional A2A binding or a public multi-tenant service.

The backend uses `@a2a-js/sdk` **1.1.0**, the version available from the configured
dependency registry when this integration was implemented. SDK version and
protocol version are different. The routes use Hono, not Express or gRPC.

```text
Shadow session -- a2a_send --> A2A JSON-RPC --> coding SDK bridge --> coding agent
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
values stored in Project JSON. Missing/invalid credentials fail Project startup.
Credential and A2A configuration changes require a backend restart; live
configuration writes reject them explicitly.

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
per context. Coding SDK user questions produce `TASK_STATE_INPUT_REQUIRED` with
the question in `status.message`. Reply with a new `messageId` and the same
`taskId` (and optionally its matching `contextId`) to resume that task. Duplicate
replies are deduplicated, including after restart. A stream or blocking request
ends when input is required; submit the reply or subscribe again for updates.
An ordinary question in final prose does not automatically become a suspended
task. Shadow's native runner still completes normal conversation turns.

The outbound client preserves `AUTH_REQUIRED` from remote agents but does not
send credentials through message parts or interpret text as permission approval.
Fix authentication with the remote operator, then query the task again.

SSE streams task state and the final text artifact, not private reasoning,
tool arguments/results, or token-level deltas. Disconnecting a stream does not
cancel the task. Clients can query or subscribe again. Proxies should allow
long-lived SSE connections.

## Outbound tools

These tools enter the existing lazy tool catalog when A2A is configured. Use
them from a session role that permits `invoke_tool` and the corresponding dynamic
tools. They are not additional LLM providers or local `subagent` executions.

```json
{"name":"a2a_agents","args":{}}
{"name":"a2a_send","args":{"agent":"peer","message":"Summarize the following explicitly supplied text: ..."}}
{"name":"a2a_get","args":{"handle":"<local-handle-returned-by-send>"}}
{"name":"a2a_reply","args":{"handle":"<input-required-local-handle>","message":"TypeScript"}}
{"name":"a2a_cancel","args":{"handle":"<local-handle-returned-by-send>"}}
{"name":"a2a_calls","args":{}}
```

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

## Call Claude Code, Codex or GitHub Copilot

The separate `integrations/a2a` workspace uses official SDKs pinned to
`@anthropic-ai/claude-agent-sdk` 0.3.276, `@openai/codex-sdk` 0.155.0 and
`@github/copilot-sdk` 1.0.14. Root `pnpm install` installs them, including supported
platform CLI binaries. They are **not** imported by Shadow's backend or Electron
host. Copilot uses its stdio runtime, not in-process FFI; the unused `koffi`
build script is explicitly disabled. Run bridges from the repository checkout.

Create an operator-owned JSON configuration outside source control, for example:

```json
{
  "projectId": "coding",
  "stateDirectory": "C:\\a2a-data\\claude",
  "cwd": "C:\\code\\my-project",
  "port": 3001,
  "server": {
    "url": "http://127.0.0.1:3001/projects/coding/a2a",
    "callers": { "shadow": "SHADOW_TO_CLAUDE_TOKEN" },
    "timeoutMs": 300000
  },
  "backend": { "type": "claude", "tools": [] },
  "environment": ["ANTHROPIC_API_KEY"]
}
```

Use existing absolute paths appropriate to your OS. `cwd` is the explicitly
authorized local resource directory, never a model-provided path. The directory
can contain project instructions; register only resources trusted for this agent.
`stateDirectory` must be dedicated to **one** bridge and outside its coding
workdir. Provide the referenced A2A and provider environment variables to the
process, then start it:

```powershell
pnpm a2a:bridge --config C:\a2a-config\claude.json
```

The listener always binds `127.0.0.1`; it never listens on an untrusted interface.
The public URL remains explicitly configured for reverse-proxy deployments.
Use a different state directory, port and caller credential for each bridge.
The default concurrency is one because coding tasks may share a workdir.

| Backend | `backend` configuration | Provider environment | Permission behavior |
| --- | --- | --- | --- |
| Claude Code | `{"type":"claude","tools":[]}` | `["ANTHROPIC_API_KEY"]` | Only text and `AskUserQuestion` by default. Explicit operator tool names may be added; further permission requests are denied. Project/user MCP settings are not loaded. |
| Codex | `{"type":"codex","sandbox":"read-only"}` | `["CODEX_API_KEY"]` | Network/web search disabled, approval escalation forbidden. `workspace-write` must be explicitly selected by the operator; no `danger-full-access` option. |
| GitHub Copilot | `{"type":"copilot","tools":[]}` | `["COPILOT_GITHUB_TOKEN"]` | Empty SDK mode, text and `ask_user` by default; explicit tool availability does not grant requested permissions. Permission requests are rejected, including managed-policy requests. |

An optional top-level `model` selects the coding SDK model. Model providers and
account subscriptions still determine what is available and billable. The
bridge passes only basic OS environment plus the named `environment` entries.
It does not forward inbound A2A credentials or ambient provider secrets.
Provider config/session directories are isolated under its state directory.
No existing Claude/Codex/Copilot user sessions are adopted.

Native session IDs are saved against the authenticated A2A context, workdir and
backend policy. A changed policy cannot silently resume an old context. New tasks
in the same context resume the native SDK session; a restart does not replay an
unfinished turn. SDK subprocesses are stopped on cancellation/shutdown.

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

Restart Shadow, load `a2a_send`, and select `agent: "claude"`. Repeat the same
pattern for Codex and Copilot. Tool permissions are real operator grants, not
sandbox guarantees. Do not turn on unrestricted coding tools for untrusted
callers. SDK questions only solicit task input; they do not authorize new tools.
Codex's TypeScript SDK has no interactive question callback; its final questions
are ordinary completed text results, followed by a new task in the same context.

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
requested-input continuation, notification recovery, coding SDK adapter
contracts, official SDK loading, and the actual SessionManager runner with both
session stores using a synthetic provider. Typechecking includes the separate
bridge workspace. These tests do not exercise real paid provider accounts,
certify every A2A implementation, or validate public TLS or native desktop
packaging. File/data parts, remote permission approval, webhooks, REST/gRPC and
v0.3 compatibility are intentionally unsupported, not silently approximated.
