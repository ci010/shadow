# Connections and BOT configuration

Project settings separates two responsibilities:

- **Connections** (`/projects/<projectId>/settings/connections`) manages platform
  selection, existing connection reuse, private credentials, connection status,
  connect/disconnect and personal-owner pairing. Multiple BOT packages may refer
  to one service connection; this does not merge or grant their permissions.
  Connection roles and pairing retain their existing restrictions. Discord's
  read-only saved access remains available on its service connection; group
  discovery remains platform-specific, not a universal Discord/QQ permission API.
- **Bots** (`/projects/<projectId>/settings/bots`) shows registered source locations,
  deployment revisions, previous revision metadata and pending exact permission
  facts. It is not a binding editor. The existing Bots route and retired Discord
  review warning remain available. The old `/settings/channels` shortcut now
  redirects to the Default Project's Connections page.

Both pages link to the current Project's chat. This is navigation, not an automatic
configuration request or deployment. Describe the BOT and registered source folder
in conversation. Behavior, tools and bindings remain authored in `BOT.md`,
`bot.json` and their companion files. Use the existing `bot_package` workflow to
review and explicitly approve the exact content and permissions before deployment.
Editing source files or connecting a platform does not publish a BOT revision.
See [directory BOTs](bots.md) for the source contract and deployment lifecycle.

## Private credentials during chat setup

The existing `bot_setup.open` tool can invite an authorized owner/administrator
**Web chat** to a scoped, expiring private connection card. Its fields submit to
the authenticated Project API, not the model or ordinary conversation history.
The card requires HTTPS or loopback transport. It is not an ordinary `ask` reply.
Do not request secrets in chat, ordinary questions, tool arguments, BOT source
files, or invite URLs. QQ and Discord conversations cannot open the private card;
continue credential entry in the owner's Web client instead. No channel owner
role is promoted to Web management authority by this flow.

The card's Done action only closes the invitation; it does not prove readiness or
approve deployment. Cancel does not undo already saved connection changes.
Refresh authoritative status after uncertain mutations rather than replaying them.
Switching from Connections to Bots unmounts credential inputs and clears unsaved
private drafts; returning requires a new connection selection. No running
connection, credential or BOT deployment is changed merely by navigating these
settings pages.

## Common channel receipt and passive inbox sessions

Enabled Project connections record platform-delivered message-create inputs into
separate, read-only `channel-inbox:` sessions before business sender admission,
BOT selection, trigger evaluation, processors, attachment downloads or replies.
This includes personal and unbound connections, not only assigned service BOTs.
QQ, Feishu, supported Discord locations and WeChat use the existing receipt path;
there is no collector BOT or additional message database. Existing owner pairing,
BOT participant/tool/output restrictions, privileged platform intents and what the
platform chooses to deliver remain execution/transport boundaries. QQ messages
not pushed by QQ cannot be recorded. Discord verifies the connected Bot's live
visibility and public-thread ancestry without inventing sender or participant
permission for a receipt; private threads and unsupported conversation types
remain closed. Recording a sender never makes that sender an Agent participant.

The host records versioned source metadata: Project, connection ID, platform,
conversation type and stable ID, plus verified parent/guild/DM information where
applicable. Names are display-only; sender identity is recorded on each message.
Projects, connections, groups, DMs and threads have separate identities. Feishu
platform topics use their verified root and outer group rather than merging their
messages into the group conversation. Source metadata survives both JSONL and
SQLite persistence; old non-inbox session records need no fabricated migration.
Old bounded discovery observations are not silently backfilled as trusted inbox
history.

These inboxes appear in the Web conversation inventory with a **passive inbox**
suffix. Their history is readable, but they have no send composer or Agent loop.
They are excluded from automatic learning. In an ordinary owner Web chat, type
`@` and choose the inbox by its name. The existing session-reference mechanism
inserts the correct Project/session reference without requiring hand-entered
platform IDs or another test message in the group. Referencing does not notify
the channel, read its entire history automatically, grant permissions, or deploy
anything.

Attachments retain bounded metadata references: native file/attachment keys,
MIME/size when provided, or a message-local attachment index and HTTPS origin.
Signed URLs, URL paths/query strings, local files and embedded image content are
not downloaded or included in the passive record. A reference does not promise
that the platform will still make an attachment available later. Rich text is
extracted without running processors or model-based transcription. Message edits,
deletions, missing platform events and earlier platform history are not backfilled
into this inbox implementation.

Unlike the old 20-message discovery preview, the real inbox is append-only durable
history and has no automatic seven-day expiry or model-driven compaction. Disk
usage grows with receipt; the owner must manage retained histories. Native message
IDs deduplicate per inbox across concurrent delivery and restart. Recording is not
an exactly-once inference guarantee: a crash after archival but before processing
leaves the message in the inbox and does not automatically retry it against a BOT.

## Assigning a referenced inbox in owner chat

The owner-only `bot_package` workflow now supports:

1. `create` can create a new Service BOT in a new registered local source
   directory and publish it with zero subscriptions. Existing directories are
   never overwritten. A failed publication leaves source for inspection/retry.
2. `source` resolves `sourceRevision` and a host-recorded `channelSessionId`.
   Target IDs never come from message text or policy JSON.
