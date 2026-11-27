# Copying files and directories between Workspaces

The lazy built-in `copy` tool copies Main↔Child, Child↔Child and same-device
files/directories through the existing executor transport. Import/invoke it via
`invoke_tool(name="copy", args={...})` with **all four** fields:

```json
{
  "source_workspace": "shadow-main",
  "source_path": "assets",
  "destination_workspace": "shadow-child",
  "destination_path": "assets-copy"
}
```

Both selectors identify registered directories in the current Project, resolved
independently by the host; neither endpoint defaults to session cwd. `device:`
and LayerFS endpoints (including registered LayerFS workspaces) are rejected.
No raw node/workdir address, remote display path, URL, shell/archive/scp route,
source deletion, automatic fallback or external service is involved. Both peers
must advertise the new `filesystem.copy.read` / `filesystem.copy.write`
operations. They are wired into the fixed Project directory operation profile,
Child admission/dispatch and inventories; ordinary filesystem read/write target
authorization is also checked. Old peers fail closed, not via a text transport
fallback. Coordinator-only profiles do not import this tool. Source updates do
not upgrade already-running peers; restart/deployment is a separate operation.

## Paths and limits

Paths use portable relative `/` components; `source_path: ""` means the whole
registered root. Absolute paths, traversal, backslashes, Windows reserved names,
ADS/control/invalid filename characters, symlinks in path components or trees,
and special files are rejected. Destination must **not exist** and its parent
must exist. There is no overwrite or directory merge option. Empty files and
nested empty directories are retained. This copies bytes and tree shape, not
permissions, ownership, executable bits, timestamps, sparse layout, hardlink
identity, xattrs or a consistent filesystem snapshot. Keep the source stable.
Filesystem confinement checks are not an OS sandbox against a hostile process
concurrently replacing ancestor directories; do not copy in directories subject
to such mutation.

V1 bounds each manifest to 2,048 entries, 512 KiB JSON and 1 GiB total file bytes.
Chunks carry at most 64 KiB binary (base64 on the wire). Main relays one chunk
at a time, verifies SHA-256 against the source manifest, and returns only a
summary to the model. The destination independently verifies staged sizes/hashes
before publication. Per destination process, at most 64 stages and 1 GiB declared
staged file bytes are admitted.

Copy RPCs have a separate **ephemeral, single-consumer** executor lifetime. Main's
RemoteExecutor, the Main protocol dispatcher and Child's LocalExecutor evict
terminal copy-job requests/events rather than accumulating the transferred bytes
as replay history. Completed consumers also clear their chunk buffers. Each
holder permits at most 64 active copy RPCs and keeps only the last 128 job IDs as
payload-free replay guards. Request envelopes are limited to 1 MiB; Main bounds
each active copy-job event stream to 1 MiB/256 events and requests cancellation
on overflow. Regular non-copy executor history/reconciliation is unchanged.

A terminal copy RPC is not available from executor status/history after eviction;
a missing status is **not** evidence of success or rollback. The tool relies on
the live terminal receipt and staged integrity verification. Recent duplicate job
IDs are refused; the bounded guards are not durable idempotency or a resume API.
After disconnect, failure/unknown reporting and staging cleanup rules below still
apply. Transport queues hold only bounded in-flight frames, not a transfer archive.

## Publication, cancellation and recovery

Staging uses an unpredictable private `.shadow-copy-*` sibling directory, with
session/Project/workdir-bound handles, sequential writes and inode checks.
Files publish by exclusive hard link; directories publish by exclusive mkdir
then file links. Thus existing names are never replaced, but **recursive
publication is not atomic**. A filesystem without same-volume hardlink support
fails rather than downgrading to overwrite-prone publication. Cancellation or
failure after publication starts may leave a partial or complete destination;
it is never automatically deleted/rolled back. Lost receipts are reported as
unknown, not success. Do not retry blindly; inspect the destination first.

The tool attempts staging-only cleanup on error/cancel using a fresh bounded
cleanup signal; an online destination also attempts cleanup after ten minutes
of inactivity. Cleanup can be unconfirmed on disconnect, revocation or crash.
Stage handles are in-memory: after process restart orphan `.shadow-copy-*`
directories require inspection/manual cleanup; there is no resume, durable
transfer journal or automatic model-call replay. Source files are never deleted.
See `src/tools/copy_test.ts` for two independent Child executors and Main/Child
permutation coverage. `src/cluster/copy-retention_test.ts` additionally runs eight
multi-chunk copies through two real Main/Child protocol-session pairs and
Remote/Project/LocalExecutors, checking bounded retained state after each copy.
These fixture tests are not a claim of live fleet rollout.

Implementation: `src/tools/copy.ts`, `src/execution/filesystem-copy.ts`,
`src/execution/capability-filesystem.ts`, `src/execution/managed-child-workdirs.ts`.
See also [the execution model](execution-model.md).
