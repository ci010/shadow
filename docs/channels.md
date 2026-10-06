# Messaging channels

Project settings → **Bots** configures QQ, Feishu, and Discord instances.
Each Project may have several bots per platform, with separate credentials,
sender policies, and runtime status. Providers and device pairing remain
App-wide. A saved bot configuration is not proof of platform delivery or
verified connectivity; the backend can be locally ready while a bot is
offline. Legacy WeChat/iLink adapters are not started by Project runtimes.

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
An explicitly authorized Discord management channel gets a bounded version of
the same tool, restricted to its Bot and existing tool/domain ceiling. Its
proposal can also be confirmed with `/shadow-approve <draft-id> <hash>` by the
same currently authorized human. Ordinary chat text and model tool calls are
never that approval. QQ/Feishu managed authoring remains a separate workflow.

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

## QQ GROUP and C2C passive replies

Ordinary GROUP/C2C replies send the final summary, rather than every tool
result or intermediate model update. Questions and final errors are separate
messages. Guild channels and DMs use their existing progressive delivery.

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
