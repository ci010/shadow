# Local task review workflow

Local `subagent` task creation declares its review policy. This workflow is separate from execution status and never changes Work state or ownership.

## API

`subagent({mode:"task", task, description, title?, review?: {mode?:"parent"|"agent", agent_type?:string, max_rounds?:number, criteria?:string}})`

- Omission selects parent review. The parent receives `subagent-review-requested`, not a success completion, and supplies a structured verdict.
- `mode:"agent"` creates a fresh independent review session for each submission; `agent_type` defaults to `verify`. No pre-created reviewer or parent lifecycle orchestration is needed.
- `max_rounds` defaults to 3, accepts integers 1–10, and counts submissions including the first. At the last round, a request for more changes fails explicitly.
- The tool advertises the nested `review` fields as structured JSON Schema. Unknown fields are rejected before creating a child; use `review.max_rounds`, not the internal camelCase `maxRounds`. Validation errors include the `review` path and correction hints for common naming mistakes; invalid fields are never silently ignored.
- Reviewers receive original task text, acceptance criteria, fixed submission revision, exact artifact reference and submitted final content. File references are references, not immutable filesystem snapshots; reviewers must verify artifacts as appropriate.
- `agent_type` is not accepted in parent mode. Review policies are rejected for calls and remote A2A tasks.

`task({action:"review", sessionId:workerId, revision, outcome:"pass"|"changes_requested"|"blocked", content?:string})`

Only the designated parent or independently created review session can submit a verdict. The worker cannot review itself. Revision must exactly match the current submission; duplicate and stale verdicts are rejected. `changes_requested` needs actionable instructions; `blocked` needs a reason. Natural-language reviewer finals, including the word PASS, never imply acceptance.

`task({action:"read",sessionId})` inspects the durable record. Manual `set_reviewer/request_changes/run/close/cancel` actions are no longer exposed by the tool. The manager retains legacy lifecycle methods for compatibility tests and old records; managed workflows reject their mutation path.

## Retrying a failed worker

Read `task({action:"read",sessionId})`, inspect the failed execution and existing
artifacts, then call `task({action:"retry",sessionId,expectedVersion:record.version})`.
Only the original creator may retry a settled failed local task whose lifecycle
is still `working`. Calls, A2A, cancellation, successful submissions, reviewer
failures and blocked/budget decisions are not restarted by this command. A stale
version or an active execution/report is rejected, including concurrent retries.

Retry admits a new continuation turn in the **same session**, retaining history,
assignment, role, inference settings, Work binding and review policy. It does not
replay a failed HTTP request or tool batch. The continuation explicitly requires
checking recorded results and artifacts before repeating actions with uncertain
side effects; this is guidance, not an exactly-once guarantee for external tools.
Failed worker workflow terminal/delivery flags are reset; submission revision and
review budget are preserved. Subsequent completion must still pass normal review.
Failure event IDs include the run ID so a later failed attempt is not suppressed
as a duplicate of the previous failure. Restart alone never starts a retry.

## Delivery and continuation

- Worker completion becomes an in-review submission. Agent mode does not send intermediate submissions or reviewer finals as parent success completions.
- Changes automatically admit a new run into the same worker session, preserving its history and logical identity. Each reviewer run has a separate identity and only current-reviewer authority.
- PASS closes the task and emits one `subagent-complete` containing the accepted worker submission, not the reviewer prose.
- Worker/reviewer failure, missing structured verdict, blocked verdict or exhausted review rounds emits `subagent-failed`. Execution/provider iteration budgets remain enforced by the existing session loop.
- Parent-review never automatically accepts or closes. It resumes only when the parent explicitly supplies a structured verdict; returning changes requires no separate run command.

## Persistence and recovery

Workflow policy, original assignment, submissions, reviewer identity, verdict and terminal/delivery flags are persisted inside `SessionState.task` in both JSONL and SQLite. Existing records lacking `workflow` retain legacy explicit lifecycle semantics. No database schema migration is required because both stores already persist and validate task records.

Restart does not automatically replay worker or reviewer write operations. An interrupted managed agent workflow escalates as failed. A settled parent-review submission stays open for an explicit verdict. Terminal delivery is marked before event publication, favoring at-most-once success notification over replay: a crash between the marker and event publication can lose that notification; there is no durable cross-store event outbox or exactly-once transport claim.

Calls retain their bounded blocking leaf semantics. Automation retains its specialized persistence and settlement semantics. A2A remains legacy one-shot and does not pretend to support local review workflows. `report_to` routes final accepted delivery and exceptional failure only and grants no review authority. Parent-review requests always go to the creator, even when final delivery is redirected elsewhere.

## Verification

Focused JSONL/SQLite fixtures in `src/sessions/execution-modes_test.ts` cover independently reviewed direct PASS, return→same-worker second run→fresh reviewer PASS, single final delivery, authority/stale revisions, parent-review remaining open, blocked/worker failure/missing verdict, review-round exhaustion, and restart without write replay. Existing call/lifecycle compatibility tests remain in the same suite. `src/tools/task_test.ts` verifies structured tool identity and rejects manual orchestration.
