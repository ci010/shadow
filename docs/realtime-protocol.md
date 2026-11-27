# Shared live transport

## Dynamic Main WebSocket

The Web and Electron clients share one socket per Main host. They first request
an upgrade ticket via authenticated `POST /api/live/ws`, then offer the returned
`protocol` and `proof` as WebSocket subprotocols on `GET /api/live/ws`. The
server selects only `shadow.live.v1`. The ticket is single-use, expires after
15 seconds, and is bound to the gateway audience and request origin. Do not put
it in URLs or logs. This lets Electron prove authorization through its existing
trusted main-frame HTTP credential path rather than trusting an unverified
WebSocket frame. A revoked browser session closes the socket. Delegated mobile
clients use SSE directly; Child/device and older hosts that cannot issue a ticket
use the existing SSE endpoint. Neither transport starts a Project by subscribing.

Send a JSON text command with a strictly increasing safe integer `id` per
connection and the full desired set, for example:

```json
{"type":"subscribe","id":1,"subscriptions":[{"topic":{"kind":"projects"}},{"topic":{"kind":"chat","projectId":"default","sessionId":"web:123"}}]}
```

Each entry accepts an optional resume `cursor`. The server validates and
reauthorizes every requested topic, but retains approved unchanged topics
without reset or replay. It sends replay `event` frames for additions first,
then `{type:"subscribed", id, cursor, added, removed, rejected}`. `added`
contains `{topic, reason?, unavailable?}`; `removed` and `rejected` contain
topics. A reset reason requires an authoritative HTTP snapshot; `unavailable`
means the topic is not ready. An absent cursor gives `initial`. Even with
successful replay, a newly observed subscription needs an authoritative
baseline if the client has none. Removed topics stop receiving events at the
update boundary; rejected topics never receive replay. An empty set unsubscribes
without closing the connection.

Live events and heartbeats reuse the SSE JSON envelopes (without SSE framing).
Keep resume state per topic: an added topic can replay events older than events
already received for unchanged topics. The acknowledgement cursor is a
watermark only for accepted and available topics in the acknowledged set; do
not use it for rejected or inactive topics. Runtime changes send scoped
`{type:"topic-reset", cursor, topics, reason, unavailable}` messages without
resetting other Projects. If the Project is deleted, its topics are removed.
Commands are limited to 128 distinct topics, 32 KiB of topic JSON, and 64 KiB
per frame. Invalid commands close the socket; clients can reconnect with
per-topic cursors or recover through snapshots.

## Fixed WebSocket read projections

The renderer-safe contract is [`projection-wire.ts`](../src/realtime/projection-wire.ts).
These explicit Project-qualified topics are available on the existing socket:

- `{kind:'session-summary', projectId, scope:'navigation'|'full'}` uses the same
  bounded DTO builder and navigation pruning as `/api/sessions/summary`.
- `{kind:'session-stages', projectId}` initially supplies the sparse
  `/api/sessions/stages` DTO. Continue consuming the existing `sessions` topic's
  validated `activity` replacements; activity ticks do not reread the full map.
- `{kind:'channels', projectId}` supplies only sidebar-safe BOT identity and
  connection status fields, never editable configuration or secret flags.
- `{kind:'service-groups', projectId}` supplies the observation catalog with
  message bodies omitted. Explicit `group`/`session` detail selections stay HTTP.
  Shared sidebar owners retain every Project's list/count/navigation rather than
  hiding non-visible Projects; catalog changes arrive as snapshot replacements.
- `{kind:'io-runs', projectId}` supplies `{runs}` with the same accessible-session
  filtering and 100-run bound as `/api/io/runs`.
- `{kind:'folders', projectId}`, `{kind:'folder-devices', projectId}` and
  `{kind:'nodes', projectId}` supply the corresponding folders, picker devices,
  and Main inventory HTTP DTOs. Admission uses the socket owner's current
  authorization, not a credential supplied in the subscription. Node inventory
  has the same host-wide visibility as its authorized HTTP endpoint; Project
  qualification is a subscription/cache boundary, not a narrowed inventory claim.

Hosts with a registered projection reader advertise `projectionSnapshots:true`
in subscription acknowledgements. Mixed-version clients should negotiate this
using legacy topics first, before sending these new topic kinds to an older
host that cannot parse them.

An accepted newly added projection is always resnapshotted, even when its cursor
could replay ordinary events. The subscribe acknowledgement adds
`projections:[{topic,snapshot:{event:'snapshot',revision,data}}]`, or an explicit
`{topic,error:'projection_unavailable'}`. For a new consumer of an already active
shared topic, or recovery after a revision mismatch, send `snapshot:true` on that
subscription entry. This returns another acknowledgement snapshot without
replacing the socket or disturbing other topics. Revisions are opaque strings.

