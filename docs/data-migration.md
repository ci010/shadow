# Application data layout migration

This is an explicit **offline, same-root, rename-first** operation. Startup now
checks for old layout and migration locks **before creating app configuration or
starting Main storage**. New roots start normally; a valid completed receipt
allows the retained old roots to coexist with active new data without replaying
migration. Legacy roots without a receipt fail closed, rather than creating an
empty installation.

**Startup does not automatically copy old data.** Electron's single-instance
lock covers only the same desktop userData profile. Headless Main, services,
dev backends and old releases do not share a data-root writer lease; gateway
binding is too late to protect startup writes. Neither `offline: true`, an
available port nor a new desktop singleton proves all old writers stopped.
Therefore the safe upgrade path is operator-controlled offline migration using the
new executable's built-in runtime. No external Node or tsx is needed. This
command never kills processes. Ordinary managed data is moved, not duplicated: residual old roots are **not a complete old-layout snapshot** after success.

## Supported source and destination

Source: `config/bot.config.json`, `cluster/`, an empty legacy `workspace/`, and
`workspace.projects/{projects.v2.json,.host.otel.db,projects/<id>/{config,workspace}}`.
Destination: `app.json`, `projects.json`, `devices/`, `telemetry/host.db`, and
`projects/<id>/{config,memory,state,workdirs,cache,tmp}`.

The catalog content/version and logical Project/session IDs are retained.
Application `agent.workspace` becomes the data root; each Project's workspace
becomes its new Home. Other configuration tokens are preserved exactly. Opaque
history, bundle revisions, and I/O artifact records are not mass-rewritten.
Known Home entries use `PROJECT_STORAGE_ENTRIES`; unknown entries are preserved
under Project `workdirs/`. External registered repositories are never moved.

## Packaged executable (no external Node)

Use the installed executable and its packaged compiled backend entry (the same
`backend/dist/src/index.js` path used by the desktop sidecar, normally under
`resources/backend/dist/src/index.js`). Verify the actual installation path;
do not point to a source `.ts` file. In Windows PowerShell:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\path\to\Shadow.exe' 'C:\path\to\resources\backend\dist\src\index.js' data-migration --data-dir 'C:\absolute\data' --plan
# Only after quitting ALL writers and reviewing the plan:
& 'C:\path\to\Shadow.exe' 'C:\path\to\resources\backend\dist\src\index.js' data-migration --data-dir 'C:\absolute\data' --copy --offline
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

The command is routed before Main/service setup and executes the compiled
migration module in the bundled runtime. `--copy` without `--offline` is rejected.
On macOS/Linux use `ELECTRON_RUN_AS_NODE=1 <executable> <compiled-entry>` with
the same arguments. Restore the environment before launching Desktop normally.
A plan is read-only but not a guarantee of a consistent live source. See the
stopping, permission, verification and recovery requirements below.

## Procedure (repository/development alternative)

1. Run the preliminary read-only plan from the repository:

   ```sh
   node --import tsx scripts/migrate-data-layout.ts --data-dir <absolute-data-root> --plan
   ```

   This inventories metadata and checks supported structure/links without hashing bulk file contents. A successful
   live plan does **not** prove the source is consistent or ready to migrate.
2. Quit Shadow completely (tray **Quit**, not merely closing its window). Stop
   Main/dev watchers, background work and all other programs writing this root,
   including managed browsers. If the active conversation runs on this Main,
   arrange the offline operation outside that conversation before stopping it.
3. Ensure space for selectively copied configuration and SQLite recovery scratch/output.
   Ordinary unchanged trees/files and clean SQLite databases use same-volume rename
   without cross-device copy fallback or hardlinks. Make an independent backup if
   you require a full old-layout snapshot. Review permissions. The utility preserves POSIX mode bits
   and supports Windows long paths, but it does not copy arbitrary custom ACLs
   or ownership. Custom ACLs require a separate preservation plan.
4. With **all writers stopped**, run:

   ```sh
   node --import tsx scripts/migrate-data-layout.ts --data-dir <absolute-data-root> --copy --offline
   ```

   `--offline` acknowledges the requirement; it cannot detect or stop writers.
   Copied inputs are content-verified; ordinary bulk data is checked by structure,
   size, identity, mode and file timestamps, not repeated full hashes. Directory timestamps
   are ignored and file timestamps tolerate at most 1ms platform rounding. This
   cannot detect same-size/timestamp-restored writes; offline remains mandatory.
   Observed mismatches abort with the differing path and expected/actual metadata.
