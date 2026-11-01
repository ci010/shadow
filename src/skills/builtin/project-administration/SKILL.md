---
name: project-administration
description: Configure directory BOTs, direct binding permissions and private credentials from an authenticated owner Web conversation.
admin: true
core: true
---
# Project administration

Use the current ordinary durable Web conversation in this Project. Reading this
Skill grants no authority: the backend checks the exact Project, durable local
session, authenticated administrator and direct user turn. Group chats, managed
Bots, temporary tasks/calls and background events cannot request credentials or
BOT deployment. No dedicated management session or role exists.

## Directory BOT deployment (Discord / QQ / Feishu)

Use `bot_package` status/propose through `invoke_tool` in an authenticated owner
Web conversation. Status returns deployments, registered Folders, connections and
known conversations. Do not guess IDs. Propose freezes one registered local
directory and requests one native Deploy/Cancel confirmation. Stable BOT `id`
identifies an independently versioned package, not the source path. Read status
for the exact expectedRevision before updates. Source edits do not activate it.
Never write private deployment storage or activate through general tools.

All three platforms use `BOT.md` with header `{id, config: bot.json}` and the
prompt body, plus data-only `bot.json` and declared tool modules. Permissions
are declared directly in each binding (tools, folders/domains, grants and
participants as applicable), subject to BOT-level ceilings. Do not introduce
`capabilityProfiles` or infer grants from old bindings. Service model/effort
settings belong to `bot.json`; use provider capabilities to choose supported
values, not session overrides. Web and verified Personal input stay ordinary
sessions. Internal session events/cron are not external BOT subscriptions.

Development source and the deployment copy are independent. Edit the registered
source and propose again; do not reconstruct source from deployment history.
Each proposal deploys one BOT only, not an atomic release across BOTs. Legacy
resource editing, Change/check/scenario/run/profile publication and source
recovery are retired, not alternate BOT configuration paths. Old resource and
review data are left untouched and are not loaded, migrated or authorized.

Connections, credential references, domains and installation must already exist.
Remote folders, initialize hooks, full SDK/npm dependencies, trusted Discord exec
and arbitrary native network/filesystem imports fail closed. No code executes
while importing. Deployment is not an external platform mutation or external
undo. See docs/bots.md for exact formats and operational boundaries.

## Private credentials

Discover `credential_request` in `v:tools` and invoke it with only `secretRef`
and `purpose`. It opens private entry in the requesting owner Web conversation.
Never request/pass secret values through chat, ordinary ask/reply, arguments,
fixtures or source. The receipt contains only saved/cancelled status and a
reference. Saving is separate from granting permissions or deploying a BOT;
respect cancellation. Existing credential and grant-ledger storage locations
remain compatible; never edit them directly or import local credentials.

## Other owner operations

Use `channel_config` schema/list/directory/members to inspect Discord connections,
resolve names, and manage its existing domain/knowledge operations. In directory
mode it cannot publish Agents, bindings or processors: edit the BOT source and
use `bot_package`. Authorized channel managers remain limited to their existing
ceiling; platform administrator status is not Shadow ownership. Participant
restrictions control invocation, not who can read channel replies. Scoped
conversation memory and learning never become global by sharing a BOT.

Shared runtime Skill maintenance uses `skill_read` and `skill_save` after reading
`v:skills/tool-operations`. Editing repository source Skills is a code change,
not a runtime shared Skill update. Neither operation executes scripts or deploys
Bots. `agent_tool_test` remains a bounded synthetic script test helper, not a
publication or live-access tool. Read current on-demand contracts before use;
registration and invalid-argument schema discovery are not authorization.
