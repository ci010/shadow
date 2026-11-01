---
name: bot-setup
description: Set up and manage current Project personal/service Bot connections in Web Chat, with private credential entry, WeChat QR login and explicit human owner pairing.
metadata:
  core: true
---

# Bot connections in Chat

Only the current Project's authenticated Web administrator can use this workflow.
Channel owners (including paired personal Bots) cannot administer Bots from a channel.
Read `v:bots/overview` and `v:bots/connections/index` first; expand a connection
with `v:bots/connections/<id>`. Use read/search for state, and discover/load
`bot_setup` only when an operation is needed. These reads do not start connections,
open a private card, activate BOT modules or publish anything.

1. Start with the platform and the user's goal. Use `v:bots/connections/index` to find reusable connections in the current Project before creating anything. Ask whether a new connection is personal (verified owner only) or service (explicit BOT permissions); never infer a permission role silently. Reusing a connection does not change its role, owner or permissions.
2. If a new connection is needed, use `create` with explicit purpose/platform and a reasonable displayName (disconnected), or let the human create it in the private card. Do not create a duplicate just to reopen setup. WeChat is personal only. There is no cross-Project credential reuse in this flow.
3. Use `open` for the compact trusted private connection card. Tell the human which platform and existing connection to select; the invitation itself has no target Bot ID. The card contains only connection selection, required App ID/secret/token fields, connection status and owner pairing. Saved values stay hidden; blank fields preserve them. Password fields submit directly to the authenticated Project HTTP API; neither the tool nor model receives them. Never request credentials in ordinary chat, `ask`, tool arguments, shell/files, io forms or browser automation.
4. Handle non-secret requirements in conversation, not a larger wizard. Explain platform installation, sandbox/event requirements or naming as needed. BOT behavior, Agent/tools/models, guild/channel/participant mappings and grants belong in the registered BOT source folder, not connection forms. Use the authorized BOT file/deployment workflow, preserving explicit access controls and exact human deployment confirmation. Do not assume connecting, a Discord server invitation, or editing a source file grants access or publishes a revision. Do not invent an interface for connection options not exposed by the current tools; report that boundary when relevant. Never direct a user back to the retired Discord configuration forms.
5. WeChat: connect the personal Bot in the card, generate its QR, scan with the user's WeChat, and check login. QR is ephemeral UI state, not tool output. Owner pairing remains required after login.
6. Personal Bots: generate an owner challenge in the card, send it from the user's own platform private chat, then verify. The human must review the platform user ID and explicitly confirm the binding. The tool cannot confirm ownership; never claim confirmation on the human's behalf. Service Bots do not use this personal-owner pairing step.
7. The human uses Done or Cancel to close the card. `open` returns only closed/cancelled/expired; closed does NOT prove setup success, and Cancel does not undo already saved connection changes. Read `v:bots/connections/<id>` to verify enabled, health and ownerVerified before reporting personal readiness. Service readiness additionally requires a deployed BOT with the intended exact binding permissions, not just a connection.

`connection` toggles an already configured Bot. The old `bot_setup` / `bot_package`
`status` actions remain for compatibility, not the default discovery workflow.
Read `v:bots/deployments/index`, then `v:bots/deployments/<id>/status` and
`v:bots/deployments/<id>/listeners` for active revision/source, strict validation,
binding enablement, subscription selection and the router's projected listeners.
Follow `next` paths for bounded pages; narrow search to an object for all its pages.
Configured bindings, subscribed/enabled listeners, transport health and successful
processing are different facts. `lazy-validated` is a valid on-demand definition,
not a running service or a successful delivery; processing success is unknown.
Invalid/quarantined and integrity-failed deployments remain visible with safe error
categories, not unchecked source. No status read repairs or relaxes validation.
Operations remain `bot_setup`, `bot_package` and `credential_request` with their
existing private-entry and exact-content owner confirmations. The VFS has the same
owner durable Web management boundary; it is not available to Service/channel,
child, script or remote-workdir callers just because they can read/search.
Reopen the private card for required credential changes. Invitations expire after ten
minutes and stop with cancellation/shutdown. They are session/Project scoped. Switching
chats/Projects unmounts private inputs; the old invitation can be cancelled or expires.
After an uncertain save, refresh status before retrying; do not blindly create or replay
mutations. Do not read configuration files containing existing secrets.