5. Inspect the success receipt at `.layout-migration/receipt.json`. Only then
   launch the rebuilt Desktop/backend, and verify projects, history, memory,
   provider settings, managed files/uploads and device connectivity.
6. Retain residual old roots until verification. Patched configurations and
   recovered database families remain there, but ordinary data has moved.
   These residual roots are **not a full old copy**.

## Safety and recovery

- Files and directories are staged before publication. Existing unknown target
  paths cause a refusal instead of overwriting them.
- Clean SQLite databases are renamed unchanged. Families with WAL/SHM/hot
  rollback journals are hash-checked into private scratch, recovered there and
  copied with SQLite backup. Originals are never opened by SQLite or moved.
  Integrity, schema and row counts are verified; committed WAL rows survive.
- The v2 receipt records remaining source and final metadata inventories.
  Repeat --copy --offline is idempotent only while both still match, not a merge.
  Existing v1 receipts keep their full-hash validation. Startup accepts v1/v2
  and never compares active data against historical receipt fingerprints.
- --copy is a compatibility spelling, **not a promise of a full copy**. Maximal
  unchanged mapped trees/files are renamed. Configuration is copied/patched.
  Cross-device renames fail instead of silently copying gigabytes.
- .layout-migration/copy.lock blocks startup and concurrent migration. Durable
  per-move and publication intents are flushed before rename. A crash retains
  lock, staging, scratch and journal. Handled failures restore published targets
  to staging, then restore moved data before deleting staging. Rollback failures
  retain evidence/data; moved originals must never be deleted by cleanup.
- For v2 interruption **without a completed receipt**, keep ALL writers stopped
  and use --rollback --offline with the same executable/root. Recovery refuses
  missing/ambiguous/changed moved paths, links and original-source conflicts.
  Inspect evidence on refusal; do not remove lock/staging blindly. Legacy v1
  interruptions, interrupted recovery locks and interruption after receipt
  creation require operator inspection. Never replay against active data.
- app.json is published last. After success/new writes a full reverse migration
  is not provided: reverting residual old paths loses moved data or changes.
  Use an independent backup or explicitly reconcile the installation.
- Journal files are flushed before rename. Directory-entry durability during
  sudden power loss depends on the OS/filesystem; inconsistent evidence fails
  closed rather than claiming power-loss atomicity.

## Startup detection and progress integration

Both startup validators expose read-only detectDataLayout(dataDir), returning
{status: 'ready' | 'migration-required' | 'blocked', reason?: string}. A new root
or valid v1/v2 receipt is ready; same-root legacy data needs migration; locks,
invalid receipts and unsupported standalone siblings are blocked. Detection
never creates directories and never establishes an offline writer lease.

The packaged command accepts optional --progress with --copy --offline.
Progress is JSONL on **stderr**: {type:'migration-progress', phase, completed,
total, path?}. The final result stays one JSON object on **stdout**. Phases are
inventory, staging, publishing, complete. Inventory totals are 0 (unknown);
staging counts mapping entries including descendants skipped by subtree rename,
not bytes or elapsed-time estimates. SQLite recovery can take time within one
entry. Programmatic MigrationOptions.onProgress(event) uses the same fields
without type; observer exceptions do not affect commit/rollback. Idempotent
already-copied runs emit only inventory progress without staging/publication replay. Recovery returns
rolled-back and currently has no progress stream.

A startup UI must run migration **before mutable config/backend startup**, keep
all writers stopped, parse progress separately from other stderr diagnostics,
and await process success plus receipt/lock validation before starting Main.
Neither automatic detection nor progress authorizes running with other writers.

## Deliberate limits

Nonempty single-workspace sources, uncatalogued projects, links/junctions,
unmapped root config entries and conflicting destinations fail closed. There
is no automatic cross-root migration, arbitrary text replacement, or external
repository relocation. Historical local references to migrated managed files
are resolved at supported tool/media/I/O/knowledge boundaries; shell scripts
with embedded old absolute paths are not rewritten and may need updating.
Copilot profile credentials and protected Child identity storage are outside
this Main-data migration and stay in place.
