---
name: initiative
description: "Organize shared work as work items with assignments, dependencies and acceptance; an Initiative is a root-and-descendants view."
metadata:
  category: scheduling
---

# Shared work

Use `work` directly. `action: "context"` returns current records and schemas;
`list` discovers Project work; `tree` with a root key shows its Initiative view.
There is no second Initiative goal, status store or writable SQL interface.
Old initiative tables and Markdown remain historical archives.

Ordinary discussion and read-only research need no work item. For execution,
reuse appropriate assigned work or create an item with an outcome, observable
acceptance, existing boundaries and evidence. A small clear request needs no
extra interview. Supply `parentKey` only when this is part of another outcome.
Child acceptance describes the child's deliverable, not the whole parent's goal.

Sessions hold conversations and execution context. `session` creates an
independent peer with a name and optional discovery description; requests go in
`initialMessage`. Creation transfers no work, file ownership or permissions.
One Session can handle several work items. Work survives a change of Session.

## Assignment and execution

Use `work assign` with the exact current sequence. Only explicitly unassigned
work is claimable; only its manager delegates it to another Session. A current
assignee releases explicitly with a reason and, after execution, a version-bound
checkpoint with no in-flight or unknown effects. Idle, missing and stopped
sessions never release work automatically.

Only durable Project Sessions receive assignments, not temporary task/call IDs
or opaque remote A2A references. Their executions stay in `v:bg`. A task or call
inherits its owner's work fence; completion is evidence, not item acceptance.

Use `work select` and `adopt` for the item and definition revision you will
execute. Generate subsequent actions in a new inference round. Selection does
not isolate files. Changed definitions or assignments invalidate old execution.
Record progress through the same work item; never maintain a second todo file.

## Review and completion

Implementation steps are your choices, not user requirements. For a material
goal or authorization change, `work propose` records an exact proposal. Use
`ask(kind="decision", proposal={key,id}, brief=...)` for human review, or point to
that same proposal in the Work panel. One approval applies the saved version.
Neither timeout, a parent agent's reply nor custom text grants approval.

After reviewing acceptance evidence, `work progress` records a result and marks
the item done. An agent must cite genuine evidence; a root also requires its
dependencies and children to be settled. Completed children do not prove root
acceptance automatically. Cancelling an execution does not cancel the work;
changing work status does not roll back or terminate external processes.