3. `link` updates and publishes the **existing BOT companion** with that source
   revision, active `expectedRevision` and explicit `bindingJson`. No bindings
   are copied to Connection or Workflow. `assign` remains a pure exact-edit
   preparation alternative for callers using the ordinary authorized write tool.
4. `propose` validates and publishes the exact `sourceRevision` under current
   authenticated owner authority. No separate native approval/activation ask is
   required. Stale source/base revisions fail rather than replacing newer edits;
   live scope validation and publication exclusion still run.

QQ/Feishu permission JSON explicitly chooses enabled/trigger/allowFrom/tools;
`allowFrom: []` permits nobody. Discord explicitly chooses participants and its
normal tool/read-domain/thread/manage restrictions. Target identity keys are
rejected from policy JSON. Assignment targets are top-level groups/channels,
not DMs or exact threads. A verified thread may only supply ancestry for an
explicit `scope:parent` rule with `inheritThreads:true`.

Disabling a binding stops inference/output, not common receipt. Transfer from
BOT A to B requires publishing A's removal before B's link; single-owner
validation remains enforced. All selectors stay in BOT.md/its companion, not
session metadata, Connection config or a UI database. See
[offline Connection policy migration](connection-migration.md) before deploying
the v3-only reader over existing v2 Project files.

Only new, nonduplicate arrivals eligible for the current assignment may reach a
BOT. Arrival-time assignment generations are checked through policy selection,
normalization and Session admission; observations cannot reopen ordinary handling
for an unassigned or duplicate arrival. Changing an observation policy while
capture awaits also cannot classify that older arrival under the new revision.
Each changed deployment has a durable activation generation. QQ/Feishu execution
starts a fresh physical context on generation changes (including reactivation or
transfer), while old execution segments remain explicitly readable. Discord keeps
its live epoch/thread/audience boundary, using the activation generation as part
of that epoch. No inbox or prior BOT history is automatically replayed to the new
BOT. Historical processing requires an explicit owner request and the existing
read/publication permissions; this workflow grants no history shortcut.

Service publication fences affected active contexts without waiting for a provider
to finish. Inference/tool snapshots and unforgeable in-process output leases
revalidate live authority; queued output is checked again by the real delivery
path and immediately before transport requests. Revocation cannot retract bytes
already accepted by a platform, nor guarantee cancellation of a remote provider,
but it prevents subsequent sends under the revoked assignment. Personal mode
retains its quiescent publication, ordinary Project role tools and owner-pairing
contract. Its responses and user questions also carry the original BOT activation
plus Workflow execution generation. Pause/re-enable or redeploy (even back to the
same source bytes) cannot revive queued output; adapters recheck immediately
before network sends, including SDK/token/upload/per-chat-queue waits. New input
retires a stale active Personal context rather than renewing that context's lease.
Legacy owner-DM session IDs participate in publication retirement too.

## Discord parent-channel subscriptions

Reuse the existing source schema instead of writing one binding per public post:
`target.kind: "channel"` selects the exact forum or ordinary text parent,
`inheritThreads: true` covers its permitted public descendants, and one
`subscriptions` entry selects that binding ID. No `"*"` ID, recursive wildcard,
new permission system or generated per-thread bindings are needed. For example,
with **synthetic IDs only**:

```json
{
  "allowedModules": [],
  "tools": [],
  "bindings": [{
    "platform": "discord",
    "id": "00000000-0000-4000-a000-000000000001",
    "botInstanceId": "registered-service-connection",
    "botUserId": "900",
    "target": { "kind": "channel", "guildId": "100", "channelId": "405" },
    "enabled": true,
    "trigger": "mention",
    "participants": { "everyone": false, "userIds": ["500"], "roleIds": [] },
    "tools": [],
    "readDomains": [],
    "inheritThreads": true,
    "manage": false
  }],
  "subscriptions": [{ "platform": "discord", "bindingId": "00000000-0000-4000-a000-000000000001" }]
}
```

Use trusted directory/source metadata for actual IDs, not user message text. In
owner chat, a reference to a received public thread can prepare the same rule with
`bot_package.assign` and explicit `scope: "parent"`. Its parent ID comes from the
host-verified thread metadata; permission JSON must explicitly say
`inheritThreads: true`. The default `scope: "conversation"` accepts a top-level group/channel only;
new exact thread assignments are rejected rather than promoted.
Existing child bindings are not silently promoted to
parent rules, and repeating parent preparation from a sibling thread reuses the
same parent binding rather than creating another per-thread entry.

This selects **newly delivered events after activation**, including new events in
already-existing public threads. It does not enumerate, scan, replay or merge old
posts. Forum parents are assignment containers, not direct message destinations.
For ordinary text parents, their own new messages follow that binding's policy
as well; their public threads still have independent contexts. A thread under
another parent, connection or Project does not match. Private threads remain
unsupported and platform visibility, participants, live send/history checks and
exact revision and live publication checks remain enforced; no extra approval is added.

Subscription/configuration UI displays the **parent-channel rule once**, with its
inheritance semantics, not one row for every runtime thread. Each received post
still has a distinct passive inbox and execution/memory epoch underneath. This
presentation does not delete history or alter the ordinary conversation list.
Raw exact-review facts retain the real parent and permissions; they are not
hidden to make the UI smaller. Disabling/revoking the parent rule covers all its
children, and a new activation generation prevents old thread context or in-flight
output from crossing the authorization boundary.