Updates use ordinary topic `event` envelopes. Summary and runs payloads are
`{event:'delta',base,revision,upsert,removed}` relative to that socket's last
snapshot/delta; key rows by `sessionId` and `id`, respectively. Apply the whole
delta only when `base` matches; otherwise request a fresh snapshot. Other
projections send `{event:'snapshot',revision,data}` replacements. Revision and
row equality suppress unchanged output. Inventory bodies and per-viewer delta
baselines are never put into the shared replay journal or another socket's
cache. Lease replacement, replay gaps and reconnects use fresh snapshots rather
than attempting to replay private inventory data.

Reads retry across concurrent published mutations and recheck runtime identity
and topic authorization before delivery. If a subscription batch cannot obtain
a stable watermark after three attempts, its ACK marks the affected projections
unavailable rather than disconnecting the shared chat/resource stream. The next
successful projection update can supply a fresh baseline. Transient churn in
the active push path drops the unstable base and retries only that topic with
capped backoff, even without another domain event; a different read failure
still disconnects for resnapshot.
Existing per-client bounded send queues also apply to snapshots and deltas.

Renderer projection owners wait for the negotiated initial snapshot, not an
HTTP read triggered by subscription readiness or a 750ms race. Unsupported
peers signal HTTP fallback; stalled transport has a 10-second recovery deadline.
HTTP snapshots for projections and audio/config/model catalog share a renderer
budget per Main across Projects: at most four concurrent requests, started at
least 40 ms apart, with a 12-second transport deadline from dispatch. A pushed
snapshot, revoked access, or disposal cancels queued/obsolete reads. SSE keeps
legacy invalidation topics and HTTP baselines; it does not carry these projection
snapshots. Explicit Project removal or a denied read clears protected values;
restoration requires authorized data. SSE availability frames scope a removal to
its Project, and a mixed subscription can reconnect without the removed Project
blocking healthy topics. If an older server closes after a removal marker without
its scope, the renderer hides possibly revoked data until availability is known.

Audio status remains HTTP because external executable/model files have no
authoritative change feed. Visible consumers share audio/config/model owners
by Project endpoint and transport identity; transparent development logging does
not change identity or merge injected transports. The last lease releases the
subscription, cache and pending work. Invalidate-only owners reconcile once per
observed disconnect/recovery gap; genuine invalidations during an HTTP snapshot
still trigger a trailing read. WebSocket diagnostics report only fixed stage and
failure labels and an optional numeric close code, not URLs, close reasons,
tickets or payloads. These signals locate future failures; a network trace without
WebSocket close information cannot establish the cause of prior disconnects.

Automatic reconnects use exponential backoff (500 ms up to 10 seconds). A
subscription acknowledgement does not reset that backoff: the connection must
remain ready for 30 seconds, so repeatedly acknowledged short-lived connections
cannot keep retrying at the minimum delay. Transport teardown cancels the
stability timer. Reconnect diagnostics include numeric `retryAttempt` and
`retryDelayMs` fields to make this behavior visible without exposing peer data.

Main emits rate-limited `[realtime]` diagnostics for slow subscription conversation
or projection reads (over two seconds), failed snapshot reads, projection push
failure, subscription processing failure, and socket errors. These use fixed reason labels only, with
no session/Project IDs, frame contents, credentials, or raw exception messages.
Slow-read diagnostics do not change the acknowledgement deadline or terminate
the connection. Each new reason is suppressed for 30 seconds across the hub to
bound logging during reconnect storms. Correlate these server diagnostics with
renderer `Live transport` stages; a successful `POST /api/live/ws` only proves
ticket acquisition, not WebSocket upgrade or subscription acknowledgement.

The global Project directory still uses the existing authorized `projects`
notification topic and one shared HTTP catalog owner. Child workspace health
probes acquire that same owner instead of issuing a second `/api/projects` GET;
probe waiting is bounded to 10 seconds without cancelling another consumer's
shared request. This is intentionally not an API-over-WS directory tunnel.

Explicit older-history paging and expanded history-window revalidation still
use HTTP. Their independent input-delivery data can reuse the current healthy
conversation WS snapshot after its recent history tail has been consumed.
Delivery invalidation, reset, failed refresh or disconnection requires recovery;
a recent tail never replaces an expanded window or a selected physical segment.
Small conditional history responses for an expanded window remain expected.

## SSE endpoint

