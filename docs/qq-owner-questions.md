# Answer pending questions from a personal QQ Bot

Prerequisites: an enabled personal QQ Bot in the same Project, paired through Web owner confirmation. Send commands in the verified owner's paired direct conversation (not a group).

- `/shadow-requests` lists eligible pending questions with their exact `request_id`, original session, question, decision options, deadline, and available Work context/brief.
- `/shadow-reply <request_id> <answer>` answers that exact pending question. For decisions, copy one offered option **exactly** (not its number, not a paraphrase). For ordinary input, the remainder is information only, never permission. There is no implicit default choice or interpretation of ordinary chat as approval.
- Results are delivered to the original waiting session; they do not create a QQ agent turn or move ownership of the request. QQ receives a confirmation. If confirmation delivery fails after recording, inspect the original session; do not assume the request remains unanswered.

## Authority boundary

This explicitly maps a Project's Web owner access to that Project's verified personal QQ owner under the current single-owner Project model. It does **not** introduce a general cross-platform principal or allow arbitrary sessions to approve other sessions. Multi-owner Projects require an explicit identity mapping before extending this feature.

Eligible requests are live `user`-recipient root requests from Web/virtual sessions in the same Project (or the same paired QQ conversation if it has an eligible request). Internal agent-created roots, parent/caller requests, tasks/calls, automations and channel-bound delegated sessions are excluded. QQ `ask` availability is unchanged. Other Bots/channels and other Projects are not accepted. The bot's agent cannot call this operation through `reply` or through a new tool: only authenticated raw owner-message ingress handles commands. Existing agent parent/remote-owner reply boundaries are unchanged.

Pending-request managers retain original lineage, deadline, Work-context freshness, cancellation and single-settlement checks. Stale, cancelled, expired, invalidated and already-answered IDs cannot be used to approve a new request. A decision must match an offered option exactly; custom decision text and cross-session cancellation are intentionally not supported by these commands. Native callbacks keep their existing same-session behavior.
