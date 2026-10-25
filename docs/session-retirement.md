# Session cleanup automation

Automatic retirement is **opt-in**, disabled by default. It removes eligible
conversations from the ordinary session lists, not from disk. No automatic
physical deletion or disk-space reclamation is implemented.

Each Project installs **Session cleanup** once as an ordinary, disabled fresh
automation (`source: cron`). It is persisted with user jobs in the normal
`jobs.json` store under the Project cron directory. It appears in the existing
Automations list, uses its enable/disable control and ordinary run history, and
executes through `CronDispatcher` → `SessionManager` → the normal agent/tool loop.
There is no retirement scheduler, startup scan, separate assessor execution,
scan status store, or retirement configuration lifecycle.

Enable it through the ordinary automation toggle or
`PATCH /api/automations/<id>` with `{"enabled":true}`. Its installed schedule is
`0 3 * * *` (03:00 in the configured cron timezone); changing the cron timezone
uses the existing runtime/restart behavior. Eligibility is fixed at five days
since the last user input. The schedule and eligibility are different: a daily
tick does not mean that one-day-old sessions are eligible.

The shared automation API supports explicit manual runs, including while the
timer is disabled. Disable prevents **future scheduled admissions**, not work
already admitted; use Cancel to stop an admitted run. Overlapping runs of the
same job coalesce. Cron shutdown aborts and drains admitted executions through
the same lifecycle as any other fresh automation. There is no new frontend
settings panel or dedicated Run/Cancel widget; these actions are backend APIs.

## Upgrade/default behavior

The former `sessionRetirement` config object is no longer read. Old enabled or
custom inactivity values do **not** automatically grant this replacement
automation permission to run: explicitly opt in again through Automations.
The normal config parser strips that obsolete key in memory; the next normal
config save drops it from the validated configuration. Loading itself does not
rewrite config files. The misplaced example under `tools` was also removed.

Existing version-1 cron stores without an installation marker remain readable.
A generic default-installation marker is saved alongside ordinary jobs; it
prevents duplicate installation and preserves deletion across restart. A stable
installation ID also deduplicates interruption between the job and marker
writes. Existing jobs and enabled preferences are unchanged. Already-retired
session receipts, user timestamps, logs and restore behavior remain compatible
in **both JSONL and SQLite**. No history migration or physical purge occurs.

## Eligibility and closeout

- Only ordinary `web:chat-*` conversations are eligible. System,
  channel-bound, automation, task/call, remote/unavailable-workdir, Initiative,
  parent/reporting/shared-workdir and dependent sessions are protected.
- Age is measured from the last **human message**, not the last assistant
  response, system event or background activity. New human message admissions
  persist a dedicated timestamp in both JSONL and SQLite. Older sessions can use
  existing `decision_input.at` events across physical segments; records without
  trustworthy human timing are skipped, never aged from a generic `role=user`.
- Running, queued, preparing, waiting, recovery and decision-input sessions are
  protected. Effective enabled cron targets/origins/workspace owners are
  protected. Any running Project background task, local process, pending remote
  execution, credential request or publication/probe approval conservatively
  pauses retirement for the Project.
- The ordinary automation agent imports `session_retirement` and uses its
  `list`, `inspect`, and `apply` actions. The tool does not invoke an agent or
  own a scheduling/execution loop. The agent assesses full available physical
  history, draft-file inventory and public Project wiki, then proposes completed
  work or an explicit existing durable same-Project continuation. Unresolved
  work or uncertain knowledge preservation blocks retirement.
- The installed job uses a generic persisted `executionLimits` ceiling: only
  `import_tool`, `invoke_tool` and `session_retirement`, at most 100 inference
  requests, 200 tool admissions and 1,000,000 argument bytes per run. These are
  ceilings, not a guarantee of completing every candidate in one run. Catalog
  imports are restricted to explicit grants; arbitrary MCP config imports and
  extra subprocess arguments are denied. Model-facing `cron_add` cannot grant
  these host-only capabilities. The domain tool additionally requires an active
  fresh cron execution whose current job grants it access; merely importing or
  knowing its name in a conversation is not authorization.
- Inspections are execution-owned, single-use and expire after 15 minutes.
  Cancellation invalidates pending inspection tokens. A restart cannot apply an
  old proposal; the next run must inspect again. Bounded evidence is returned
  intact rather than truncated into an unread output file.
