# Automatic Work dispatch

The Project-local `default:work-dispatch-v1` job uses the existing automation/cron
service. A bounded host preflight checks whether eligible Work and capacity exist;
an idle scan creates no session and makes no model request. When scheduling is
useful, the host starts a **fresh-context internal dispatcher agent** through the
normal `CronDispatcher` / `SessionManager` lifecycle. It does not create another
scheduler or provider loop. Timer overlap, shutdown, abort and persistence remain
owned by `CronService`.

## Configure the Project automation

The job is installed once, disabled, with schedule `every 60s`. Configure a
registered, available **repository-root Workspace** as its default source
before enabling or manually running it. The dispatcher can choose a different
supported registered source for an individual Work, including an online Child
that advertises `workdir.git.derive`. Missing, revoked, subdirectory and unsupported
targets fail before claim; remote display paths never become Main paths. There is
no new dedicated Workspace picker.

On the existing authorized Project automation API:

- `GET /api/automations` includes schedule, enabled state, program, configuration
  errors, notice and running state.
- `PATCH /api/automations/default:work-dispatch-v1` can set:

  ```json
  {
    "program": {
      "kind": "work-dispatch",
      "folderId": "<registered Workspace ID>",
      "maxConcurrent": 4,
      "maxConcurrentPerDevice": 2,
      "inferenceRequests": 100,
      "toolCalls": 200,
      "argumentBytes": 1000000
    },
    "schedule": "every 60s"
  }
  ```

  The limits shown are defaults and may be omitted. Both concurrency limits are
  integers from 1 to 16. Optional `model` and `reasoningEffort` select the dispatcher
  model and default worker settings; individual admissions can override the worker
  model/effort. With no override, existing model defaults apply.
- PATCH `{"enabled":true}` or `{"enabled":false}` controls timer admission.
- POST the usual `/run` to schedule now, including while the timer is disabled.
- POST `/cancel` to abort an in-flight scheduling round and stop admitted automatic
  executors without releasing Work or removing artifacts. Disabling only stops
  future timer runs; cancellation is not Work cancellation.
- Existing `/runs` and `/profile` expose automation execution and usage. Idle
  preflights do not fabricate model-run history.

Definitions use the existing logical `.cron/jobs.json` storage (physically
`Project Home/state/cron/jobs.json`). Removing the standard job remains a normal
removal; the initialized-default marker prevents unwanted resurrection.

## Customize from an ordinary session

Read `v:skills/auto-dispatch` for guidance. Use normal `read` and `write` with:

- **`v:project/dispatch-instructions.md`** — supplementary Project scheduling
  preferences, loaded anew for every dispatcher round. It does not replace the
  built-in role. Empty content uses defaults.
- **`v:project/dispatch-memory.md`** — explicit persistent working memory. The
  dispatcher may read prior thoughts and update them when useful; a write is not
  mandatory after every round.

Both files start empty without creating templates. They belong to the current
Project, independently of the session's selected repository or execution device.
Ordinary remote-bound sessions can also edit them through the Project control
plane. Writes support overwrite and exact `match`/`content` edits, not append;
normal write receipts are recorded. The fixed paths do not expose the internal
agent directory or arbitrary Project Home files. Stored content lives under
`Project Home/state/work-dispatch/` and survives fresh runs.

For example, instructions can simply say:

```markdown
Prioritize result quality, then completion time, then model cost.
Use economical models for straightforward, clearly testable changes and stronger
models for complex design and cross-module debugging.
Parallelize independent code tasks; serialize operations on the same desktop.
```

Edits affect the **next dispatch round**, not workers already started, and do not
enable or immediately run the automation. Existing preferences should be read and
edited selectively rather than replaced unintentionally.

Memory is historical thinking, not current assignment, dependency, execution or
device state, user instruction, or an automatic retry queue. The dispatcher must
revalidate it against current facts. Stable user preferences belong in instructions;
work-specific blockers, results and evidence belong in Work. A missing memory file
never prevents dispatch. Complete prior conversation history is not inherited.

The built-in dispatcher is internal (`root: true`), has no general skill catalog
(`skills: false`) and no SOUL injection. It is omitted from public role selection
and local agent discovery. The customization skill is for ordinary sessions only.

## Scheduling and reliable execution

The dispatcher uses `work_dispatch` to inspect current Work and capacity, then
admit a selected Work by exact key and current sequence. It judges priority,
useful parallelism and suitable worker model without a persisted complexity score.
It can start several independent items or finish without starting anything.
Host admission still validates the current record and explicit dependencies.

Done/cancelled, paused, assigned and dependency-blocked Work are not claimed.
Ancestor pauses and terminal states are respected. An unassigned blocked Work can
be claimed once for blocker clarification; the blocker is retained. An assigned
blocked Work is never an automatic re-entry pool. Scheduling does not silently
remove an explicit dependency or change the task objective.

