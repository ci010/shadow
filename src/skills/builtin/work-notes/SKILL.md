---
name: work-notes
description: "Maintain optional shared Work notes, parent/dependency links and contextual decisions."
metadata:
  category: scheduling
---

# Shared work

Read `v:works/overview`, `v:works/index` (20 receipts/page; follow next),
`v:works/context` (associated keys), then the encoded key path returned by the
index for current definition, notes and ancestor path. Append /definition,
/summary or /path for focused reads. Append /comments for the latest comments; follow next or read an exact comment path. `v:works/schema` provides field help.
Use search at `v:works` for bounded discovery; heed incomplete-search warnings.

Writes are dynamic tools. Read `v:tools/work_create`, `v:tools/work_update`,
`v:tools/work_assign`, `v:tools/work_review`, `v:tools/work_link` or
`v:tools/work_note_create`; source and callable names coincide. Invoke, for example:
`invoke_tool({name:"work_update",args:{key:"work:...",version:2,summary:"Result",status:"done"}})`.
There is no action/data wrapper or base work tool.

Execution and questions require no work item. Reuse or create a note when a
shared outcome benefits from a durable place to think. Start with a title and
one free-Markdown definition. Describe the outcome, how to tell it is met, its
boundaries and any known source evidence in natural prose; no fixed headings
are required. Cite only real sources, and state what remains uncertain. Definition
text is not verified proof or permission. Keep shared progress in summary and transient planning in the session.
Set kind to goal, approach, task or finding. Use parentKey to place Work
under a goal and dependencies for real prerequisites. Explain any relevant
assumptions in the definition.
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

Parents maintain goal structure and dependencies. Workers update their local
Markdown summary and artifact links when something meaningfully changes.
`work_update` takes key, current version and only changed top-level fields.
Current Work is inferred only from the unique unfinished assignment, never from management or links. No explicit Work selection tool exists.
No adopt, checkpoint, policy, progress or settle protocol is required.

## Review and completion

Summary/artifact and in_progress updates do not wake agents. Entering done or
blocked can notify the Work manager, not the session parent. Use
`work_note_create` for shared discussion that does not change Work progress:
`invoke_tool({name:"work_note_create",args:{workKey:"work:...",body:"A premise changed.",notifyManager:true}})`.
The current assignee's original comment is silent unless `notifyManager: true`
is supplied. Only the current manager can reply using `replyTo` with the ID of an
original on the same Work. A reply notifies that author, not the current assignee.
No eligible recipient or a self-target leaves the comment saved without a notice.
`queued` is not proof of delivery, reading, acceptance or approval. Comments are
shared with the Project's Work readers. Neither posting nor replying unblocks or
asks for a required answer; use `ask` for consequential decisions.

Use `work_review` with the current version and a conclusion only when an
ancestor goal has changed and the branch needs reassessment. Local progress
updates and comments do not clear stale ancestry. Reassessment doesn't wake an
executor with a reply or grant permission. Don't duplicate a routed notice with
a message.

For a consequential choice, explain its effect on the user's outcome. Use
`ask` with originating workKey and ancestor decisionKey; the host attaches the
causal path. A large brief is optional. Consider retiring a false prerequisite,
not just asking how to fulfill it. The user's correction may change the ancestor
goal. Only the human can make a semantic revision to human-authored Work; ask
them to edit it directly instead of treating a quote as permission to rewrite it.
An answer or note review never grants protected-action permission.
If the host marks a path node contextNeedsReview, compare it with the changed
ancestor before asking. A newly created question is not proof that the old
approach is still needed. Read the recorded assessment; retire or replace an
obsolete plan rather than asking the user how to satisfy it. This is not a gate
on investigation or already-authorized independent work.

Report completion with `work_update`, status=done and a nonempty summary.
Children finishing does not prove root acceptance. Execution activity, reported
progress and user acceptance remain distinct. Work status does not roll back or
terminate processes; inspect real outcomes before retrying uncertain operations.
