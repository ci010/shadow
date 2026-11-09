---
name: work-notes
description: "Maintain optional shared Work notes, causal links and contextual decisions."
metadata:
  category: scheduling
---

# Shared work

Read `v:works/overview`, `v:works/index` (20 receipts/page; follow next),
`v:works/context` (associated keys), then the encoded key path returned by the
index for current definition, notes and ancestor path. Append /definition,
/notes or /path for focused reads. `v:works/schema` provides field help.
Use search at `v:works` for bounded discovery; heed incomplete-search warnings.

Writes are dynamic tools. Read `v:tools/work_create`, `v:tools/work_update`,
`v:tools/work_assign`, `v:tools/work_review` or
`v:tools/work_link`; source and callable names coincide. Invoke, for example:
`invoke_tool({name:"work_update",args:{key:"work:...",version:2,notes:{summary:"Result"},status:"done"}})`.
There is no action/data wrapper or base work tool.

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

Use `work_assign` with key and current version. Only the note's coordinator or
the human changes its assignment. Idle, missing and stopped sessions never
release work automatically. Assignment changes neither stop ongoing operations
nor authorize a new executor to replay uncertain effects.

Only durable Project Sessions receive assignments, not temporary task/call IDs
or opaque remote A2A references. Their executions stay in `v:bg`. A task or call
may link its owner's note or inherit an unambiguous focus; this is context,
not an execution fence. Completion is a reported outcome, not human acceptance.

Parents maintain goal structure and causal links. Workers update their local
summary, plan, next step and artifact links when something meaningfully changes.
`work_update` takes key, current version and only changed top-level fields.
Optional notes.html is an isolated read-only exhibit, not executable UI.
Current Work is inferred only from the unique unfinished assignment, never from management or links. No explicit Work selection tool exists.
No adopt, checkpoint, policy, progress or settle protocol is required.

## Review and completion

Summary/plan/next/artifact and in_progress updates refresh the Project canvas without waking agents. Entering done or blocked notifies the Work manager (not the session parent). A blocked transition and attention in the same update share one notification. Pending notices merge per recipient at the next safe input boundary and obsolete assignment/status/attention episodes are discarded before consumption. Missing coordinators leave the issue visible in Work; do not invent a reviewer or human approval. For a material
changed premise, dependency, scope, decision or blocker, set notes.attention with
kind and summary; add awaitingResponse=true when the executor is waiting for a
response. Omitted legacy attention means a nonwaiting report. The coordinator
reads the branch, checks the parent impact and records `work_review` with a
conclusion. Optional disposition is record or return_to_assignee: waiting
attention defaults to return, otherwise to record. Return is a handoff to read
latest Work, not an unblock, assignment change, permission or acknowledgement
requirement. A record-only review need not wake the executor. Do not duplicate
this by messaging or periodic status reports. An ancestor change leaves descendants explicitly not yet
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

Report completion with `work_update`, status=done and notes.summary.
Children finishing does not prove root acceptance. Execution activity, reported
progress and user acceptance remain distinct. Work status does not roll back or
terminate processes; inspect real outcomes before retrying uncertain operations.
