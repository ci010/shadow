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

## Passive service channel sessions

An enabled **service** connection now records platform-delivered message-create
inputs into a separate, read-only `channel-inbox:` session before BOT trigger
selection, processors, attachment downloads or replies. This applies to QQ,
Feishu and supported Discord locations. It does not change personal connections,
owner pairing, connection sender allowlists, privileged platform intents, or what
the platform chooses to deliver. In particular, QQ messages not pushed by QQ
cannot be recorded. Discord still verifies live conversation visibility and
public-thread ancestry; private threads and unsupported conversation types remain
closed. Recording a sender does not make that sender an Agent participant.

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

1. `source` with a registered `folderId`, relative `directory`, and the referenced
   `channelSessionId`. It reads the source revision and resolves the target from
   host-recorded metadata, not message content or a model-supplied target object.
2. `assign` with those fields, `sourceRevision`, the active `expectedRevision` when
   applicable, a summary, and explicit `bindingJson` permissions. It is a **pure
   preparation** operation: it returns an exact config-file `edit` and
   `candidateRevision`; it does not write files, approve, or deploy.
3. Apply the returned `match`/`content` using the existing authorized `write` tool
   targeting the registered source Folder. This deliberately reuses ordinary
   file-write permissions and edit receipts instead of adding a second arbitrary
   source-file writer to Bot management. Reinspect on a stale match; do not blindly
   overwrite concurrent source edits.
4. Call `propose` with the same source, active `expectedRevision`, and
   `sourceRevision: candidateRevision`. The existing native exact-content owner
   decision remains mandatory. Cancellation leaves any ordinary source edits on
   disk but leaves the deployment unchanged. A source change after preparation
   cannot silently replace the candidate being proposed.

QQ/Feishu permission JSON must explicitly choose `enabled`, `trigger`, `allowFrom`
and `tools` (`allowFrom: []` permits nobody). Discord must explicitly choose its
participants and retains its normal tools/read-domain/thread/manage restrictions.
Target identity fields such as `platform`, `botInstanceId`, `target` and
`conversationId` are rejected in permission JSON; the referenced inbox supplies
them. A Discord thread reference identifies that exact public thread, not an
implicit grant over its parent or siblings. Live platform and deployment
validation still run before and after the owner's approval.

Setting the binding disabled through this same flow stops inference/output but
not passive receipt. Transferring a channel from BOT A to BOT B requires removing
A's binding from its source and approving that deployment, then approving B's
binding; the existing single-owner validation is not bypassed. All assignments
remain in `BOT.md`/its companion JSON, never session metadata or a UI binding DB.

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
retains its previous quiescent publication and owner-pairing contract.

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
`inheritThreads: true`. The default `scope: "conversation"` remains an exact
single-conversation target; an exact thread assignment requires
`inheritThreads: false` rather than silently promoting that child to a parent.
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
exact deployment approval are unchanged.

Subscription/configuration UI displays the **parent-channel rule once**, with its
inheritance semantics, not one row for every runtime thread. Each received post
still has a distinct passive inbox and execution/memory epoch underneath. This
presentation does not delete history or alter the ordinary conversation list.
Raw exact-review facts retain the real parent and permissions; they are not
hidden to make the UI smaller. Disabling/revoking the parent rule covers all its
children, and a new activation generation prevents old thread context or in-flight
output from crossing the authorization boundary.
