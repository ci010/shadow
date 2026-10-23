---
name: initiative
description: "Maintain optional shared goal notes, causal links and contextual decisions; an Initiative is a root-and-descendants view."
metadata:
  category: scheduling
---

# Shared work

Use `work` directly. `action: "context"` returns current notes and goal paths;
add `data: {includeSchema: true}` only when help is needed. `list` discovers
Project work; `tree` with a root key derives its Initiative view and progress.
There is no second Initiative goal, status store or writable SQL interface.
Old initiative tables and Markdown remain historical archives.

Execution and questions require no work item. Reuse or create a note when a
shared outcome benefits from a durable place to think. Start with a title and
definition.objective; acceptance and boundaries are optional, never permissions.
Set notes.kind to goal, approach, task or finding. A child needs parentKey and
notes.relation: supports for a chosen approach, requires for a real prerequisite,
or assumption for an unverified premise, each with a reason.
Do not turn an implementation preference into a user requirement.

Sessions hold conversations and execution context. `session` creates an
independent peer with a name and optional discovery description; requests go in
`initialMessage`. Creation alone transfers no work, file ownership or permissions. An optional
`work: {key}` links and assigns an unassigned note before kickoff.
One Session can handle several work items. Work survives a change of Session.

## Assignment and execution

Use `work assign` with key and current version. Only the note's coordinator or
the human changes its assignment. Idle, missing and stopped sessions never
release work automatically. Assignment changes neither stop ongoing operations
nor authorize a new executor to replay uncertain effects.

Only durable Project Sessions receive assignments, not temporary task/call IDs
or opaque remote A2A references. Their executions stay in `v:bg`. A task or call
may link its owner's note or inherit an unambiguous focus; this is context,
not an execution fence. Completion is a reported outcome, not human acceptance.

Parents maintain goal structure and causal links. Workers update their local
summary, plan, next step and artifact links when something meaningfully changes.
`work update` takes key, current version and only changed fields in data.
Optional notes.html is an isolated read-only exhibit, not executable UI.
`work select` changes focus, not permissions or filesystem isolation.
No adopt, checkpoint, policy, progress or settle protocol is required.

## Review and completion

Ordinary updates refresh the Project canvas without waking agents. For a material
changed premise, dependency, scope, decision or blocker, set notes.attention with
kind and summary. The coordinator reads the branch, checks the parent impact and
records `work review` with a conclusion. Do not duplicate this by messaging or
periodic status reports. An ancestor change leaves descendants explicitly not yet
reassessed; changing a note does not silently clear that state.

For a consequential choice, explain its effect on the user's outcome. Use
`ask` with originating workKey and ancestor decisionKey; the host attaches the
causal path. A large brief is optional. Consider retiring a false prerequisite,
not just asking how to fulfill it. The user's correction may change the ancestor
goal; record genuine current user instructions with requestQuote where needed.
An answer or note review never grants protected-action permission.
If the host marks a path node contextNeedsReview, compare it with the changed
ancestor before asking. A newly created question is not proof that the old
approach is still needed. Read the recorded assessment; retire or replace an
obsolete plan rather than asking the user how to satisfy it. This is not a gate
on investigation or already-authorized independent work.

Report completion with `work update`, data.status=done and notes.summary.
Children finishing does not prove root acceptance. Execution activity, reported
progress and user acceptance remain distinct. Work status does not roll back or
terminate processes; inspect real outcomes before retrying uncertain operations.