`GET /api/live?topics=<JSON array>&cursor=<optional epoch:sequence>` is a
host-origin endpoint, not a project-prefixed endpoint. It uses the existing
Main authorization: launch bearer credential or a valid local browser session
when configured; otherwise verified loopback client address and hostname. Ordinary gateway origin and launch
credential checks also apply. Opening the endpoint does not start projects.

[`src/realtime/protocol.ts`](../src/realtime/protocol.ts) is importable by backend
and renderer without Node or Vue imports.
Topics are explicit project-scoped `chat` (with logical `sessionId`, such as
`web:chat-123`), `sessions`, `logs`, `spans`, `io`, or `integrations`. Unknown projects and topic
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

## Workflow input references

`POST /api/chat/send` and `/api/chat/message` accept optional `references` (at most
8). The renderer-safe contract is
[`src/shared/input-references.ts`](../src/shared/input-references.ts); do not import
WorkflowRuntime into the renderer. Example:

```json
{"chatId":"review","content":"Explain this node","references":[{"kind":"workflow","projectId":"project-id","workflowId":"flow-id","revision":3,"selector":{"kind":"node","index":0,"nodeKind":"record"}}]}
```

Only `kind: workflow` is supported, not BOT projections. Each reference requires
Project ID, stable Workflow ID and positive integer revision. Optional `runId`
selects that run's captured definition, not the current definition. Optional
`selector` is `{kind:source}`, `{kind:gate}`, or
`{kind:node,index,nodeKind}`; node indices are zero-based in `definition.nodes`
(excluding source/gate), not canvas IDs. Omit selector for the whole Workflow.
Unknown fields, invalid selectors, cross-Project identity, missing runs and stale
revisions fail with HTTP 400; no silent upgrade or ignored references. Current
reference revisions must exactly match current definitions. References alone may
supply message content. `retry:true` rejects nonempty references: retry uses the
already persisted user input, not a newly resolved snapshot.

The authenticated Project route resolves references once before message
admission and appends a bounded identity/shape summary and exact `v:workflows`
path to the ordinary user message. It copies no code, binding demands, job
configuration, observations or arbitrary node payloads. Queue delivery retains
that string; later inference does not re-resolve it or mutate the system prompt.
The context block explicitly labels values as data, not instructions or grants;
text resembling this block in user content does not acquire host authority.
Paths may expose newer state when read later; the admitted snapshot stays fixed.
The initial display label/chip is a renderer concern, not a trusted request field.

## Conversational response provenance

Conversational assistant records and matching `response` payloads may contain
`responseContext`, defined in
[`src/sessions/response-context.ts`](../src/sessions/response-context.ts):

```json
{
  "version": 1,
  "turnId": "runtime-turn-id",
  "responseId": "runtime-turn-id:0",
  "source": { "kind": "session", "sessionId": "web:reviewer" },
  "userInvolved": false
}
```

The source is the runtime input that began the turn: `user`, `session`, or
`event`. Events include `eventId`, `type`, and `source`, and may carry a known
`failed`/`cancelled` trigger status. This is a small display projection, not the
full input, a reply address, or an authorization grant.

`userInvolved` records whether the response serves admitted user input, including
an unfinished user request continued after an event interrupts its tool loop.
Merely queued or silent input does not count;
user steering affects subsequent output without rewriting earlier responses.
An event's historical user origin does not count as present user participation.
An interrupted user request retains its audience without changing the event/session
source, delivery policy, or authority. A final assistant response without tool calls
ends that prompt continuity; later independent event turns do not inherit user participation.
This flag describes input participation, not the audience of the output.
History reads repair older lost audience flags across unfinished tool loops before
truncation or pagination, without rewriting JSONL/SQLite records or response IDs.
Continue reuses the unfinished request's audience: an interrupted user request
remains user-involved, including after restart, while continuing background work
does not turn it into a user request. Older recovery records without audience
metadata use the saved turn's response or input provenance. A user Retry is a
new user-involved turn even when it reuses existing model history.

Web displays conversational assistant responses normally, both while streaming and
after history reload, regardless of their triggering source or `userInvolved` flag.
An event such as `background-task-complete` can resume work and produce the final
answer to the user; trigger provenance must not label or fold that answer as a
**Background response**. Existing records use the same presentation without a data
migration. Text, attachments, timestamps, usage and search remain available.
Incoming event cards, peer messages, tool/task cards, yield decisions and recovery
controls retain their existing presentation. Invalid/unsupported metadata produces
a diagnostic and does not hide the response.

