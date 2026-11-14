# Project channel message stream

`channel_directory`, `channel_read`, and `channel_send` are loadable built-ins for
an ordinary persistent, local, user-owned Web session in the current Project.
Managed/platform sessions, internal children, automation-owned sessions and remote
workdirs do not gain this capability by discovering the tools. The existing
platform-user `discord_history` / `channel_operations` tools retain their narrower
external-input authorization paths.

## What is collected

Production Project composition explicitly injects one Project-owned stream into
`ChannelManager`. Merely constructing a manager (including existing test mocks)
does not create a default-workspace journal.

- Project connections capture received message creations **before** business
  sender/binding admission, trigger selection or processors. Unbound conversations,
  observation-only inputs and personal connections are recorded without invoking
  a model, tool, command or reply. The existing passive inbox remains the durable
  message history; this stream remains its bounded change/cursor index.
- Discord Gateway edits, deletes and bulk deletes append events under the same
  connection/conversation address. Partial changes need no fabricated sender or
  BOT binding. Live connected-Bot visibility and verified public-thread ancestry
  are still required; private threads remain closed. A transport receipt carries
  no actor, history-read, send or participant grant. Actual thread discovery can
  be recorded before any BOT is assigned.
- QQ, Feishu and WeChat feed their actually received creates into the same host
  receipt path before business admission or attachment downloads. This does not
  install extra platform intents/webhooks, fetch old messages or add missing
  edit/delete feeds. Messages the platform did not deliver cannot be harvested.
- Model processing and replies still require current BOT/verified-owner authority.
  Owner stream-tool read/send checks remain independent of recording: merely
  discovering an unbound address does not grant history reads, tools or output.

A directory package's `subscriptions: []` disables its BOT input execution, not
common receipt. Assignment is frozen at arrival and durable duplicate receipts
cannot wake a newly bound BOT or replay observation processing after reconnect.
The stable inbox address contains Project, connection, platform and real
conversation/thread identity, never BOT role/binding/revision. Binding does not
move its history; execution sessions remain separate. See
[external input routing](input-routing.md).

Connection inspection exposes this receipt data through
`v:connections/<encoded connectionId>/overview.json`, `sink.json` and
`receivers/<encoded receiverId>.json`; `/api/workflows` includes the same
host-resolved projections under `bots.sinks`. These are inspection DTOs, not
Workflow definitions or routing authority. Graph receivers represent observed
top-level groups/channels only: direct-message receipts remain in common history,
and public-thread receipts aggregate under their verified parent without moving
or merging thread histories. Unknown Discord channel types remain unknown rather
than being guessed from numeric IDs. Discovery-only stream entries without
parent/type evidence do not invent graph receivers.

Connection configuration and BOT admission changes use an explicit offline
migration; receipt storage itself never migrates or replays history. See
[Connection policy migration](connection-migration.md) for v2/v3 startup,
backup/recovery and the still-unperformed real-Project rollout.

The stream contains bounded text and identities, not downloaded attachments or
raw credential-bearing payloads. Platform content is untrusted data, never agent
instructions. Disabled/revoked Bots and assignments are checked again at tool use.

## Directory and consumption

`channel_directory {}` returns `conversations`, each with `connection` (Project Bot
ID), `conversation`, optional thread `parent`, `platform` and `capabilities`, plus
retention `floor`/`next`. This is a directory of **collected/admitted** conversations,
not an exhaustive platform inventory. Capabilities describe implemented adapters,
not permission promises; calls still enforce scope and live platform permissions.
Discord's old explicit directory/archive listing can help discover IDs, but private
threads, full archived-thread inventory and forum-parent posting are not supported.

Use an explicit stable logical consumer, independent of the current Web session:

1. `channel_read {"consumer":"support-triage-v1","connection":"BOT_ID","conversations":["CHANNEL_ID"],"includeChildren":true,"limit":50,"attempt":"run-unique-a"}`
2. Process all returned `events` (including deciding not to reply). Each has a
   locally assigned, monotonically increasing `position`; platform timestamps and
   message IDs are **not** consumption cursors. Edits/deletes and late events have
   new positions. `batch` contains the durable range and current attempt.
3. `channel_read {"action":"ack","consumer":"support-triage-v1","connection":"BOT_ID","batch":"UUID","attempt":"run-unique-a"}`
4. On failure, use `action:"retry"` with the same batch/attempt and `error`, then
   read using a fresh unique attempt. A restarted running attempt must explicitly
   retry with its previous attempt before it can be reclaimed.

Reading never acknowledges. An unfinished batch is replayed **before any REST
catch-up**, with fixed event positions even if new messages/threads arrive.
Changing `limit` does not enlarge it. Reconstructing the Web session or backend
preserves a stable consumer; different consumers are independent. The scope is
connection + sorted conversations + includeChildren. Use the same scope on each
read. Ack/retry reuse `Watermarks` and its optimistic journal/fencing, not a second
consumption state machine. Competing writers conflict rather than overwrite an
unfinished range; reload and resolve the active attempt. Do not modify stream
cursors through the low-level generic watermark tool.

## Collection progress and missing history

