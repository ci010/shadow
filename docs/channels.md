# Messaging channels

Project settings → **Bots** configures QQ, Feishu, and Discord instances.
Each Project may have several bots per platform, with separate credentials,
sender policies, and runtime status. Providers and device pairing remain
App-wide. A saved bot configuration is not proof of platform delivery or
verified connectivity; the backend can be locally ready while a bot is
offline. Legacy WeChat/iLink adapters are not started by Project runtimes.

QQ and Discord conversations do not expose the `ask` tool, including private
messages and Bot chats opened inside Shadow. Agents ask clarification questions
in ordinary replies and end the turn; the next user message continues the
conversation. Explicit Agent tool allowlists, old tool calls and dynamic
`invoke_tool` calls cannot re-enable `ask` in these channels. Web, Feishu and
internal parent/child decision flows retain their existing behavior.
This does not approve protected operations: use their dedicated owner review
in Shadow. Existing pending requests are not automatically answered or cancelled.

For QQ/Feishu and other legacy trust-guidance paths, **Trusted group or channel IDs** declare that everyone able to read replies
in that conversation is trusted, not just the senders allowed to message the
bot. Unknown audiences receive restrained shared-conversation guidance.
Listing a Discord server or parent channel does not implicitly trust its
threads. Trust does not grant administrator or tool permissions. Changing a
policy refreshes future reusable-conversation requests, but cannot retract
an in-flight reply.

## Discord Agents and channel access

Discord uses an explicit, default-deny policy in the Project runtime. Creating
or connecting a Bot does **not** admit an unassigned channel or DM. Legacy
`adminChats`, `trustedChats`, direct-message defaults and Discord administrator
roles do not grant Shadow ownership, tools or internal memory access.
The Bot-wide `allowFrom` remains an additional sender ceiling.

Keep **Bot connection**, **Agent definition** and **channel assignment** separate.
One Discord Bot can use Support in one channel and a different Agent, Markdown,
model and tool set in another. Reusing an Agent never shares conversation memory
automatically. Multiple Bot identities are still supported; a separate
management Bot is useful for distinctly privileged/private work, but separate
credentials alone do not isolate backend data.

### Configure in Shadow or owner chat

In **Project settings > Bots**, select a connected Discord Bot and open
**Discord access**. The Channels, Agents, Knowledge and Review views share the
same backend revision and approval service.

1. In Agents, create or edit an `AGENT.md` snapshot, model settings, approved
   instruction-only skills, execution mode, tool ceiling and readable knowledge
   domains. Publish the reviewed snapshot before assigning it.
2. In Channels, synchronize the named server/channel/role directory. Search
   names, choose one or several channels, the Agent, users/roles, mention/reply
   versus every-message triggering, and narrower tools/knowledge. Resolve
   repeated names using their server, parent and stable identity.
3. Review and explicitly acknowledge the exact change. Saving a form or asking
   an Agent to configure something does not apply it. Drafts expire after
   fifteen minutes; a changed revision or changed live permissions requires
   fresh review.

The Project **Coordinator** exposes `channel_config`: `schema` documents inputs,
`list` returns named Bot connections (including unassigned ones), and
`directory`/`members` discover resources before a message has been sent there.
It can inspect current Agent files and catalog resources and propose changes,
but cannot approve them. Approve owner-chat drafts in **Discord access > Review**.
Proposals return a `reviewUrl` for the Agent to include as a clickable chat link.
The link opens Project Settings, the selected Discord Bot and the exact review;
it contains no approval hash and never checks the acknowledgment or applies a
change. Agent/knowledge drafts without a selected Bot open the Project review
through its first available Discord connection. Missing Bots or reviews produce
an explicit unavailable notice rather than selecting a different draft.
An explicitly authorized Discord management channel gets a bounded version of
the same tool, restricted to its Bot and existing tool/domain ceiling. Its
proposal can also be confirmed with `/shadow-approve <draft-id> <hash>` by the
same currently authorized human. Ordinary chat text and model tool calls are
never that approval. QQ/Feishu managed authoring remains a separate workflow.

### QQ/Feishu configuration from Shadow owner chat