- Every inspected session-data file must be preserved byte-for-byte, including
  intermediates. The host copies with exclusive-create semantics, verifies
  SHA-256 hashes, and leaves originals intact. A selected local Folder is the
  delivery destination. Otherwise destinations must be in a discovered OS
  Documents/Pictures/Videos/Music/Downloads `Shadow` folder. Desktop is never
  selected automatically. Windows uses User Shell Folders (including redirected
  locations), Linux uses `user-dirs.dirs`, macOS uses existing standard user
  directories. Unknown/unavailable destinations block delivery.
- The proposal may reference existing inspected wiki pages or propose selective
  new topic pages under `memory/retirement/`. These are ordinary Project wiki
  Markdown, browsable through existing knowledge tools/API, not session summaries
  or a second knowledge database. Existing exact content is reused; existing
  filenames are never overwritten. The agent must avoid semantic duplication.
  Per-session memory, event logs and in-session compaction do not count as
  cross-session preservation.
- Host admission locking, history/state fingerprints, a fresh draft inventory,
  dependency and activity checks, current cron checks, durable
  continuation existence, persisted source context in its current history, and
  saved-content hashes gate the final state change.
  Stale proposals fail closed. Retirement receipts retain the assessor session
  ID so its structured proposal remains inspectable.

## API and recovery

All paths below are Project-scoped and require the normal Project authorization:

| Request | Behavior |
| --- | --- |
| `GET /api/automations` | Ordinary inventory, including the disabled/enabled Session cleanup job |
| `PATCH /api/automations/<id>` with `{"enabled":true\|false}` | Persist timer preference; does not cancel admitted work |
| `POST /api/automations/<id>/run` | Ordinary explicit run, even when timer-disabled; returns 202, not proof of retirement |
| `POST /api/automations/<id>/cancel` | Abort and drain the current ordinary cron run; returns whether one existed |
| `GET /api/automations/<id>/runs` | Persisted ordinary executions/status; session transcript contains tool proposals, results and blockers |
| `GET /api/session-retirement` | Recovery inventory (`recentlyDeleted`), not scan controls or status |
| `POST /api/session-retirement/restore` with `{"sessionId":"web:chat-..."}` | Clears a persisted retirement receipt and restores listing |

`POST /api/session-retirement/scan` was removed. Run/Cancel endpoints apply to
ordinary fresh cron jobs, not managed learning or event-driven controllers.
Removal uses the existing `cron_remove` tool; a removed default is not recreated.

A new human input also restores a retired conversation. Automated delivery to a
retired conversation is rejected until it is restored. Logs, physical segments,
folder permissions and session files are retained. Explicit manual session
deletion remains a separate existing operation, not a retirement purge.

## Deliberate limitations

- This is recoverable list cleanup, **not** a secure eraser, recycle-bin retention
  timer, automatic purge, universal filesystem sandbox or released multi-device
  cleanup feature.
- Histories above 120,000 serialized characters, draft inventories above 100
  files / 80,000 bytes, and public wiki inventories above 100 pages / 80,000 bytes
  block assessment rather than silently truncating evidence. Binary drafts are
  identified and preserved; semantic binary/media understanding is not supplied.
- Folder work trees are not recursively inspected: registered Folder contents
  are already outside managed session storage. External references in transcripts
  are not swept or deleted. Browser profiles, uploads, services and shared caches
  are never physically removed.
- Symlinks/junctions, hard-linked files, special files, unsafe destination names,
  missing folders, existing output filenames and ambiguous directory ownership
  block cleanup. No permissions are widened. Filesystems can change independently;
  retaining all originals and history is intentional.
- Assessment is model-dependent. Invalid proposals, missing evidence, unknown roles
  or provider failures block retirement. Semantic completion, explicit
  continuation and nonredundant knowledge are agent judgments; the host verifies
  structure, scope, freshness and bytes, not the truth of arbitrary prose.
- Failed/stale applies may have already produced verified delivery copies or wiki
  pages. These are retained, never rolled back by deleting possibly useful
  outputs. The conversation remains live. Ordinary run status reports execution,
  not a guarantee that all candidates were retired; inspect the tool results and
  final report. Receipts, proposals in run transcripts, human timestamps, copied
  outputs and wiki pages are durable. Tests use synthetic providers; no live-model
  semantic quality or real user-folder delivery acceptance is claimed.
