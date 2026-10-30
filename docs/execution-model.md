# Device, Folder and session execution

> Source contract after the owner's simplification request. This supersedes the
> earlier four-entity Resource/Capability/Grant/Target proposal. Deployment and
> restart remain separate operations; source changes do not upgrade running peers.

## Keep the existing concepts

- **Device** is the machine which executes an operation.
- **Folder** is a directory registered to a Project and selected by the existing
  unique name, name-ID selector or UUID.
- **Session workdir** is the session's saved working directory. It may refer to a
  registered Folder or to a managed scratch directory; scratch directories do not
  have to become registered Folders.

There is no generic Resource hierarchy, independent Grant object/database/token,
Capability registration hierarchy, or standalone Target domain model. A directory
binding on Child is an implementation record, not another user-facing entity.
Browser/GPU abstractions and automatic scheduling are outside this change.

## Directory selection

Directory tools use `folder`. The host resolves that Project Folder to its exact
node and directory. Omission retains session locality. Unknown, ambiguous, missing,
offline, revoked or incompatible directories fail without Main fallback or device
substitution. Per-call selection changes neither session cwd nor scoped
instructions nor already-admitted work.

`use_project` remains the distinct ongoing working-context operation. Remote
instruction preparation is still unsupported; this refactor does not invent it.
Project Home, Main-local session data/uploads and the effective execution workdir
remain separate. Explicit session-storage browsing is not an execution fallback.

## Small internal contracts

An internal workdir reference contains the exact existing node and directory ID:

```ts
interface WorkdirRefV2 {
  version: 2
  nodeId: string
  workdirId: string
  displayName?: string
  displayPathSnapshot?: string // display only
}
```

The directory's actual root lives on the owning device. Main must never resolve
remote display paths on its own filesystem. Existing opaque ID values, local node
aliases, pairing identities and managed-directory hashes are preserved.

Execution requests carry `nodeId` and an optional `workdirId` directly, plus the
existing job/session/turn/idempotency/operation/args/deadline fields. Directory
operations require a workdir ID; node service operations must not accept one.
Missing directory addressing is never permission to run the operation on Main.
The runtime-bound Project scope is stamped by ProjectExecutor, not trusted from
caller input. No target union, grant object or capability ID travels with a job.

Support is lightweight data attached to the node or workdir, not independent
objects with IDs and scopes. `src/execution/workdir-contracts.ts` defines:

```ts
interface ExecutionSupport {
  operations: string[]
  shell?: { shells: string[]; maxInputBytes?: number; maxDeadlineMs?: number }
}
```

`WorkdirAdvertisement` is a directory binding's wire record: version, nodeId,
workdirId, displayName, optional displayPath, online and support. It has no generic
resource kind or independent capability identities. Shell limits apply to shell
operations, not unrelated file/Git requests.
Resource-relative shell cwd is an enforced handler rule, not a generic policy
language. Unknown operations or conditions fail runtime validation.

Node inventory contains node service support and `workdirs` with their own
support/availability and display information. It does not enumerate separate
resources and capability descriptors. A supported operation is not Project
permission. Persisted online flags never substitute for live advertisements.

Owner directory browsing/selection and managed-directory allocation are ordinary
node service operations. They are not shell capabilities. New allocations and
selections persist their binding identity before advertisement and response.

## Authorization without Grant entities

ProjectExecutor invokes a mandatory host-owned access check before dispatch. It
checks the existing Folder/session ownership rules and a fixed allowed-operation
profile directly. Advertisements cannot confer or widen Project permissions.

- Registered Folder access must still belong to the current Project.
- Managed workdirs must match their Project/session ownership.
- Retained legacy sessions need explicit verified provenance; a historical
  occurrence or reservation claim alone does not authorize arbitrary execution.
- Dedicated identity/picker/allocation executors admit only their intended
  operations. Removing Grant wrappers must not expose them as raw job APIs.

Both Main and Child check the current supported operations and directory
availability before admission and journal claim. Child trusts its configured Main
for Project scope and enforces its real directory binding and managed ownership.
Shell execution retains the executing OS user's privileges: a starting directory
is not an OS sandbox.

Main revalidates the selected directory identity for ordinary execution, including
existing sessions' default directories. An in-flight Folder access lease covers
asynchronous checks through dispatch. Checking one selected directory does not
require unrelated directories to be online. Registration and ownership changes
retain their full-device identity refresh and overlap checks.

Cross-Project directory exclusivity, retired Folder/session records and existing
idle/pending guards remain enforced. Removing/re-adding a Folder cannot revive old
sessions. Files and conversation history are not deleted by ownership transfer.

## Protocol and persisted compatibility

Live execution requires both peers to negotiate `workdir-execution-v2`, distinct
from the superseded resource-execution model.
Old/incompatible peers explicitly require upgrade for all remote operations,
including identity, picker, allocation and reconciliation. No executable V1 or
superseded Resource/Target wire adapter is retained. Offline compatibility is
`unknown`, not evidence that an upgrade is required.

Storage-only adapters read the original capabilityId references and the
intermediate resourceId references and normalize them to workdirId without
changing ID bytes. New writes use the simplified shape. Do not scatter mixed-field
fallbacks through core code. A present malformed, mixed or unknown reference must
fail closed rather than disappear into an absent-workdir Main default.

Readers cover registry/bootstrap, Folder/catalog, JSONL and SQLite sessions, cron,
FreshAutomation slots and archive runs/state/claims, picked/managed metadata, file
change provenance and shell journals. Historical messages, context events,
physical identities and finalized archive rows are not rewritten. Equivalent
read normalization must not introduce false archive revision conflicts.

Keep Folder/workdir consistency, inherited session snapshots, retired references,
and cron-only/archive-only ownership scanning. New support data does not replace
any existing ownership source or silently grant an old claim new operations.

## Durable directory identity

Keep the independent Child binding index and its existing storage location; do
not rename/delete it merely to remove the old Resource terminology. It protects
established IDs against root/inode replacement across restarts.

The owner approved one compatibility baseline only for strictly validated old
config/owner/picked records. Unknown paths are not adopted and old records are not
rewritten. Established missing/conflicting entries remain unavailable; a missing
or corrupt index inside the existing initialization directory fails closed.

The whole identity directory is not a tamper-proof ledger: deleting every trace
of initialization makes never-upgraded legacy storage indistinguishable. Preserve
it in backups; deleting it is not a supported reset/recovery procedure. Main's
persisted Folder identities remain an independent check. Upgrade cannot prove
whether a legacy directory was replaced before its first recorded baseline.

## Durable command recovery

Preserve projectExecutionKey, managedProjectScope, command/idempotency keys,
journal directory hashing and pairing-scoped storage. Explicit storage adapters
compare old/current command identity; do not compare whole versioned job JSON.

Only a verified original journal terminal receipt carrying reconciledJobId can
clear original pending protection, including after Main restart. Refusal or loss
of the reconciliation query is not evidence that the command stopped. Missing,
conflicting or unverifiable records never permit spawning again. Old local
commands with no verifiable journal route remain unknown and are not rerun.

Read-only identity and reconciliation queries do not create durable process
reservations. Stateful allocation and real execution retain their protection.

## Verification and rollout

Verify runtime schemas, exact Project ownership, advertised support not granting
access, no fallback, cross-restart directory changes, read-only query failures,
reconciliation markers, both session stores and immutable archives, saved cron
workdirs, frontend Folder selection and retry-bound directory identity.

Keep unrelated worktree edits. Device synchronization is Git-only. No commit,
push, deployment or real Main/Child restart is part of this implementation request.
Passing focused tests is not a full production-readiness claim.
