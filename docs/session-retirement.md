# Automatic session retirement

Automatic retirement is **opt-in**, disabled by default. It removes eligible
conversations from the ordinary session lists, not from disk. No automatic
physical deletion or disk-space reclamation is implemented.

Set the Project configuration through the existing authenticated Project config
API (preserve the other configuration fields):

```json
{
  "sessionRetirement": {
    "enabled": true,
    "inactivityDays": 5
  }
}
```

`inactivityDays` is an integer from 1 to 3650. Changes take effect without restart.
Main checks once after startup recovery and every 24 hours while running.
Shutdown aborts and drains assessment before persistence and providers close.
There is no new frontend settings panel; configuration, status and recovery are
available through the backend API.

## Eligibility and closeout

- Only ordinary `web:chat-*` conversations are eligible. System/orchestrator,
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
- A bounded tool-free `SessionManager` task assesses the full available physical
  history, draft-file inventory and existing public Project wiki. This is not a
  separate provider loop. It must propose completed work or an explicit existing
  durable same-Project continuation. Unresolved work or uncertain knowledge
  preservation blocks retirement.
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
  dependency and activity checks, current configuration/cron checks, durable
  continuation existence, persisted source context in its current history, and
  saved-content hashes gate the final state change.
  Stale proposals fail closed. Retirement receipts retain the assessor session
  ID so its structured proposal remains inspectable.

## API and recovery

All paths below are Project-scoped and require the normal Project authorization:

| Request | Behavior |
| --- | --- |
| `GET /api/session-retirement` | Current-process scan status, assessed-candidate blockers and `recentlyDeleted` session states |
| `POST /api/session-retirement/scan` | Starts a scan, or joins the current one; returns 202, not proof of retirement |
| `POST /api/session-retirement/restore` with `{"sessionId":"web:chat-..."}` | Clears a persisted retirement receipt and restores listing |

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
- Assessment is model-dependent. Invalid JSON, missing evidence, unknown roles
  or provider failures block retirement. Semantic completion, explicit
  continuation and nonredundant knowledge are agent judgments; the host verifies
  structure, scope, freshness and bytes, not the truth of arbitrary prose.
- Failed/stale scans may have already produced verified delivery copies or wiki
  pages. These are retained, never rolled back by deleting possibly useful
  outputs. The conversation remains live. Scan status is process-local; receipts,
  proposals, human timestamps, copied outputs and wiki pages are durable.