The metadata is stored on the same assistant record in both JSONL and SQLite,
not in extra log rows, and is stripped from provider wire messages. It does not
change `replyTo`, `done`, task/call results, A2A results, sync REST responses, or
external channel delivery. QQ, Discord and other channels still receive the
original final text, not Web disclosure labels.

Per-inference guidance asks reusable user conversations to address their reader,
not the triggering Agent/event. Event-triggered continuations of user requests
receive a normal complete answer, including asynchronous results. Independent
updates should be brief without omitting material results or blockers. It is guidance, not runtime
truncation. A peer reply still requires the existing `message` tool. Task/call
and inbound A2A result contracts do not receive this audience instruction.
This display policy does not change request routing or turn delivery. Explicit
pending requests are handled separately through `ask` / `reply`.

## Pending input and decisions

`GET /api/sessions/:key/ask` returns `{request: null}` or the active request.
Existing decision requests retain their brief, choices and answer-authority
rules. Ordinary input requests have `kind: "input"`, `id`, `sessionId`, `question`,
`recipient`, `origin`, `createdAt` and `deadline`, without choices or defaults.
Only live requests imply an active waiter; historical facts do not recreate it.

Reply to ordinary input with `POST /api/sessions/:key/ask` and
`{requestId, text}`. Decision replies retain `{requestId, option}` or
`{requestId, customText}`. `DELETE` with `{requestId}` cancels the request and
current execution. The existing authenticated gateway and stored recipient
checks apply; a human cannot answer a parent- or A2A-caller-directed question.
Decision follow-up/review routes are under `/ask/follow-up` and `/ask/reviews`.

Plain input returns `{requestId, text, answeredBy, answeredAt}`. Both storage
backends append versioned `input_request` facts to the owning physical segment
before publication/answer acknowledgement; these are not model messages or
approval records. The original ask and its tool result remain paired. Input
expiration fails the wait, never choosing the decision policy's default.
The Web input field is separate from the chat draft and is not a background
response disclosure.

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

## Integration configuration invalidation

The Project-scoped `integrations` topic carries only `{event: "invalidate"}`.
Discord proposals, approvals, cancellations, domain changes and learning
progress invalidate the owner configuration view. The renderer refetches the
authenticated `GET /projects/<id>/api/integrations/discord` snapshot, including
after reset/reconnect. No Agent Markdown, memory body, source metadata,
credential or approval hash is copied into this shared SSE payload.

An invalidation is not an authorization grant or proof that a draft was
applied. HTTP reviews still bind the exact Project, revision and hash. The
renderer cancels old requests and clears its configuration data on a
Project/Bot switch; a newer snapshot does not silently rebase an unsaved form.

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

## Project work overview

The coordination workbench lazily acquires `GET /projects/<project>/api/work`
through `project-live-state.ts`. Work mutations invalidate the Project sessions
topic; session activity/invalidations, reset and reconnect also refresh this
authoritative overview. Concurrent workbench consumers share a serialized,
coalesced reader. Ordinary sidebar/chat consumers do not fetch this Project-wide
inventory. The last workbench consumer aborts its pending read when hidden;
there is no idle polling. Failed reads keep the last snapshot with a visible
error, not a success-shaped empty board.

Task details are fetched separately, and ordinary chat uses
`GET /projects/<project>/api/sessions/<id>/work?history=0` for its compact task
link. Neither view derives business completion from LLM/tool activity. Pending
human requests are current waiters, not historical decision records.

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

### Read-only conversation history validation

ChatTab opts into memory-snapshot validation for logical
`GET /api/sessions/:key?shallow=true&snapshot=...` reads (without pagination).
Legacy, physical-segment and paginated callers retain complete response bodies.
The snapshot envelope uses SHA-256 `revision`, `historyRevision` and
`metadataRevision` validators, plus `historyCount`. An unchanged representation
returns only `revision`/`unchanged`; an exact identity-bound history prefix returns
an appended `delta.messages` and either metadata or a validated metadata reference.
Metadata includes command receipts, decision records and segment navigation.
Rewrites, truncation, missing validators and segment rollover require full data;
a rollover during the read returns `409 history_conflict`, not mislabeled history.
This reduces wire bytes, not server history-read/hash cost.

The client retains at most eight snapshots / 16 MiB in authenticated-lifetime
memory, never serves them on network/access errors, and falls back to full reads
after eviction. Project sessions-topic owns recovery inventory validation; chat
readiness still awaits the shared activity reader without forcing another refresh.
`createSnapshot.state.refreshReason` and `readReason` expose bounded implementation
reason labels (initial read, invalidation, manual, recovery), never event payloads.
Initial-history pagination remains separate: partial history must preserve tool
pairs and command/decision merging before it can replace the current full fallback.
