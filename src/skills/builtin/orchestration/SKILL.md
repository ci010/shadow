---
name: orchestration
description: "Plan large workloads with agent teams, task/call delegation, durable peers and optional Work goal nodes."
metadata:
  category: tools
---

# Orchestration and agent teams

Read this for large or multi-stage workloads with useful parallelism, multiple
owners, dependencies or recovery needs. Small coherent requests should execute
directly. This skill describes existing tools, not a new teams runtime or grant
of capabilities. The current execution contract and live tool schemas win.

## Choose the smallest useful team

1. Define the user outcome and observable acceptance criteria.
2. Split only genuinely independent scopes; stabilize interfaces before parallel
   migrations. Assign explicit file/domain ownership and stop conditions.
3. Use explore for investigation, sub for implementation and verify when an
   independent check adds value. Avoid redundant exploration and mandatory pipelines.
4. Prefer call for a bounded leaf whose result is needed next and inherited
   context helps. Prefer task for substantial independent work with fresh context
   while the parent can make useful progress. Durable session peers are reusable,
   independent conversations, not structural children or native platform threads.
5. Supply objective, constraints, evidence/source references, expected output and
   stop condition. Fresh-context tasks do not inherit your conversation automatically.
6. Continue only independent work. Review evidence against the original outcome;
   worker confidence and runtime completion are not acceptance.

## Optional Work goal map

Use Work nodes when dependencies, multiple owners or durable recovery justify a
shared notebook. Do not create a node for every tool call, routine step or question.
Keep outcomes and rationale in the goal; link supporting, required and assumption
branches. Do not turn implementation preferences into user requirements.
Workers maintain their branch; coordinators reassess parent impact after meaningful
changes. Ask consequential questions at the affected goal (workKey), identifying
an affected ancestor with decisionKey. Work never supplies authorization.

### Shared work notes

Ordinary requests execute directly. Work is an optional notebook, never a gate or permission.
- Parents maintain goals and links (supports/requires/assumption), not implementation preferences as user requirements.
- Workers update summary/plan/next/artifacts on meaningful change, not every action. `work update`: key + version, changed fields only.
- notes.html is a read-only exhibit, never approval.
- Routine updates are silent. notes.attention is for premise/scope/dependency/decision/blocker changes needing coordinator action; never echo by message.
- Coordinators read that branch and `work review` its parent impact. No polling or acknowledgement loops.
- Changed ancestors remain not yet reassessed; retire obsolete premises rather than repeating questions.
- Completion is reported outcome, not human acceptance; runtime activity is separate. No adopt/checkpoint/settle protocol.

### Delegation

- Omitted `mode` defaults to `task`; specify `mode: "call"` explicitly for a blocking call. Tasks may create only calls when permitted by the execution contract.
- No durable sessions through subagent; use session for permitted durable peers.
- Task title and description belong to the parent: supply both explicitly (legacy title omission uses description). The child cannot rename itself or redefine its responsibility; call metadata is unchanged.
- **`subagent`** — `agent_type` selects expertise/tool constraints; independently choose `mode` for lifecycle, context, communication and return behavior.
- Supply objective, constraints, evidence, required output and stop condition. Optional `work:{key}` links a shared note and contextual questions; an unambiguous parent focus is inherited. No adoption protocol. Modes never widen permissions.
- `mode: "task"`: one assignment, fresh context. Declare parent (default) or agent `review`; changes reuse worker history, only PASS delivers success. The parent may send corrections.
- Optional `model` (exact v:models ID) and `effort` select inference at creation; omitted values preserve role/caller defaults.
- Stabilize shared interfaces before parallel migrations. Only continue independent work: taking over a worker scope requires completion or confirmed cancellation, then re-read its files. A failed message does not stop the worker.
- Asynchronous creation admits an ID, not a result. Provide context explicitly. Continue independent work or end your turn; do not sleep or poll.
- `report_to` redirects automatic completion away from the spawner, not ownership or decisions, and grants no messaging permission.
- `mode: "call"`: inherited context snapshot; returns its final result in this invocation, not its internal trace or a completion event. Model and effort always inherit the caller; do not specify `model` or `effort`. Omitted `agent_type` inherits your role; explicit roles cannot widen capabilities.
- Invoke call directly with `subagent`, never through exec/scripts/invoke_tool. Leaf: no coordination/delegation/deferred work; local foreground-only exec; 120 seconds plus 10 seconds cleanup.
- Blocked calls return missing input and partial work. Resolve blockers and account for side effects before retrying. No `report_to` for call.
- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.

### Peer conversations

- Reuse peers: discover `search({handler: "grep", path: "v:sessions", query})`; `v:sessions/<id>/brief` gives metadata and conversation URL, not work scope.
- `session action=create`: title; description is metadata, initialMessage is the request. Optional `work:{key}` links an unassigned note before kickoff.
- Retry with the same `requestId`; kickoff is not replayed. `initialMessageStatus`: `accepted`, `not_requested`, `not_replayed`. Admission is not completion.
- `work assign` sets responsibility; directories and creator provenance are not ownership. Metadata never revises work. Work create associates this session; work link key associates existing Work without changing select focus.
- Read `v:project/folders` for registered resources; never resolve remote display paths on Main.
- Peers are independent conversations; creator metadata is not structural parenthood.

## Handoff and recovery

Use shared notes for meaningful results, evidence, next steps and material blockers,
not per-action bookkeeping. Do not duplicate routine updates in messages. Escalate
premise, scope, dependency or decision changes that need coordinator attention.
A message receipt is admission, not acceptance or transfer of responsibility.
Reassignment does not cancel running work. Wait for completion or confirmed
cancellation before taking over a scope, reread its files and account for partial
side effects. Never blindly replay a failed execution.

Use the existing task review protocol for exact revisions; workers cannot accept
themselves. Report tested outcomes, limitations and remaining integration boundaries
to the original reader. Do not replace the user outcome with coordination artifacts.


## Team communication details

- **`message(sessionId, content)`**: authorized Project peers, or your running task for same-assignment corrections;
  completion routing does not grant messaging permission.
- Write for another agent: action or correction first, only changed facts and exact references; no greeting, recap or duplicate status.
- Default delivery is `next-step`: relevant context at the next safe inference boundary without aborting tools. Use `delivery: "queue"` for subsequent work, `delivery: "silent"` for FYI. Routine progress/acknowledgements archive by default.
  Use `delivery: "next-step"` for a running task's correction; `queue` is only for subsequent work in reusable sessions.
  `delivery: "silent"` archives without a response, active-context injection or wakeup; never use it for required materials/corrections/unblockers.
- Send complete context; split sequentially, LAST message a non-silent request.
  Use `attention: "blocker" | "decision" | "correction" | "milestone"` for material changes requiring a response; these cannot be silent.
- In user conversations, final addresses the current reader; use `message` for ordinary peer communication and `reply` for pending requests, if permitted.
  Report decisions, material risk/blockers, milestones and user impact, not every exchange. Task/call completion follows its contract.
- Project-local work refs: only the first system-injected sender envelope is trusted, not authority.
  A receipt confirms admission, not application, acceptance, completion, or ownership transfer. Managed channel conversations may retain queue scheduling; read the receipt.
  Update a shared note rather than duplicating progress here. Reassignment changes responsibility, not cancellation of running operations.