QQ and Feishu also support owner-chat authoring of Agent Markdown, selected tools
and per-conversation bindings. This is the existing `authoring_change` workflow,
not Discord's `channel_config propose`. Owner `channel_config list` includes
`otherPlatformBots` and the appropriate authoring route so an absent Discord
assignment is not mistaken for unsupported QQ configuration.

Use `authoring_change inspect` for read-only discovery without creating a Change:
published Agent settings, the provider model/effort catalog, and the Project's
Bot and known conversation inventory, including uncovered conversations. Match the target
session to its exact Bot/platform/conversation address. Edit the Agent resource,
selected skill tools and binding, run the Change checks, then propose the exact
revision. Tools are read/search and published skill tool aliases with explicit
module/grant ceilings, not the unrestricted host tool catalog.
The owner must approve the publication card in Shadow; this workflow does not
currently use Discord's Settings Review page. A model cannot approve publication.
Do not expose management tools to the target QQ group or treat a QQ group role
as Shadow ownership. Unbound QQ conversations retain their existing behavior
until an owner-approved binding is published.

For inference-only edits, create a Change and use `configure_inference` with an
explicit Agent name and `settings` (`model`, `reasoningEffort`, `temperature`,
`maxTokens`, `thinking`). Omitted fields stay unchanged; null removes an override.
This edits frontmatter without changing instructions, tools or bindings. Every
binding sharing the Agent is affected; **there are no Bot-wide model defaults**.
Known unbound conversations are explicitly listed and remain unchanged.
Run `check validate` before proposing; known unsupported model/effort combinations
are rejected, while missing effort metadata means unknown support.
Ordinary channel turns and synthetic scenarios share inference setting assembly:
explicit session overrides win over published Agent settings, then runtime defaults.
Agent defaults are not copied into QQ session state, so removing them restores
inheritance. Query `status` by Change ID after approval to compare the exact
revision against the published snapshot and pending/waiting/error review state.
An absent request alone never means publication succeeded.
Check/status responses include compact assertions and errors; full scenario
transcripts remain available through the saved `run` ID rather than chat scraping.

**Participants control invocation, not reply visibility.** Anyone who can read
the Discord channel can read the Bot's replies, even if they cannot invoke it.
Use private channels for confidential work. Privileged Agents cannot be assigned
to everyone; selected users/roles still need appropriate platform access.

### Memory, tools and learning

Restricted Discord execution checks memory authorization before prompt assembly,
read/search, inference, tool use, compaction, learning and output. This protects
titles, paths, counts and source metadata as well as document bodies.

| Domain | Access |
| --- | --- |
| Project-private / uncatalogued old memory | Excluded from external Discord contexts, including SOUL, identity, working sets, Project events and keyword indexes |
| Conversation | One Bot/conversation/current authorization epoch; notes, summaries, decisions and learned skills stay here |
| Shared knowledge | Only explicitly granted bindings; an approved publication is a fixed copy, not a live alias to private data |
| Agent-private | Explicitly created and granted; the same Agent name does not confer access |

Knowledge publication presents the target audience, exact content and sources
for human review. A subsequent source edit does not change that published copy.
Revoking a resource/domain blocks future access and dependent work, but cannot
recall content already sent to a provider or Discord. Derived resources retain
the restrictions of observed source versions; summarizing does not declassify.
Old files remain private by exclusion, not by a speculative automatic import
of every historical resource type.

Restricted tools come from a closed registry: scoped memory read/search/save,
approved Discord history/message reads, conversation-local learned skills,
optional same-scope blocking leaf calls, and optional bounded management.
Raw filesystem/VFS, MCP, dynamic tool loading and general session messaging are
not inherited. **Trusted host execution is not an OS sandbox**: opting into
`exec` can access host files and credentials beyond application memory controls.
Use it only for genuinely trusted private management work.

