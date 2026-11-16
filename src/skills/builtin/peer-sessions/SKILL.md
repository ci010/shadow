---
name: peer-sessions
description: "Discover, create and reuse durable peer conversations for ongoing collaboration."
metadata:
  category: tools
---

# Durable peer collaboration

Use this when an independent conversation should retain a reusable role, context
or ongoing responsibility. For a bounded one-off assignment, prefer task/call
without creating a durable peer. This guidance grants no capabilities; the live
execution contract and tool schemas remain authoritative.

## Observe before contacting

When asked to inspect another session's work, use `read`/`search` on its brief,
relevant history and exact tool results at `v:sessions/<sessionId>`, plus existing
Work. Start with the overview and narrow to relevant evidence; do not replay the
whole history by default. Observation does not require the peer to respond.
Do not send "how is it going?", request acknowledgement, or repeatedly poll to
make a report look current. State the last observable result and any uncertainty.
Contact the peer only when the user requests interaction or necessary information
or action cannot be obtained from the available records. A user request to look
at a session is not by itself a request to contact it.

## Find or create a peer

1. Search `v:sessions` for an existing relevant conversation. Read its brief and
   necessary history before assuming its current scope.
2. Reuse it when its role and active work fit the request. Discovery metadata and
   creator provenance are not evidence of ownership or availability.
3. If a new peer is justified, read `v:tools/session` and invoke the dynamic
   `session` tool through `invoke_tool` with `action: "create"`.

Choose a stable overarching `topic` and optional current-step `focus`. Put the assignment in
`initialMessage`: objective, relevant sources, scope, constraints, expected result
and stop condition. Do not use metadata as instructions.

Use a registered Folder when file access is needed; omit it for discussion-only
work. Discover resources through `v:project/workspaces`, never by interpreting a
remote display path on Main. To register a new directory, invoke `session` with `action: "register_folder"`,
`nodeId` from the runtime device inventory, and the directory `path` on that device.
Child paths stay opaque on Main and use the same picker selection and Project
ownership checks as the UI. The device must be online and support folder selection.
Omitting `nodeId` retains Main-local registration only from local sessions; remote
sessions must explicitly select a device. Remote folder descriptions are not yet supported.

Optional `model` and `effort` settings follow the live tool contract. Omission
preserves the peer's agent/Project defaults, not the creator's current overrides.

## Creation and retry

When retrying an uncertain creation, reuse the same `requestId` and arguments.
Creation retries do not replay an accepted kickoff. Inspect the returned session
and delivery status before sending an initial assignment again.

Creation establishes an independent conversation, not structural parenthood,
completion routing or ownership transfer. Admission is not task completion.

## Work with the peer

Use `message` for free-form questions, discussion and one-off coordination that
needs the peer's participation, or an authorized assignment/correction with enough
context to act. It is not a progress-query API. Send the actionable delta and
reference unchanged scope/evidence rather than repeating the whole agreement.
Do not send routine acknowledgements or request them merely to confirm admission.
Distinguish a correction to active work from a request for subsequent work;
use the live delivery options accordingly. Silent delivery is FYI, not an
unblocker or a correction requiring action.

Do not assume the peer applied a message merely because it was admitted.
A change of plan does not stop its current execution.

For handoff, identify the outcome and remaining scope, completed evidence and
artifacts, active operations, partial side effects and unresolved blockers.
Wait for completion or confirmed cancellation before taking over its files,
then reread them. A message does not cancel work.

## When coordination becomes durable

A peer does not require Work bookkeeping. When an exchange develops a durable
shared commitment, deliverable dependency, blocker or recovery need, prefer Work
for those shared facts; reuse relevant Work before creating a record. The need to
maintain shared facts, not elapsed time or message count, is the trigger. Keep
open-ended discussion in message and record its agreed outcome in Work within
each writer's authority. Read `v:skills/work-coordination` for this path. Do not
mirror the conversation into notes or send "I updated Work" after a notification.
Optional `work:{key}` on creation binds an existing unassigned note coordinated
by the creator before kickoff; use the live tool contract for requirements.

For your own metadata and completion, prefer `v:sessions/self.json` (`topic`, `focus`, `completed`). Set topic after understanding the first request; change only focus during subtask/debug phases. Change topic only for a real overall topic shift. Empty focus displays the topic.
