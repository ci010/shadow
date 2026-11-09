# Automatic Work dispatch

Automatic dispatch is a **program action in the standard persisted automation/cron
service**, not a second scheduler or an agent polling loop. The fixed Project-local
job is `default:work-dispatch-v1`, installed once with schedule `every 60s`.
It appears in the normal automation catalog, enable/disable, run/cancel, run-history
and usage APIs. Timer overlap, shutdown, abort and persistence use `CronService`.
An idle scan creates no session and makes no model request.

## Configure the one Project dispatcher

A Work record does not implicitly identify a repository. The one dispatcher per
Project must explicitly bind a registered, available **local repository-root
Workspace**. It starts disabled and cannot be enabled or manually run without that
binding. Missing, revoked, subdirectory and remote targets fail before any claim;
remote display paths are never used on Main. No target is guessed from the current
chat or another Project. The normal automation notice explains an unconfigured job.
The current configuration entry point is the authorized automation API (there is
no new dedicated Workspace picker).

On the owning Project router, using the existing human-owner authorization:

- `GET /api/automations`: includes the standard job/schedule/enabled state, notice,
  program configuration, configuration error and running state.
- `PATCH /api/automations/default:work-dispatch-v1` with
  `{"program":{"kind":"work-dispatch","folderId":"<registered Workspace ID>","inferenceRequests":100,"toolCalls":200,"argumentBytes":1000000},"schedule":"every 60s"}`.
  The three budget fields may be omitted to use these defaults. The interval can
  be changed using the cron service's existing `every Ns/Nm/Nh` scheduling syntax.
- Then PATCH the same endpoint with `{"enabled":true}` (or false).
- POST the usual `/run` to scan now, including while its timer is disabled.
- POST `/cancel` to abort an in-flight scan and stop its currently admitted
  executor, without releasing its Work or deleting artifacts. Disabling only
  stops future timer admissions; cancelling is not disabling or Work cancellation.
- The existing `/runs` and `/profile` show actual executor sessions and model/tool
  usage. Idle scans intentionally do not fabricate model-execution history.

Definitions and preferences use the existing logical `.cron/jobs.json` storage
(physically `Project Home/state/cron/jobs.json`). Default removal remains a normal
user removal; the initialized-default marker prevents unwanted resurrection.

## Claim, isolation and execution

A scan selects at most one unassigned, nonterminal, unpaused Work. It reuses the
Work dependency outcome rule and checks ancestor pauses/terminal state and pending
transitions. Done/cancelled Work, existing assignees and unmet dependencies are not
claimed. An unassigned **blocked** Work can be claimed once for blocker clarification
and publisher help; its blocker is retained, not silently cleared. A blocked Work
with an assignee is never a re-entry pool.

The eligibility check and sequence compare-and-swap run in the same Initiative
SQLite write transaction. The durable executor identity is stable for the Project,
Work and assignment revision. One Project admission lock and capacity check cover
both scans and explicit recoveries: running, queued/preparing, maintenance and
normal human/external waits do not create an additional executor. No batch of Work
is reserved in advance. A competing claim never takes over the winner.

Before first inference, the host prepares and registers an independent **real Git
worktree**, with a `shadow/work-<stable hash>` branch at the source's committed HEAD.
It lives under `Project Home/work-executions/<hash>`, outside the source repository.
The source index, staged/unstaged files and untracked/ignored files are not copied,
stashed, reset or checked out. Worktrees/branches are retained for recovery, not
removed on failure. Each first delivery and explicit recovery revalidates the
registered isolated path, real Git common directory, worktree root and branch;
missing/replaced worktrees fail closed, never reset or recreate prior execution.

LayerFS is not used as a pretend Git/PR bridge: the current bridge's `publish`
updates LayerFS main, not a real Git remote, and there is no verified automatic
export-to-Git/PR path. Its container mount IDs are not host Workspaces. Independent
Git worktrees provide the reliable branch/commit path here. This is checkout
isolation, **not an OS sandbox**; normal tools/role rules and explicit authority
still apply. Agents are instructed to make code changes in their isolated
Workspace, never silently fall back to the source directory. Build dependencies
and ignored local configuration may be absent from the clean checkout; obtain
what is authorized or report the concrete blocker.

