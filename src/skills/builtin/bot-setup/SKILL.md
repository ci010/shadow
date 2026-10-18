---
name: bot-setup
description: Set up and manage current Project personal/service Bots entirely in Web Chat, with private credential entry, WeChat QR login and explicit human owner pairing.
metadata:
  core: true
---

# Bot setup in Chat

Only the current Project's authenticated Web administrator can use this workflow.
Channel owners (including paired personal Bots) cannot administer Bots from a channel.
Discover and load `bot_setup` using tool search/import, then invoke it.

1. Ask whether this is a personal assistant or restricted service Bot and which platform/name. WeChat is personal only.
2. Use `create` with purpose/platform/displayName (disconnected). Never request credentials in ordinary chat or a tool argument.
3. Use `open` to show the trusted inline Bot setup card in this chat. Tell the human to enter App ID and secret/token in that card, configure and connect there. Password fields submit directly to the authenticated Project HTTP API; neither the tool nor model receives them. Do not use shell, files, io socket forms, browser automation or ask input for credentials. Never ask the human to paste a secret into chat.
4. WeChat: in the card connect the personal Bot, generate its QR, scan with the user's WeChat, and check login. QR is ephemeral UI state, not tool output.
5. Personal Bots: generate owner challenge in the card, send it from the user's own platform private chat, then verify. The human must review the platform user ID and explicitly confirm the binding. The tool cannot confirm ownership. Never claim the user has confirmed on their behalf.
6. The human closes the card when finished, or cancels. `open` returns only closed/cancelled/expired; closed does NOT prove setup success. Use `status` to verify connection and ownerVerified before reporting readiness. Owner pairing is required even after WeChat login.
7. Service Bots remain restricted by existing published Agent bindings/skills/tools/resources. Connection alone is not service readiness. The inline connection card does not implement Agent publication; disclose that boundary rather than claim a full service publication flow or bypass it.

`connection` toggles an already configured Bot. `status` returns redacted status only. Reopen the private card for changing parameters. Invitations expire after ten minutes, stop with cancellation/shutdown, and are session/Project scoped. Switching chats/Projects unmounts private inputs; an invitation in the old chat can be cancelled or expires. Do not read config files or existing secrets.
