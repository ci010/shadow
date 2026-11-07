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
