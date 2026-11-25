---
name: work-coordination
description: "Coordinate multiple owners, dependencies and durable recovery with shared Work notes."
metadata:
  category: tools
---

# Work coordination

Read/list/search via `v:works/overview` and its paginated index/key paths.
Mutations use discoverable `v:tools/work_create`, `work_update`, `work_assign`,
`work_review`, `work_link`, `work_note_create` through invoke_tool, with typed
top-level fields (no action/data wrapper).

Use Work when multiple owners, meaningful dependencies or durable recovery make
an optional shared notebook useful. It holds current shared facts, not a chat
transcript. Ordinary requests and individual delegated tasks do not require a
Work record.

## Choose the smallest interaction

- To learn what another session has done, read its relevant `v:sessions` history,
  tool results and existing Work. Do not send a status inquiry when observation
  suffices; report unavailable or stale evidence rather than pinging or polling.
- Use message for free-form questions, discussion or one-off coordination that
  actually needs the other session's participation.
- When the exchange creates a durable shared commitment, dependency, deliverable
  or blocker, reuse relevant Work before creating a record. Maintain agreed facts
  there within each actor's authority; keep discussion in message. Duration and
  message count alone do not justify Work. Do not require Work before first contact.

Work describes goals, responsibility and evidence. It does not grant permission,
start or stop executions, or replace tool-enforced task review.

## Build the smallest useful goal map

Start with the user outcome and observable acceptance criteria in the Markdown definition. Include relevant boundaries and genuine source evidence, without templated headings or inferred permission. Create branches
only for independently owned outcomes, consequential dependencies or assumptions.
Explain why each branch supports or constrains the parent. Do not create a node
for every tool call or mirror the execution tree into the goal map.

Keep rationale and shared context in Work. Give workers a local objective, scope,
constraints, evidence requirements and stop condition rather than making them
reconstruct their assignment from the whole tree. Do not turn implementation
preferences into user requirements.

Create with `work_create` (`title`, `definition`); include known prerequisite
Work keys in `dependencies` on creation. Update with `work_update` (`key`,
current `version` from `v:works`, and changed fields only). A supplied
`dependencies` list replaces the old one; omit it to leave it unchanged.

## Responsibility and execution

A Work assignment and an execution are separate facts. Creating a note does not
start a worker; changing its assignee does not stop an existing operation.

Before delegating an existing note, confirm that responsibility and context fit
the intended owner. For durable peers, use the session tool's Work binding when
appropriate; do not treat creator provenance or folder selection as ownership.

Workers maintain their branch. Coordinators maintain the parent outcome,
dependencies and cross-branch consequences.

## Update meaningful changes

Record results, evidence, artifacts, blockers and next steps when they materially
change. Do not log every action or send routine acknowledgement loops.

Keep routine progress and comments silent. For a material coordination issue,
post a Work comment with `notifyManager: true` if the current manager needs a
notice. Use `ask` when a consequential choice needs an answer. Do not duplicate
a routed notice with a message.

Separate development progress from a consumable handoff: a commit existing does
not mean its interface is stable or ready for integration. Record a fixed target,
evidence and remaining limitations when it is ready; explicitly record withdrawal
or replacement when it affects another owner's work. Do not mark the whole Work
done merely to obtain a notification; use an opt-in comment when appropriate.

## State, matching and action notification

These are runtime layers, not three manual agent steps. Write a meaningful state
change once; the host selects applicable responsibility/context transitions and
admits targeted notifications. Entering done/blocked can notify the manager, and
ancestor changes can prompt descendant reassessment. Manager replies notify the
original comment author, including after reassignment. Comments do not unblock
Work or acknowledge a stale ancestor basis.
Unchanged updates should not create fresh wake-ups. Historical association through
`work_link` or a dependency edge is not a general peer subscription; do not assume
every interested session will be notified. If a necessary recipient is outside
supported routing, use one actionable message referencing the Work rather than
copying its full state. Do not send both paths to the same recipient for the same
fact unless immediate intervention or additional discussion is needed.

On notification, read latest Work before acting; a notice may be stale. No
acknowledgement, read receipt message or "I updated Work" follow-up is required.
Work does not grant authorization or enforce a file/Git lock. A recorded operation
window still requires execution-layer checks and protection of other writers.

## Reassess the parent

When a branch changes, determine whether it affects the parent's acceptance
criteria or plan, another owner's assumptions or scope, a dependency or prior
decision, or the user's expected outcome.

Use Work review to record that reassessment where applicable. Changed ancestors
remain not yet reassessed; retire obsolete premises rather than repeating them.
A reported branch completion does not establish parent success or human acceptance.

Ask consequential questions at the affected goal (`workKey`), identifying an
ancestor (`decisionKey`) when the choice changes that ancestor's outcome or
approach. Notes and rendered HTML are not approval.

## Resume and close

On recovery, read the current goal, ancestor context, dependencies and relevant
execution evidence. Reconcile active operations before issuing replacement work.

Report completion against the original outcome with evidence, limitations and
remaining risks. Do not substitute a completed notebook for a completed request.
