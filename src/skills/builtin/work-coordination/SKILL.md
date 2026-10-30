---
name: work-coordination
description: "Coordinate multiple owners, dependencies and durable recovery with shared Work notes."
metadata:
  category: tools
---

# Work coordination

Use Work when multiple owners, meaningful dependencies or durable recovery make
an optional shared notebook useful. Ordinary requests and individual delegated
tasks do not require a Work record.

Work describes goals, responsibility and evidence. It does not grant permission,
start or stop executions, or replace tool-enforced task review.

## Build the smallest useful goal map

Start with the user outcome and observable acceptance criteria. Create branches
only for independently owned outcomes, consequential dependencies or assumptions.
Explain why each branch supports or constrains the parent. Do not create a node
for every tool call or mirror the execution tree into the goal map.

Keep rationale and shared context in Work. Give workers a local objective, scope,
constraints, evidence requirements and stop condition rather than making them
reconstruct their assignment from the whole tree. Do not turn implementation
preferences into user requirements.

Use the live Work schema for operations, required fields and version checks.

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

Keep routine progress silent. Use attention for a consequential change to a
premise, dependency, scope or decision that requires the coordinator to act.
Do not report the same finding through both Work attention and a duplicate
message unless the recipient needs additional actionable context.

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
