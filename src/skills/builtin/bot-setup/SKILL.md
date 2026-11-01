---
name: bot-setup
description: Set up and manage current Project personal/service Bot connections in Web Chat, with private credential entry, WeChat QR login and explicit human owner pairing.
metadata:
  core: true
---

# Bot connections in Chat

Only the current Project's authenticated Web administrator can use this workflow.
Channel owners (including paired personal Bots) cannot administer Bots from a channel.
Discover and load `bot_setup` using tool search/import, then invoke it.

1. Start with the platform and the user's goal. Use `status` to find reusable connections in the current Project before creating anything. Ask whether a new connection is personal (verified owner only) or service (explicit BOT permissions); never infer a permission role silently. Reusing a connection does not change its role, owner or permissions.
2. If a new connection is needed, use `create` with explicit purpose/platform and a reasonable displayName (disconnected), or let the human create it in the private card. Do not create a duplicate just to reopen setup. WeChat is personal only. There is no cross-Project credential reuse in this flow.
3. Use `open` for the compact trusted private connection card. Tell the human which platform and existing connection to select; the invitation itself has no target Bot ID. The card contains only connection selection, required App ID/secret/token fields, connection status and owner pairing. Saved values stay hidden; blank fields preserve them. Password fields submit directly to the authenticated Project HTTP API; neither the tool nor model receives them. Never request credentials in ordinary chat, `ask`, tool arguments, shell/files, io forms or browser automation.
4. Handle non-secret requirements in conversation, not a larger wizard. Explain platform installation, sandbox/event requirements or naming as needed. BOT behavior, Agent/tools/models, guild/channel/participant mappings and grants belong in the registered BOT source folder, not connection forms. Use the authorized BOT file/deployment workflow, preserving explicit access controls and exact human deployment confirmation. Do not assume connecting, a Discord server invitation, or editing a source file grants access or publishes a revision. Do not invent an interface for connection options not exposed by the current tools; report that boundary when relevant. Never direct a user back to the retired Discord configuration forms.
5. WeChat: connect the personal Bot in the card, generate its QR, scan with the user's WeChat, and check login. QR is ephemeral UI state, not tool output. Owner pairing remains required after login.
6. Personal Bots: generate an owner challenge in the card, send it from the user's own platform private chat, then verify. The human must review the platform user ID and explicitly confirm the binding. The tool cannot confirm ownership; never claim confirmation on the human's behalf. Service Bots do not use this personal-owner pairing step.
7. The human uses Done or Cancel to close the card. `open` returns only closed/cancelled/expired; closed does NOT prove setup success, and Cancel does not undo already saved connection changes. Use `status` to verify connection and ownerVerified before reporting personal readiness. Service readiness additionally requires a deployed BOT with the intended exact binding permissions, not just a connection.

`connection` toggles an already configured Bot. `status` returns redacted status only.
Reopen the private card for required credential changes. Invitations expire after ten
minutes and stop with cancellation/shutdown. They are session/Project scoped. Switching
chats/Projects unmounts private inputs; the old invitation can be cancelled or expires.
After an uncertain save, refresh status before retrying; do not blindly create or replay
mutations. Do not read configuration files containing existing secrets.
