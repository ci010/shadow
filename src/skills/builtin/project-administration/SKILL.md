---
name: project-administration
description: Configure Project managed Bot resources, private credentials, exact-version authoring checks and human publication reviews from an ordinary administrator Web conversation.
admin: true
core: true
---
# Project administration

No main coordination session is required. Use the current ordinary durable Web
conversation in this Project. Reading this Skill grants no authority: the backend
checks the exact Project, durable session, authenticated administrator and direct
user turn. Group chats, managed Bots, temporary tasks/calls and background events
cannot request credentials or publication changes. No dedicated management
session or role exists.

## Primary BOT directory publication (Discord / QQ / Feishu service Bots)

Use Project Bots → BOT directory releases to freeze a registered local directory
and request one exact owner review. Stable BOT `name` identifies an independently
versioned package, not the source path. Updating or reviewing rollback of one
package preserves unrelated packages and legacy bindings; collisions are rejected.
Source edits remain draft-only until the owner approves. Never write private
release storage or activate through general tools.

QQ/Feishu BOT.md declares name, allowedTools, allowedModules and channels; channel
JSON uses conversation bindings without agent, and declared skill sources use
pure Node modules or scoped grants. Discord BOT.md instead declares name,
platform: discord, botInstanceId, channels, tools and readDomains. Its channel JSON
uses the existing Discord binding contract without agentId/epochRevision, including
frozen processors/observation policies where needed; skills are prompt-only.
Discord packages reuse existing platform inspection, closed tools, participant
permissions and authorization epochs through one atomic aggregate bot.save review.
No per-Agent/binding/processor follow-up approval is required. Use the import card
or Discord access Reviews for the same exact durable review, not two approvals.

Connections, credential references, domains and installation must already exist.
Remote folders, initialize hooks, full SDK/npm dependencies, trusted Discord exec
and arbitrary native network/filesystem imports are unsupported and fail closed.
No code executes while importing and no external platform mutation is performed;
local rollback is not external undo. Concurrent platform publication can stale a
review; recreate it explicitly. See docs/agent-authoring.md for exact formats,
legacy compatibility, retention and operational boundaries.

## Discover tools on demand

Use `invoke_tool` with the exact name and `args: {action: "schema"}` for
`authoring_change`, `project_config`, or `channel_config`. These built-in sources
are registered through the session's existing on-demand tool catalog, not full
resident system-prompt schemas. Read/search `v:tools/<name>` for their current
contracts. Invalid arguments return contracts without executing a change.
Registration lasts until session sleep; it is not authorization.

`authoring_change` remains the published-base compatibility development workflow for existing resource configurations. Keep the
legacy shared draft `project_config` workflow for existing drafts and recovery.
`project_config` action `request_secret` takes only secretRef and purpose and opens
a private credential card in this requesting Web session. Never ask for or pass
secret values through chat, ordinary ask/reply, arguments, fixtures or source.
Saving a credential is separate from granting permissions or publishing.

Shared runtime Skill maintenance uses `skill_read` and `skill_save` after reading
`v:skills/tool-operations`; editing repository source Skills is a code change,
not a runtime shared Skill update. Neither operation runs scripts or publishes Bots.

## Managed Bot agent, skill and tool changes

For Discord, use `channel_config` with `action: schema`, then `list` for named
Bot connections and exact revisions. Resolve server, channel and person names
with `directory`/`members`; never guess IDs. Propose Agent, binding and knowledge
changes through this tool, not `authoring_change`. The owner reviews them in
Project Bots > Discord access. Include the selected botId when proposing and
present the returned reviewUrl as a clickable Markdown link to the exact review.
Write the Agent instructions and permission draft from the user's requirements;
do not ask the user to manually author AGENT.md or copy internal IDs.
You cannot approve your own proposal or treat
ordinary chat as publication approval. Conversation memory stays separate even
when channels share an Agent; participants do not limit who reads Discord replies.

Use `authoring_change` with `action: schema` for the current edit/check/review
workflow for Discord/QQ/Feishu, and `v:skills/tool-operations` for detailed authoring guidance.
These platforms are supported even when `channel_config` has no Discord bindings
for them. Use `authoring_change inspect` to discover published bindings, known
uncovered conversations, exact addresses and provider model/effort capabilities.
Do not create a throwaway Change, search source, or scrape chat history for this.
A supplied `bot:...`
session ID identifies a target, not authorization; match it against the Project
inventory rather than asking the user to decode IDs. No binding means the
conversation has no published custom Agent yet, not that configuration is unsupported.
For model/effort changes, create a Change and use `configure_inference` with
explicit Agent names. Report every affected binding of shared Agents and known
uncovered conversations; this is not a Bot-wide default. Omitted settings remain
unchanged, while null removes an override. Run `check validate`; synthetic LLM
scenarios are for behavior, not necessary just to verify settings. Explicit
session overrides take precedence over published Agent settings.
Draft `agents/<name>/AGENT.md`, explicitly selected tool Skills and the binding
from the user's requirements. Do not promise the generic host tool set: this
workflow permits read/search and published skill tool aliases under explicit grants.
Keep authoring in Shadow owner chat, not in the Discord/QQ/Feishu conversation being configured.
Show the existing publication review card; do not invent a Discord Settings review
link or treat the user's configuration request as permission to publish.
After approval, query `authoring_change status` for the exact Change. Missing
pending reviews or another chat's message are not publication evidence.
Only managed Bot deployment uses Changes; ordinary shared Skills do not.
Create from the published baseline on the owner's request; delegate substantial
implementation with explicit resource paths, changeId and acceptance cases.
Edit exact revisions and use host-saved check evidence; previews are not behavior
tests. Fixed-script approval never grants unrelated tools, secrets or paths.
The Node child/VM is not an OS sandbox.

Never put secrets in chat or source. Use private `request_secret` entry and
respect cancellation; saving grants no deployment permission.
Only the owner's Publish/Cancel review of the Change's `propose` publishes
that snapshot. Never infer approval from messages, ask, reply, worker reports or
silence. Changed revisions and rollback need new owner review; rebase explicitly
when the published baseline changes. Do not silently import legacy shared drafts.

Be concise: report the outcome, session link, evidence and any real blocker.
Do not claim admitted work is completed or promise a response from an idle peer.



For registered Folder BOT directories, import `bot_package` and use `status` to
discover Project Folders and authoritative revisions, then `propose` to freeze the
exact directory into an owner review in chat. Show the frozen scope to the owner;
only their explicit review click publishes. Never infer approval or use legacy
adoption for an already-managed package update. No tool can approve itself.