The host serializes admission and performs the eligibility/sequence check in the
same Work SQLite transaction. Each Work gets a dedicated durable worker session,
its selected model/effort and an independent registered **real Git worktree**.
The current derived-workspace backend creates a `shadow-derived-<uuid>` branch in
a sibling worktree from a committed source branch. Source staged, unstaged,
untracked and ignored files are not copied, stashed, reset or checked out.
Receipts retain source/branch/commit identity and idempotent creation evidence.
Legacy isolated Work receipts remain verifiable through the existing fallback.

A Project can have multiple automatic workers within configured Project/device
capacity. Each durable session still owns at most one unfinished Work. Active
execution and normal pending tool/input waits occupy capacity; a stopped reported
blocker retains its assignment without reserving an otherwise idle run slot.
Capacity is automatic-worker admission accounting, not CPU/GPU utilization or a
general desktop-resource lock manager. Independent worktrees isolate checkouts,
not external services or operating-system side effects.

Every first delivery and recovery verifies retained isolation. A missing or
replaced workspace fails closed, never falls back to source or recreates lost
user resources. The write-ahead `delivering` receipt precedes admission; only an
exact accepted receipt advances it to `running`. Ordinary resumes and replies also
pass current assignment, pause, capacity and isolation checks. Unconfirmed delivery
or interruption blocks for inspection instead of blindly resending operations.
Automatic session metadata persists through JSONL and SQLite stores.

LayerFS is not used as a pretend Git/PR bridge. Its internal publish operation is
not a verified real Git remote/PR export. The current automation uses the existing
real Git derived-workspace backend. This is checkout isolation, not an OS sandbox.

## Blockers and recovery

Workers retain responsibility when unable to proceed. They record completed
steps, artifacts, branch/commit references, attempts, concrete blocker and required
input in Work, and ask the publisher/manager through existing controls. Work done
reports execution delivery, not publisher acceptance.

Provider retries and inference/tool/argument budgets remain bounded. Abnormal
termination or an unfinished result records blocked progress without releasing the
assignment. Publisher-help receipts have stable IDs and at most three persisted
admission attempts. Normal pending user input and external waits are not failures.
A delivery error never proves that an external action did not occur.

Answer pending input/decisions normally so the original assignee continues. For a
stopped blocked executor, use the existing authorized endpoint:

`POST /api/automations/default:work-dispatch-v1/work/resume`

with `{"key":"<Work key>","version":<current Work sequence>}`. It verifies ownership,
status, capacity and isolation and uses existing session recovery. If unfinished
tool calls require acknowledgement, inspect effects before adding
`"acknowledgeToolReplay":true`. A missing original executor needs explicit normal
reassignment, never silent replacement. Cancellation, pause and reassignment do
not authorize replay of uncertain side effects.

## Verification and current limits

Focused tests cover fresh rounds, next-run customization, explicit memory across
runs, no idle inference, model/effort and workspace propagation, bounded parallel
admission, duplicate/stale rejection, dependency/ancestor checks, blocked retention,
uncertain-delivery recovery and both session stores. Virtual-file tests exercise
ordinary read/write/search, Project separation and remote-bound editing. Role
discovery tests check hidden internals and absence of dispatcher skill discovery.

Remote isolation uses the existing Project executor and Child workdir transport.
`workdir.git.derive` offers strict inspect/create/verify actions on an exact
registered source; it accepts no source or destination paths. The Child reuses the
same Git derived-workspace implementation, records Project-scoped creation receipts,
registers the new directory with its existing picked-folder identity mechanism and
advertises it before returning. Main validates the returned scope/node/source and
registers the exact new workdir in the Project. The worker keeps that Child binding;
Main never resolves or canonicalizes its display path. Optional advertised platform
metadata lets the dispatcher distinguish Windows, macOS and Linux targets.

Retained Main and Child receipts verify the same repository/workdir/branch after
restart. An uncertain create is not blindly replayed; a known retained workspace
is verified, not recreated. Old Children without the operation fail before claim
and must be upgraded/reconnected. Worker replies and resumes revalidate exact
registered Folder/workdir identity as well as current capacity. Work updates remain
Project control-plane operations even when Main local execution is disabled.

Fixture tests do not imply live provider, GitHub publication or paired-device
acceptance; actual device checks must be reported separately. This feature does
not provision credentials, install worker dependencies, synchronize result branches
automatically, clean up retained worktrees, add event-driven scheduling, or predict
hardware load. When source changes or results must move between machines, use Git
commit/push and fetch/pull on the owning device; do not copy dirty trees or resolve
remote paths on Main. Worktree receipts record the committed starting revision.
