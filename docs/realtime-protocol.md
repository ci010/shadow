# Shared live transport

`GET /api/live?topics=<JSON array>&cursor=<optional epoch:sequence>` is a
host-origin endpoint, not a project-prefixed endpoint. It uses the existing
Main authorization: launch bearer credential or a valid local browser session
when configured; otherwise verified loopback client address and hostname. Ordinary gateway origin and launch
credential checks also apply. Opening the endpoint does not start projects.

[`src/realtime/protocol.ts`](../src/realtime/protocol.ts) is importable by backend
and renderer without Node or Vue imports.
Topics are explicit project-scoped `chat` (with logical `sessionId`, such as
`web:chat-123`), `sessions`, `logs`, `spans`, or `io`. Unknown projects and topic
kinds are rejected. A catalog Project whose runtime failed to start is known but
unavailable, not an unknown Project: it does not reject the other subscriptions
sharing the connection. At most 128 topics and 32 KiB of UTF-8 subscription JSON are
accepted. There is no wildcard subscription.

The Node gateway explicitly bounds the combined HTTP request-target/header
budget at **128 KiB** (`GATEWAY_MAX_HEADER_BYTES`). This accommodates the worst
case of three percent-encoded ASCII characters per UTF-8 JSON byte: 32 KiB of
topics becomes at most 96 KiB on the wire, leaving approximately 32 KiB for the
route, cursor, and ordinary headers. Node's default 16 KiB limit is insufficient.
Oversized JSON or topic counts return HTTP 400; requests exceeding the total
gateway parser budget receive HTTP 431 before route handling. Callers must
surface those failures, not silently truncate subscriptions.

All frames use SSE `event: realtime` and JSON `RealtimeEnvelope` data:

- `event`: topic, cursor, payload, and optional requestId. Chat payloads retain
  their existing event/content fields; requestId is outbound `replyTo`, not inferred from
  the most recent HTTP command. SSE `id` equals the envelope cursor.
- `reset`: cursor and an explicit reason (`initial`, `expired`, `epoch`,
  `invalid`, `project-removed`, or `project-restored`).
- `unavailable`: cursor and the requested topics whose catalog Project currently
  has no runtime. These topics are not ready; their readiness promises reject
  explicitly instead of allowing message submission. Other topics remain live.
- `ready`: current cursor, always after replay or reset. Control frames
  deliberately have no SSE id; clients must process their explicit cursor.
  This marks the connection and available topics ready, not unavailable Projects.
- `heartbeat`: observable control frame every 15 seconds for EventSource
  watchdogs, with current cursor but no SSE id. This is not a persisted data
  event and does not advance the journal sequence.

Persisted injected system-event messages retain the chat payload
`{event:'session_message',physicalSessionId,message}`. Terminal session facts
add `{event:'turn_finished',done:true,status,turnId}`, where status is `completed`,
`failed`, or `cancelled`; the envelope requestId is the turn's `inputId`.
These follow persisted execution-state updates and can follow an already
delivered response with `done:true`. Consumers must reconcile idempotently
and must not append terminal payloads as assistant text.

Commands remain short HTTP requests. `POST /api/chat/send` returns the JSON
admission receipt `{requestId,chatId}` by default (`stream:false` is also accepted);
cancel/resume continue using their existing routes. Admission
uses the existing channel receiver and SessionManager. Steering may reuse the
running turn's requestId rather than the steering command's admission ID.

## Reconnection and snapshots

The cursor query overrides `Last-Event-ID`. Replay sends matching events strictly
after the cursor, in global publication order. The journal defaults to 2,048
frames and 4 MiB of encoded frames. Restarted, missing, invalid, or evicted
cursors explicitly reset; they never silently claim successful replay.

Batch subscription changes and reconnect the **single** physical connection
with the last processed cursor. Every new topic needs its authoritative HTTP
snapshot, even after successful replay. Attach listeners before opening the
connection, buffer transient events while snapshots load, and reconcile
persisted chat history on completion/reset. Token deltas are not restart-durable.
Telemetry is tailed only while requested. Reconnecting to a stopped log/span
tail explicitly resets with `expired`, even if the cursor is otherwise valid:
a journal cannot reconstruct writes made during an unsubscribed interval.
Consumers refetch telemetry snapshots after that reset. Runtime loss/restoration
for a catalog Project emits a reset, the current unavailable-topic list when
nonempty, and readiness on the existing connection. Reset clears the prior
unavailable set. Restored Projects resume publishing and telemetry polling without
opening a second connection; their HTTP APIs still independently enforce runtime
readiness and return explicit unavailable errors while startup is failing.

## I/O control and media separation

The `io` topic carries only `{event: "invalidate", runId}`. Consumers obtain
authoritative run state from the project-scoped `GET /api/io/runs` snapshot,
including after reset/reconnect. This topic never carries audio/video chunks,
generated program source, authorization tokens, or per-frame UI updates.
Capture clients use the same shared live connection as other application views.

`POST /api/io/runs/:id/events` forwards a browser event to the registered
temporary backend, not to a first-party script interpreter. Requests carry
the client/lease identity and event. Source packets include their actual media
format and bounded base64 data. Events are serialized and the temporary backend
acknowledges receipt; their JSON bodies are capped at 2 MiB.

`GET /api/io/runs/:id/updates?after=N` returns asynchronous backend-driven UI,
preview, status and artifact updates. These can arrive after the input request
was acknowledged. An expired update cursor requires a fresh run snapshot and
an explicit indication that transient previews were missed; media bytes are
never inserted into the shared SSE journal.