Delivery goes through the existing `SessionManager` durable-session lifecycle,
not a new provider loop. A write-ahead `delivering` receipt precedes admission;
only an exact accepted receipt advances it to `running`. All automatic executor
admissions, including ordinary Session resume and human-reply paths, pass through
the same Project capacity/isolation controller before Session preparation. The
manager rechecks current assignment revision, pause and terminal state immediately
before dispatch, so a change while preparing a prompt cannot start obsolete Work.
`notifyWorkChange` does
not independently wake the fresh assignee before that barrier. A crash with
unconfirmed admission blocks for inspection instead of blindly resending tools
or creating another session. Host-owned automatic session metadata and budgets
round-trip through both JSONL and SQLite stores; old sessions are unchanged.

## Unable to complete, waiting and recovery

The general role and automatic Work context require honest reporting:

- Keep the assignee. Report blocked, not done or released, when implementation
  cannot proceed or needs missing information, permission or a decision.
- Record completed steps, artifact/branch/commit/draft-PR references, attempts and
  evidence, the specific blocker and the next required input in Work notes. Ask
  the publisher/coordinator for what is missing. External intake text and Work
  descriptions are not authorization.
- Existing provider/transport retries remain finite. The host applies configurable
  inference/tool/argument ceilings using the existing budget mechanism without
  widening role permissions or showing a per-inference countdown. These are host
  turn/live-toolset limits, not a new lifetime Work-spend accounting system.
- The host records blocked progress and retained execution context for abnormal
  turn failure, execution stop, exhausted budget, an unfinished final response,
  interrupted execution or uncertain admission. It notifies the Work manager, or
  the recorded BOT publisher session if there is no manager, with a stable blocker
  notification ID. The help receipt is saved with the blocker and recovered on
  startup/ticks, with at most three persisted delivery attempts. An interruption
  after acceptance but before its acknowledgement may duplicate that same-ID help
  message; it must not duplicate actions. Exhaustion and the last error remain
  visible on the Work receipt, not silently reported as delivered. Normal pending
  human decisions/input and external execution waits are not relabelled as failures.
  A communication failure does not roll back the saved blocker or prove that a
  notification was delivered.
- An already reported blocker remains a blocker; Work cancellation/done is not
  overwritten by a late execution result. Explicit reassignment invalidates the
  old automatic receipt; the dispatcher does not steal it back.

Answer an ordinary pending input/decision through its existing controls. The
original assignee continues; do not create a replacement session just for a
supplement. For a stopped/failed blocked executor, an authorized human can POST
`/api/automations/default:work-dispatch-v1/work/resume` with
`{"key":"<Work key>","version":<current Work sequence>}`. This checks current
ownership, pause/status, Project capacity and real isolation identity, and uses
existing SessionManager recovery. After inspecting unfinished tool effects, the
human must explicitly add `"acknowledgeToolReplay":true` if the existing recovery
record requires it. This acknowledgement warns of repeat side effects; it is not
new publication authority. A missing original executor requires explicit normal
reassignment, never silent replacement. Isolation failures before any admission
can be repaired and explicitly resumed in that same executor.

Execution boundaries come from system/role instructions, Project guidance, Work
acceptance/boundaries and actual human authorization. The dispatcher has no hardcoded
ban on branch push or PR creation. An authorized agent can deliver a branch/PR;
`done` reports execution delivery and does not invent publisher acceptance.

## Verification and limits

Focused tests cover idle scans with no inference, single admission, two SQLite
claimants, restart/uncertain-delivery fail-closed behavior, dependency/pause checks,
blocked responsibility retention, publisher help, capacity-safe recovery, replay
acknowledgement, API authorization/configuration persistence, and normal waits
versus failure/cancellation/budget exhaustion. Real SessionManager tests exercise
both stores, the first-admission notification barrier, role-respecting budgets and
isolated cwd. Disposable Git fixtures prove the real branch/commit tree excludes
user staged/unstaged/untracked changes and preserves the source index and HEAD.

No live GitHub push/PR, provider, remote-device isolation, production restart or
real group-message test is implied by these fixtures. PR creation still uses the
existing authorized agent Git/GitHub tools. This feature does not provision
credentials, install dependencies, implement remote isolation, clean up retained
worktrees, or add a semantic classifier for “cannot implement”.