For Discord, a new read without an unfinished batch performs at most one REST
page (100 messages) per selected conversation/known child. A catch-up scope over
100 conversations is rejected explicitly; narrow the scope rather than silently
ignoring excess children. Initial catch-up takes
only the latest 100 and appends an explicit baseline gap event; it does not promise
all earlier history. Subsequent pages use persisted **collection** progress, not
consumer watermarks, and dedupe overlap with retained Gateway message IDs.
`collection[].hasMore` reports a full REST page; `hasMore` also accounts for this
when creating the next consumer batch. Continue bounded read/ack rounds, not full
rescans. Permission-inspection/network failures must not advance collection
progress; unauthorized senders are skipped deliberately.

Connect/reconnect/disconnect/error notifications append gap events for known conversations. REST can
repair missed message creations only: offline edits/deletes, private/undiscovered
threads and content withheld by Message Content intent are not reconstructable.
Other platforms have no catch-up adapter here; they can consume **only actual
received inputs**. No full-history or exactly-once platform-delivery claim is made.

## Sending and retries

`channel_send {"connection":"BOT_ID","conversation":"CHANNEL_ID","content":"answer","replyTo":"MESSAGE_ID","idempotencyKey":"answer-MESSAGE_ID-v1"}`

Only Discord sending is implemented. Sending rechecks the existing Project Bot and
assignment independently of consumer progress. Mentions are suppressed; optional
reply references fail if missing. The host records `sending` **before** network I/O
and validates the Discord response. Reusing a key with identical content returns
its stored success. Reusing it with different content fails. Network ambiguity,
process death or result-record conflicts leave an uncertain record and **never
resend automatically**. Reconcile on Discord; do not manufacture a new key merely
to bypass this fence. This is not an exactly-once delivery guarantee.

## Storage bounds and recovery

Events live under Project `state/channel-stream/events.json`, with persisted
collection progress and send results beside it. The append log retains at most
10,000 events **and** approximately 16 MiB of serialized event state; oldest events
are evicted explicitly, retaining the local `floor`. Text per event is capped at
32,000 characters. Dedupe is limited to retained events. Adapters may supply a
reliable event/revision identity for non-adjacent replay dedupe (Discord edits use
a valid `edited_timestamp` when available). Without a revision, updates/deletions
compare only the latest message state, so A → B → A and delete/recreate cycles are
retained. Historical creation snapshots are marked separately: Gateway/history
overlap cannot resurrect a retained tombstone or generate a second creation after
an edit. This does not infer offline edits from a history snapshot. A global floor is
conservative: another conversation's eviction can invalidate an old cursor too.
Consumer state remains in the existing Project `.watermarks` journals; it is not
removed when an event expires. Send records are capped at 10,000 keys and then fail
closed pending operator archival. Watermark/collection metadata is not age-pruned;
operators must account for consumer/scope count and archive unused metadata while
writers are stopped. There is no automatic total-Project disk quota or redaction
service in this change.

Expired cursors and expired unfinished payloads **fail with an explicit retention
gap**, never silently skip and ack missing events. For intentional recovery, choose
a new consumer and pass `initialAfter` equal to an inspected directory floor (or
another explicitly chosen position below `next`). This initializes a new scope
only; it cannot reset existing progress. Record the lost range in your workflow.
Journal conflicts/locks fail closed; do not delete live lock directories. New
locks contain `owner.json` with the acquiring PID, hostname and acquisition time
for diagnosis. This is not a lease: neither age nor a PID alone authorizes stealing
a lock. Legacy locks can be empty, and a crash between acquisition and ownership
recording can also leave an empty lock. After a crash, stop all writers and
investigate before operator recovery. Preserve `events.json`; move an abandoned
lock aside only while writers are stopped. Restarting alone does not clear locks.

Transport-state gap recording is best-effort: a failure to read the directory or
append a gap logs `phase=stream-gap` and exposes an event-stream-degraded message
on the Bot status, without failing connection startup or cleanup. The warning
persists for that adapter instance because a later successful connection cannot
prove that the missing gap was recovered. Actual message collection and consumer
journals still fail closed; this isolation does not restore storage or guarantee
that messages were collected.

All verification used synthetic adapters/REST mocks. Live Discord API behavior,
Gateway reconnect/resume and deployed permission configurations are not validated
by these tests.

## Read-only Connection map and chat references

The Workflow canvas consumes the host's `bots.sinks` inspection projection. Each
Connection section branches to its observed top-level group/channel receivers;
these are durable message receivers, not model BOTs or Workflow definitions.
Threads retain their separate receipt histories but are browsed inside the parent
channel content page, not rendered as assignable receiver blocks. An empty
Connection remains selectable while waiting for messages; it does not invent a
group, conversation or BOT.

The section's **Open connection content** action opens its read-only receiver
directory in the existing inspector. Each receiver opens only an existing inbox
or the existing Discord parent-channel messages/posts/thread browser. Missing
Discord guild metadata is shown as unavailable rather than guessed. None of
these inspection actions creates a session, sends a message or executes a flow.

Selecting a section or receiver supplies the current chat's dynamic context with
`connection-sink` identity (`projectId`, `connectionId`, optional `receiverId`).
The host validates Project ownership and resolves the live receiver and paths;
client-authored paths, navigation and Workflow identities are rejected.
Canonical resources are `v:connections/<id>/overview.json`, `sink.json` and
`receivers/<encoded-receiver-id>.json`. `v:bots/authoring` describes BOT.md and
skill configuration and linking an existing BOT without duplicating its
bindings in a Workflow. `v:bots/connections` is compatibility inspection only.
References convey context, never tool, configuration or execution authority.
