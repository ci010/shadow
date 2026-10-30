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

## Find or create a peer

1. Search `v:sessions` for an existing relevant conversation. Read its brief and
   necessary history before assuming its current scope.
2. Reuse it when its role and active work fit the request. Discovery metadata and
   creator provenance are not evidence of ownership or availability.
3. If a new peer is justified, read `v:tools/session` and invoke the dynamic
   `session` tool through `invoke_tool` with `action: "create"`.

Choose a meaningful title and short discovery description. Put the assignment in
`initialMessage`: objective, relevant sources, scope, constraints, expected result
and stop condition. Do not use metadata as instructions.

Use a registered Folder when file access is needed; omit it for discussion-only
work. Discover resources through `v:project/folders`, never by interpreting a
remote display path on Main. Remote sessions cannot register Main-local folders.

Optional `model` and `effort` settings follow the live tool contract. Omission
preserves the peer's agent/Project defaults, not the creator's current overrides.

## Creation and retry

When retrying an uncertain creation, reuse the same `requestId` and arguments.
Creation retries do not replay an accepted kickoff. Inspect the returned session
and delivery status before sending an initial assignment again.

Creation establishes an independent conversation, not structural parenthood,
completion routing or ownership transfer. Admission is not task completion.

## Work with the peer

Use `message` to send an assignment or correction with enough context to act.
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

A peer does not require Work bookkeeping. If multiple owners, dependencies or
recovery needs justify a shared goal map, read `v:skills/work-coordination`.
Optional `work:{key}` on creation binds an existing unassigned note coordinated
by the creator before kickoff; use the live tool contract for requirements.

For your own metadata and completion, prefer `v:session/self.json`.
