# Offline channel session identity migration

> Historical reference only. The migration CLI was removed from the current checkout. The commands below require a revision that still contains the CLI.

`scripts/migrate-channel-sessions.ts` stages a reviewed migration from the old
`bot:<project>:<connection>:<platform>:<conversation>` (or legacy
`<platform>:<conversation>`) identity to the matching fixed `channel-inbox:`
identity. The default exporter does **not** modify a running application or install
its result. An explicit `--prepare-startup` plan can request installation at the
next exclusive host boot (see below). Migration needs reviewed Connection IDs,
a reference-scope audit, and stopped writers. Startup never guesses ancestry
from names or replays old input.

## Supported scope and fail-closed boundaries

- One explicit Project's ordinary active JSONL **or** current-schema SQLite session
  directory, including all its state records and raw physical log records.
- Both old and existing inbox segments are retained as separate whole segments.
  Inbox segments precede execution segments; these are not timestamp-sorted or
  interleaved. Tool calls/results retain order and IDs, and inherited raw-record
  indices remain unchanged. Raw duplicate rows are **not deleted**: deleting rows could invalidate inherited
  indices and tool provenance. A host `decision_input` ID matching an inbox receipt
  and its exact normalized user text marks the executed copy display-hidden. The
  original receipt remains visible once; raw evidence/indices and replies remain.
  Similar text, guessed timestamps or different native IDs never cause deletion.
- Physical identities are regenerated with version 2. State keys, log headers,
  previous-physical links and recognized structured logical/physical references
  in **all** states/logs in this directory are rewritten. SQLite tables and their
  native indexes are rebuilt transactionally in the staged copy. JSONL state
  filenames are regenerated. Unknown exact identity-reference fields fail closed.
- Free text/tool payloads are evidence, not rewritten configuration. Embedded
  session IDs inside prose/serialized tool arguments remain historical evidence.
- A fresh empty segment with `context_reset` is current after migration. Recovery,
  preload tools and service-boundary/generation snapshots are cleared on merged
  sessions. Old input and unfinished tools are never resumed by the migration.
  Next execution still needs a newly admitted live platform event and current
  runtime authorization. This tool neither binds a BOT nor grants permission.
- Known `.fresh-automation-v1-jsonl`, `.fresh-automation-v1-sqlite` and
  `.conversation-archive-v1` directories are retained byte-for-byte, including
  SQLite/WAL/SHM, slot JSON, archive indices and compressed blocks. A read-only
  inspection of disposable SQLite snapshots scans keys, JSON values and verified
  gzip archive blocks against all changed logical/physical identities. If there
  is no intersection, staging verifies auxiliary fingerprints before installation.
  Any intersecting auxiliary reference fails closed rather than leaving a stale
  index; unknown auxiliary files/tables/binary payloads also fail closed.
- Mixed stores, unknown files/tables/legacy SQLite columns,
  missing segments, ambiguous truncated legacy physical IDs, cross-Project
  metadata, automated/retired participants, filename collisions and changed source
  snapshots are rejected, without changing the source directory.

**Reference-scope limit:** this tool cannot update arbitrary external consumers.
Before installing output, the operator must audit Work/automation/workflow and
other Project databases/configuration for persisted references to the mapped
logical and physical IDs. It only rewrites references inside the specified
session directory. If references exist outside it, do not install output until
those consumers have an explicit migration or compatibility design. A successful
stage is not evidence that a Project-wide reference audit has passed. In
particular, this tool alone must not be advertised as a fully automatic migration
of an arbitrary Default or XMCL installation.

## Manifest

Prepare an operator-reviewed JSON manifest outside the sessions directory. Do not
include secrets. `source` is verified host-recorded origin evidence, not a grant.
QQ example (substitute actual IDs; no placeholder is auto-discovered):

```json
{
  "version": 1,
  "projectId": "PROJECT_ID",
  "mappings": [
    {
      "from": "bot:PROJECT_ID:CONNECTION_ID:qq:group%3AGROUP_ID",
      "source": {
        "version": 1,
        "projectId": "PROJECT_ID",
        "botInstanceId": "CONNECTION_ID",
        "platform": "qq",
        "conversationId": "group:GROUP_ID",
        "kind": "group"
      }
    }
  ]
}
```

Use percent-encoded components for `bot:` IDs. The target is computed rather
than separately supplied. Discord requires `botUserId`, exact `guildId` for
channels/public threads, `parentId` for threads, or `recipientId` for direct
messages. Thread context is never merged with its parent channel. Make separate
manifests for `default` and each other Project, using their actual Project and
Connection IDs. Multiple legacy sources for one address are accepted in manifest
order; the last existing execution state supplies current non-origin metadata.

## Commands and shutdown requirement

From the repository root, using the pinned Node/pnpm versions:

