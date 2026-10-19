# Fresh automation state persistence

New ordinary fresh-context cron executions and the built-in Work organizer opt into a versioned persistence policy. Automatic Work observation has been retired; existing observer history remains historical data. Existing-session cron, ordinary sessions/tasks/calls, learning pipelines and existing historical state records retain their previous persistence behavior. Eligibility is explicit creation metadata (`mode: task`, an explicit fresh automation reference, and `statePersistence`); agent names and legacy address inference do not enable it.

Each execution still has its own session/execution identity, automation run identity and physical logs. A stable job slot is not a reusable conversation. No previous run's transcript is supplied to the next run.

## Storage

Under the Project's canonical sessions directory:

- JSONL: `.fresh-automation-v1-jsonl/<sha256(projectId, jobId)>.json` is the one stable JSON slot per job. It contains only active/unsettled runs. Finalized full metadata lives in `.fresh-automation-v1-jsonl/archive.db`; logs retain their existing addresses.
- SQLite: `.fresh-automation-v1-sqlite/archive.db` holds equivalent active/unsettled and finalized selections. Existing `sessions.db` state rows and logs are not moved. Startup selects only active rows from the new database.
- The archive indexes session, job/time, execution key and parent identity. Compact distinct ownership claims and one feature reference per job support ownership reservation and deleted-job discovery without selecting every archived state blob.

There is no startup migration, rewrite or deletion of old state files. New policy cannot be applied through `saveState` to an existing legacy state key. Historical old rows still contribute their previous startup cost.

## Settlement and recovery

Execution completion alone does not archive a run. Its caller first consumes the execution result; the organizer also persists its domain outcome. `finalizeAutomation` records that caller barrier, then checks terminal execution status, active sessions, local children, completion delivery, pending questions/inputs, background work and external A2A ownership. Unsettled references retain the live pointer. A pending external notification or interrupted caller barrier is not silently acknowledged just to shrink storage.

Updates serialize per store. Archival commits indexed metadata before removing only that execution from its job slot. Overlapping runs cannot remove one another. If pointer replacement fails after archive commit, startup keeps the remaining slot entry active and retries the already-proven finalization idempotently. Finalized metadata is immutable; stale writes and stripped-policy writes cannot revive a run. The manager does not reinsert an archived state into live maps when a late write fails.

Startup never replays a provider run to repair metadata. Pending report delivery retains the existing reporting semantics. Interrupted caller-side finalization without a durable barrier remains active/unsettled for recovery rather than being guessed complete. Learning runs are deliberately **not opted in**: their proposal/batch recovery needs a separate durable caller adapter.

## Historical reads versus execution control

`getSessionState` and `listSessions` remain synchronous live-only APIs. `readSessionState`, `listHistoryStates` and indexed `querySessionHistoryStates` read history without hydrating the live map. `executeOnce` checks the indexed archive before admitting an operation.

Session history, physical segments, result/details/profile routes, session VFS, owned completed-execution receipts, Project usage and automation discovery include archives. Automation run pagination uses indexed job queries and counts; feature discovery reads one representative per job. Physical history is checked against a Project-resolved state. Historical folder checks validate preserved locality/lineage. Read access does not authorize message admission, resume, mutation or cancellation of a non-live run. Direct creation of an archived session ID is rejected.

Explicit deletion of new fresh-automation state is not implemented; attempts fail rather than orphaning archive/log/ownership references. This feature is not a cleanup operation for old history.

## Tests

Synthetic repository-local tests cover both stores: sequential runs and context isolation; bounded startup with 220 settled runs; stable JSON slots; old JSON bytes/SQLite rows preserved; archive lookup and pagination; overlapping/out-of-order archival and stale writes; archive-first interruption; malformed/foreign records; compact remote ownership claims; report failure and restart recovery; historical HTTP/VFS/details/profile/result reads; mutation denial; and execution-key deduplication after restart. No production Project store or host restart is used by those fixtures.