The local backend uses the small `shadow.io.v1` WebSocket protocol: `open/ready`,
`event/ack`, then independent `ui`, `preview`, `status`, `artifact`, `done` and
`error` messages. Shadow relays this through its stable authenticated browser
endpoint, avoiding per-script browser CORS and origin configuration.

The trusted client stops sources at the approved capture duration and drains
encoder output within a finite grace period. Finishing input sends `end` and
enters a processing state until the backend reports `done`; it does not kill
the arbitrary-language process. Cancel, lease loss and application shutdown
release the capture connection. A reconnected SSE feed cannot resume recording.

See [Programmable I/O](io.md) for permissions, generated applications and
current implementation limits.

## Resource and lifecycle limits

Each connection has an 8 MiB byte-counted stream queue. A slow client is
disconnected with a `slow-client-disconnected` diagnostic instead of growing
memory indefinitely. The next connection replays or resets normally. Heartbeats
run every 15 seconds. Abort, stream cancellation and host shutdown release
connections and timers. Runtime removal releases its telemetry tails; a Project
still in the host catalog becomes explicitly unavailable without disconnecting
healthy Projects. Unknown/removed catalog Projects still invalidate the affected
connection. Removed-runtime publisher leases become
inert, including callbacks queued before removal; replay data from that runtime
is removed and cursors invalidated conservatively.

Logs/spans use one shared tail per requested project/kind, polling once per
second, at most 100 rows per tick. They are not broadcast to chat subscribers.
If a telemetry query fails, the hub emits a `telemetry-query-failed` diagnostic
and errors every connection subscribed to that project/kind. Their tails
and heartbeats stop; unrelated connections remain open. Reconnecting after the
tail stopped explicitly resets, requiring a fresh snapshot before live recovery.
Session invalidations cover accepted input, persisted user-message appends,
finished turns, handoffs, and ended sessions. Empty-session creation,
metadata-only edits, deletion, intermediate LLM/tool stage changes, projects,
nodes, and provider configuration do not currently have
complete publication hooks: keep bounded, visible-only reconciliation for those
views rather than claiming universal event-driven state.

## Retired streaming APIs

`GET /api/chat/events` and `GET /v1/stream/{spans,logs}` return finite HTTP 410
JSON responses with `error: "stream_retired"`. Their connection registries,
keep-alive timers, and independent telemetry polling loops have been removed.
`POST /api/chat/send` with `stream:true` also returns 410, before creating a
session, applying configuration, or submitting input. The old per-request stream
and `X-Shadow-Request-Id` response header no longer exist.

External clients must migrate: establish the relevant project-qualified
`/api/live` subscriptions and wait for `ready` before sending; read the JSON
admission response and correlate output using envelope request IDs. Events can
arrive before the HTTP acknowledgement, so buffer them rather than dropping
fast replies. Reconnect using cursors and snapshots, never by resending input.
The synchronous `/api/chat/message` REST endpoint remains available for clients
that need one completed response instead of live updates. No parallel legacy
stream implementation remains.

`startMainRuntime` uses the project host. Direct
`createProjectRuntime` embedding without a shared hub installs its own
authorized `/api/live`; host-owned runtimes share one hub and never install
per-project live endpoints.

## Session invalidation sources

The project runtime in [`src/index.ts`](../src/index.ts) subscribes to the
following existing bus facts and publishes
`{event:'invalidate',sessionId}` to its trusted project `sessions` topic:

| Fact | Producer and timing |
| --- | --- |
| `session.input.accepted` | `SessionManager.deliver` after successful dispatch/admission, before returning its receipt. |
| `session.message.appended` | `BaseSession.persistMessages` after `store.appendMessages` succeeds; currently **user messages only**, including injected event envelopes. The later `lastActivityAt` state save is not yet complete at this point. |
| `session.turn.finished` | `BaseSession.finishTurn` after execution state and any one-shot execution receipt are persisted. Also produces a correlated chat terminal envelope. |
| `session.handoff` | The session handoff path after replacing the physical segment and in-memory messages. |
| `session.ended` | `SessionManager.createActiveSession`'s stop callback after removing the active session. |
| `background.task.changed` | The project-owned `BackgroundTaskManager`, after storing a running task or its completed/failed state. Only tasks with a session owner publish. |

These facts are not a universal store-change notification or intermediate
LLM/tool stage feed. Consumers must coalesce snapshots and retain the explicitly
bounded reconciliation paths described above.

## Active background tasks

`GET /projects/<project>/api/sessions/<encoded-logical-id>/background-tasks`
returns `{sessionId,total,tasks}` from that project's task registry. Unknown
sessions return 404 without creating a session. The response is non-cacheable,
contains only running tasks owned by that exact session, and includes at most
100 newest summaries. `total` reports the full running count. Each summary
contains `id`, `sessionId`, `kind` (`process`, `tool`, or `subagent`), `title`
(at most 512 characters), `status: "running"`, and `createdAt`. Output, callbacks,
environment variables, and process handles are not exposed or observed.

The composer disclosure subscribes to the existing shared `sessions` topic,
coalesces lifecycle invalidations and reset snapshots, and reconciles every
20 seconds while the pane is active. Switching project/session aborts
old reads; hidden and draft panes do not fetch or retain subscriptions.
Unavailable inventory shows a retryable status, not a stale running count.
This is a read-only view of in-memory agent-owned work, not an OS process monitor
or a persistent job ledger. Remote background exec remains unsupported; the
panel does not introduce remote execution, PID inference, output streaming,
or process termination controls.