```sh
# Read-only provisional plan; no output/backup/source writes.
pnpm exec tsx scripts/migrate-channel-sessions.ts \
  --sessions /absolute/project/state/sessions \
  --manifest /absolute/reviewed-manifest.json

# After stopping every writer (Electron, backend/service, watchers, other devices):
pnpm exec tsx scripts/migrate-channel-sessions.ts \
  --sessions /absolute/project/state/sessions \
  --manifest /absolute/reviewed-manifest.json \
  --output /absolute/project/state/sessions-canonical-staged \
  --backup /absolute/project/state/sessions-before-canonical \
  --runtime-stopped
```

`--runtime-stopped` is an operator assertion, not a process-killing command or
proof of shutdown. The sibling exclusive lock prevents concurrent invocations of
this migration tool, **not** application writes. Snapshot hashes detect source
changes and verify the backup before output is published; they cannot replace
stopping all writers. Dry-run against an active store is only provisional.

The apply command refuses existing output/backup paths, makes a complete backup,
works in a temporary sibling output directory and publishes only a completed
staged store. The original source is never edited. Errors can leave the backup
for inspection; incomplete staging is removed. A crash may leave a `.pending-*`
directory or sibling `.channel-migration.lock`; inspect and verify no migration
process is running before manually removing those artifacts. Never remove an
application lock to force migration through.

Before installation: inspect the reported identity map, validate representative
histories/tool pairs and complete the external-reference audit above. While all
writers remain stopped, the operator may rename the original sessions directory
aside and rename the reviewed staged directory to the original path. This final
installation is intentionally **not** automated by the script. Keep the complete
backup and original directory. Rollback, before admitting any new traffic, is to
restore the original directory; after new traffic, rollback requires reconciling
new writes rather than discarding them.

The staged directory contains a `.channel-session-migration-v1.receipt` with the
manifest hash. Re-running the identical manifest against that directory is a
no-op; a different manifest is rejected. The receipt deliberately is not a
`.json` file because the JSONL store treats every top-level `.json` file as a
session state. The original source remains unmigrated and may be staged again
only into new output/backup destinations.

## Verification

```sh
pnpm exec node --import tsx --test src/sessions/channel-session-migration_test.ts
```

Synthetic tests cover JSONL and SQLite merge, retained raw tool pairs, multi-
segment physical references and inherited row indices, native listing/index
behavior, fresh non-replaying current context, source/backup retention, dry-run,
idempotency and fail-closed unsupported layouts/references. No real user data is
needed or touched by these tests.

## Explicit next-start installation (no live data swap)

A reviewed manifest can now omit `source` for a bot-only legacy history and instead supply the exact address:

```json
{"version":1,"projectId":"PROJECT_ID","mappings":[{"from":"bot:PROJECT_ID:CONNECTION_ID:discord:123","address":{"projectId":"PROJECT_ID","botInstanceId":"CONNECTION_ID","platform":"discord","conversationId":"123"}}]}
```

This does **not** invent Discord ancestry or authority. Existing `discordChannel` bytes are preserved; the new state has `channelIdentityMigration: 1` and may lack `channelSource`. Only a later genuinely verified adapter receipt may fill that evidence. The companion runtime implementation must persist the marker in both state backends and keep missing-source histories non-executable without normal live admission. A new empty context segment prevents history/tool replay.

Prepare a plan (after reviewing dry-run and all mappings) with:

```sh
pnpm exec tsx scripts/migrate-channel-sessions.ts --sessions /absolute/project/state/sessions --manifest /absolute/reviewed-manifest.json --prepare-startup
```

This writes only `sessions.channel-migration-plan.json` beside the store, using exclusive creation. It does not change the live store. Stop all Electron/backend/service/watchers and other writers, then start **one** updated host. The host processes this explicit plan before ownership scans, startup snapshots, or store loading. It builds and validates `.canonical-staged`, retains `.canonical-backup`, journals the swap, renames the original to `.pre-canonical`, and installs the staged store. Receipt matching makes subsequent restarts no-ops. Keep these backup directories until user acceptance; no automatic cleanup runs.

The `exclusiveRestart: true` plan is an operator assertion, not an OS-wide lock: do not leave another host or writing device running. A separate install lock prevents cooperating installers; a stale lock after process death requires operator inspection/removal. A journaled interrupted swap is resumable after inspection, with staging checksum and manifest checks. Any ambiguity, mismatched receipt, unsupported auxiliary store, or failed backup/verification blocks the Project for the entire host boot, including retry; repair and restart rather than bypassing validation.

Compatibility interface for external references: the store's `.channel-session-migration-v1.receipt` contains `aliases: {"oldLogicalId":"channel-inbox:..."}`. `report.identities` additionally includes physical-segment remaps. The runtime must use the logical aliases at entry points for legacy consumers; this migration does not rewrite Work/workflow databases. This interface is not an output grant and does not change platform reply validation. The runtime loads this receipt before creating SessionManager. Logical aliases are resolved at session entry/history APIs; exact physical aliases are resolved by the store adapter used by raw history readers. Both stores retain the missing-origin migration marker. Old references therefore select the canonical history without granting admission or output authority. Consumer-owned equality checks or embedded executable/configuration payloads are not rewritten; an incompatible consumer must fail closed rather than authorizing itself from an alias.