Scheduled reflection, encapsulation and Soul reflection use the existing
learning scheduler and session loop, but separate protected journals, source
versions, cursors, retries and records per conversation epoch. Workers can only
read their exact batch and stage domain-local records. Encapsulation creates
instruction-only skills in that Conversation domain; Soul reflection creates
private `soul-draft` resources, never global SOUL updates. Verified completed
receipts gate cursor advancement. **Knowledge > Conversation learning**
shows progress/paused reasons; `/learn <pipeline>` in an owner chat retries
paused work. See [domain learning](tools-and-automations.md#discord-conversation-learning).

### Threads, DMs and changing access

An explicit thread assignment or disable wins over parent inheritance.
Inheritance copies configuration, not parent history or memory. Supported
locations are guild text/announcement channels, public/announcement threads and
explicitly assigned DMs. DMs select one recipient, do not inherit guild roles
and are never administrators by default. Search people within a mutual server;
Discord cannot discover arbitrary users globally by name, so an outside
recipient requires their exact user ID.

Each approved assignment save, even an unchanged one via **Start fresh context**,
advances authorization context. The logical session ID and old history remain,
but the new physical segment receives no old transcript, summary or provider
conversation context. Reassignment, reductions, revocation and connection
generation changes stop affected in-flight work and fence queued output.
Checks run again before individual send/edit requests; messages already sent
cannot be undone by changing policy.

Discord API permissions are freshly checked for the Bot and sender, including
role/channel overwrites. Optional **Request Guild Members intent** enables the guild
member gateway intent; enable the corresponding privileged intent in Discord's
Developer Portal too. REST verification remains required without that intent.
Message Content intent can limit returned text. Name caches never authorize
stale permissions. Attachment downloads accept supported official HTTPS
attachment URLs without sending Bot authorization to the CDN.

Main backend startup initializes a process-wide proxy for native Node `fetch`
and Undici requests; Discord Gateway WebSocket uses the same dispatcher.
`HTTP_PROXY`/`HTTPS_PROXY` and `NO_PROXY` take precedence over Windows static
system proxy settings. Loopback traffic always stays direct, and a failed proxy
does not silently fall back to direct access. Restart the backend after changing
proxy settings (including the Electron backend, not just the renderer page).
PAC, SOCKS and credential-bearing proxy URLs are currently unsupported and
produce an explicit startup error. This is not a proxy guarantee for SDKs using
their own HTTP agents or for arbitrary subprocesses.

Discord startup distinguishes an unreachable API from HTTP 401 (rejected Bot
token) and HTTP 403 (denied gateway request), without exposing request headers
or raw credential-bearing network errors.

### Recovery and current limits

Review shows conflicts, audit history and interrupted approved changes.
Agent-file application is conditional: later manual edits are not overwritten
by recovery. Load the current `AGENT.md`, compare and create a fresh review.
Reapplying historical configuration is also a new review. Legacy settings are
shown as migration candidates; no administrative permission is copied
automatically. Both JSONL and SQLite preserve authorization metadata and old
history.

The directory reports completeness and unsupported types. It does not claim
private/archived-thread enumeration or forum/media parent assignments. Bot
installation, platform-side permissions and privileged intents cannot be
completed solely by Shadow. Storage corruption or concurrent protected-file
conflicts may stop Project startup or return an unavailable error; not every
failure has an automatic UI repair. Conflicting prepared learning commits need
operator reconciliation rather than blind replay.

Local synthetic-provider, persistence, Project-host and rendered-UI checks cover
these paths. **Dedicated live Discord server acceptance remains outstanding**:
two channels, real membership changes, threads, disconnect/reconnect and
revocation have not been certified against a real Bot by this change. This
does not extend the new isolation guarantees to QQ or Feishu.

## QQ group reception

Shadow handles both ordinary group messages (`GROUP_MESSAGE_CREATE`) and
mentions (`GROUP_AT_MESSAGE_CREATE`) by default, using the existing
`GROUP_AND_C2C_EVENT` intent (`1 << 25`). No additional Shadow switch is needed.
The Bot must also have QQ's "receive all messages" capability enabled on the
platform; Shadow cannot enable that permission or receive messages QQ does not
deliver. See the official [full group-message event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html).

In **Project settings > Bots > Configure > Trigger model on**, choose
**Mentions and direct messages** (the default) or **All messages**. This saves
the Bot's `triggerMode` as `mention` or `all`; existing configurations without
the field default to `mention` too.

Reception and triggering are separate. In `mention` mode, ordinary group
messages are saved to session history without a model call, automatic
compaction, or reply. The next mention-triggered turn can use that history as
context. In `all` mode, every admitted group message enters the normal Agent
turn/reply flow. Direct messages always trigger regardless of this setting.
The adapter recognizes the dedicated mention event and mentions of this Bot
in the full-message event's structured `mentions` list, using QQ's boolean
`is_you: true` marker or a matching Bot ID. Full-message mode can use a
group-scoped Bot OpenID different from the gateway identity; the self-mention
marker still triggers a turn. Mentions of other users do not.
The sender `allowFrom` policy still applies, and the same message ID
delivered through both event types is processed only once per group.
This does not enable full-message reception for QQ guild channels. Successful
delivery for one configured Bot does not establish platform access for every Bot.

## QQ incoming messages and files

QQ sticker images remain in stored chat history for UI previews, but are excluded
from model requests, including later turns that reuse silent history and cached
quotes. The model gets a short omission label and any accompanying text, not the
sticker's image bytes. Classification uses the observed
`<faceType=6,faceId="...",ext="...">` marker within each attachment-bearing message
element, not GIF format, filename or dimensions. Normal pictures/screenshots and
unmarked GIFs remain visible to the model. When markers cannot be matched
unambiguously to images in the same element, images are retained rather than
discarding a possibly meaningful picture. Clearly marked all-sticker historical
QQ messages are filtered at inference time without rewriting their history;
ambiguous old quoted/forwarded payloads are not reclassified. This does not block
an explicitly authorized image-reading tool from opening an attachment.

GROUP and C2C events share the same normalized input path. Shadow handles ordinary
text, ARK cards (`message_type: 3`), parallel elements (`101`), forwarded records
(`102`) and quoted content (`103`), including recursively nested combinations.
Card-only messages are retained as structured text. Card fields are display data:
their links/previews are not fetched or executed automatically. Card traversal
is bounded to 6 levels and 200 visited values; incomplete content is identified.
Credential-named card fields and `message_scene.ext` authentication tokens are
excluded from prompts, logs and the reference cache.

Sender identity uses the existing first `<sender ... />` content block.
Mentions, scene source, message type, platform roles and attachment properties
travel as typed display metadata and become escaped `platform-*` attributes
in that block, not JSON appended to the user's text. Known QQ mention IDs are
rendered as `@Display name` in the body; unresolved IDs remain unchanged rather
than being guessed. The normal chat display already hides the metadata envelope.
Existing stored messages are not rewritten by this change.
The original sender ID still controls admission; QQ `owner`/`admin`
metadata never grants Shadow owner privileges, including inside forwarded items.
Cross-application union identifiers are not needed for this routing and are not
forwarded.

Shadow downloads `attachments` included in QQ GROUP, C2C, guild mention and
guild direct-message events, including messages containing only files.
Documents and archives are not restricted to images: they enter the normal
session attachment pipeline as local file references for the Agent's available
tools, rather than being sent to the model as images or executed automatically.

Files are saved in the owning Bot conversation's `uploads` directory. Names keep
a sanitized, length-bounded original filename with a unique prefix, so multiple
same-name files cannot overwrite one another. When the filename is missing,
Shadow uses the URL path and known attachment/HTTP MIME types. Failed or
malformed attachments produce an explicit unavailable notice in the conversation;
successful files in the same message are retained. Blocked senders cannot cause
downloads. The normal group mention/all-message trigger setting still applies.

For voice attachments, Shadow prefers `voice_wav_url`, explicitly falls back to
the original URL if conversion download fails, and retains `asr_refer_text` as
platform-provided, potentially inaccurate transcription. Attachment size,
dimensions and type are labeled as platform-declared metadata, not authorization
or a substitute for inspecting the file.

This is reception of attachments **pushed by QQ**, not synchronization or browsing
of the QQ group file library. Shadow cannot receive files for which the platform
does not deliver an attachment URL, nor recover expired download links. Automated
fixtures cover these receive paths; actual platform delivery of each file type
still needs verification with a configured Bot.

For receive diagnostics, backend logs emit `[qq] Gateway dispatch` with only the
event name, message type, text length, attachment count and nested element count.
Additional flags report the presence of cards, scene metadata, message/reference
indices and scene authentication, without exposing their values. A
`[qq] Reference lookup` reports cache availability; `[qq] Attachment reception`
reports received/saved/failed counts when
attachments were present. They do not contain message text, sender IDs, filenames,
download URLs or credentials. Sending a file and then a separate mention requires
the original file event to reach Shadow; the mention alone does not attach the
previous file. Shadow's model-trigger setting does not enable QQ-side delivery.

QQ also documents **quoted messages** (`message_type: 103`): attachments can be
inside `msg_elements[].attachments`, rather than at the top level. Shadow reads
these referenced attachments and marks quoted text as context, without treating
the original author's metadata as authorization. This allows quoting/replying to
an existing file and mentioning the Bot **when QQ includes the referenced file's
download URL**. `msg_idx` is used for deduplication when present. `ref_msg_idx`
and element indices can also resolve previously accepted messages in a bounded
in-memory cache, reusing their already-downloaded attachments. Inline reference
content takes precedence. Cache keys are scoped to the Bot instance and chat;
unaccepted inputs are never cached. Each Bot retains at most 200 entries, with
cached text capped at 32,000 characters and truncation marked explicitly.
The cache clears on stop/replacement/restart; it is not a second persistent
session-history store. Normalized content and local media references still use
the normal JSONL/SQLite session pipeline. Missing/evicted references produce an
unavailable notice, not a guessed message, and Shadow does not fetch remote
history using opaque indices or scene tokens.
Malformed/missing reference data and traversal limits (8 levels, 100 elements)
are reported explicitly. Text and binary JSON gateway frames are decoded;
unreadable frames produce a sanitized `Gateway frame rejected` warning.

The test Bot's initial 2026-10-07 ordinary-file-then-separate-mention attempt delivered
only mention events without attachments or nested elements. That is not proof
that QQ never supports group files, nor that a particular permission is disabled.
The [official message types](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)
and [group mention schema](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
describe file and quote support, but do not establish access for every Bot.
Do not equate the platform's "enable notifications" setting with full-message
reception. C2C file reception is user-confirmed. At 01:51 UTC+8 on 2026-10-07,
the test Bot also received an ordinary group-file event, downloaded its attachment,
and persisted the file reference in the group history. Subsequent group messages
used the full-message event rather than the dedicated mention event; this exposed
the need to recognize `mentions[].is_you` for model triggering.
Rich-message, quoted-file and binary frame fixtures cover the adapter, provider
input and both session stores; live quoted-file delivery is still unverified.

## QQ GROUP notifications and passive replies

Ordinary GROUP/C2C replies send the final summary, rather than every tool
result or intermediate model update. Questions and final errors are separate
messages. Guild channels and DMs use their existing progressive delivery.

GROUP responses without an originating QQ message ID (for example, an
asynchronous result handed back from another session) use proactive sending:
the request omits `msg_id` and its paired `msg_seq`. Enable the QQ client's
**allow the robot to speak proactively in the group** setting. QQ enforces its
own proactive permissions and rate limits; enabling the setting does not
guarantee delivery. Text, Markdown and uploaded media use the same routing.
C2C sending remains passive-only.

An explicitly supplied passive source never falls back to proactive sending,
including after expiry, quota exhaustion, platform rejection or an ambiguous
network result. Shadow does not borrow an unrelated recent group message or
automatically retry proactive sends. QQ delivery failures retain their sanitized
kind, outcome and available HTTP/platform codes in backend logs and the
`channel.delivery.failed` event, rather than being labeled as a disconnected Bot.
Saved assistant output is not a platform delivery receipt.

For each accepted incoming message ID, Shadow conservatively allows up to
**5 GROUP** or **4 C2C** passive replies within **5 minutes** of the
gateway timestamp. These are local, documentation-derived safeguards, **not
live-runtime-verified platform guarantees**. Text, Markdown, decisions, and
attachments share the same allowance. The separate C2C streaming endpoint is
not implemented.

Replies are serialized and their `msg_seq` values reserved before I/O.
Unknown, expired, exhausted, or unaccepted sources fail delivery visibly.
A question answered later does not extend the originating message's window;
the conversation can complete in Shadow while QQ delivery fails. Attempts
are not refunded after a platform rejection or unknown send outcome, and
Shadow will not blindly retry a source that may have partly delivered.
Tracking is in memory and clears when the bot stops or is replaced. Missing,
skewed, or pre-restart timestamps cannot mint a new reply window.

See the platform's [GROUP endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
and [C2C endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
for current upstream rules. The C2C overview and `msg_id` description have
historically stated different windows; do not infer a longer safe deadline
from the overview alone.
