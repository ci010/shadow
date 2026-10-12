# Application data layout migration

This is an explicit **offline, same-root, copy-only** operation. It is not run
by startup. Finish building and validating the new code before migrating data.

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

## Procedure

1. Run the preliminary read-only plan from the repository:

   ```sh
   node --import tsx scripts/migrate-data-layout.ts --data-dir <absolute-data-root> --plan
   ```

   This hashes source files and checks supported structure/links. A successful
   live plan does **not** prove the source is consistent or ready to migrate.
2. Quit Shadow completely (tray **Quit**, not merely closing its window). Stop
   Main/dev watchers, background work and all other programs writing this root,
   including managed browsers. If the active conversation runs on this Main,
   arrange the offline operation outside that conversation before stopping it.
3. Ensure enough free space for a full copy plus private SQLite scratch and
   retained source. Review permissions. The utility preserves POSIX mode bits
   and supports Windows long paths, but it does not copy arbitrary custom ACLs
   or ownership. Custom ACLs require a separate preservation plan.
4. With **all writers stopped**, run:

   ```sh
   node --import tsx scripts/migrate-data-layout.ts --data-dir <absolute-data-root> --copy --offline
   ```

   `--offline` acknowledges the requirement; it cannot detect or stop writers.
   Source hashes and metadata are checked during copying and before/after
   publication. Any observed mutation aborts the migration.
5. Inspect the success receipt at `.layout-migration/receipt.json`. Only then
   launch the rebuilt Desktop/backend, and verify projects, history, memory,
   provider settings, managed files/uploads and device connectivity.
6. Retain old `config`, `cluster`, `workspace`, and `workspace.projects` until
   the migrated installation has been verified. This tool never deletes them.

## Safety and recovery

- Files and directories are staged before publication. Existing unknown target
  paths cause a refusal instead of overwriting them.
- Source SQLite databases are never opened by SQLite. DB + WAL/hot-journal
  families are hash-checked into private scratch, recovered there, and copied
  with SQLite backup. Integrity, schema and row counts are verified. Disposable
  SHM/WAL companions are not blindly published as canonical database state.
- Ordinary copied files are hash verified. Both source and final inventories
  are recorded in the receipt. A repeat copy succeeds idempotently only while
  both still match; it does not merge later edits.
- `.layout-migration/copy.lock` prevents concurrent copies and blocks new Main
  catalog startup. A crash leaves the lock/evidence for inspection. **Do not
  manually remove an interrupted lock** before checking staging, publication,
  source stability and receipt. Handled publication failures attempt to roll
  back only the migration's own target paths.
- `app.json` is published last. Source data is retained unchanged; a failure
  must never be described as a completed migration.
- Rollback before any new writes can use the retained old data with the matching
  old code. After new writes, reverting paths alone loses changes: reconcile
  them explicitly. Do not run old and new backends concurrently against the two
  copies.

## Deliberate limits

Nonempty single-workspace sources, uncatalogued projects, links/junctions,
unmapped root config entries and conflicting destinations fail closed. There
is no automatic cross-root migration, arbitrary text replacement, or external
repository relocation. Historical local references to migrated managed files
are resolved at supported tool/media/I/O/knowledge boundaries; shell scripts
with embedded old absolute paths are not rewritten and may need updating.
Copilot profile credentials and protected Child identity storage are outside
this Main-data migration and stay in place.
