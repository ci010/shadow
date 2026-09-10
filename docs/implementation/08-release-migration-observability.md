> **WIP release plan / historical checkpoint, not a release certification.**
> Current development/build commands use Node.js/pnpm. Old Deno commands,
> package matrices, test totals, and acceptance criteria below must not be read
> as current validation or a completed multi-device release. See the
> [status/index](README.md), [current architecture](../architecture.md), and
> [current operating instructions](../../README.md).

# S8: Release, Migration, and Observability

> Owner: release/SRE
>
> Depends on: contracts from S1-S7

## Goal

Turn the component work into reproducible desktop and headless artifacts, preserve
existing user data, and make distributed failures diagnosable.

## Owned Modules

- `build.ts`
- `deno.json` release tasks after S4 lands
- `Dockerfile` and compose/service packaging
- Electron builder/signing/update configuration
- `scripts/migrate-sessions-to-sqlite.ts`
- CI workflows and release smoke tests
- OTel/job audit integration with S2/S3

## Migration Plan

- Inventory current JSONL and SQLite layouts with real fixtures.
- Correct the existing migration script/schema mismatch before relying on it.
- Add versioned, idempotent migrations with backups and dry-run reporting.
- Preserve legacy managed session directories while adding local capability IDs.
- Verify rollback restores both data and executable version.
- Never delete old data automatically in the first release after migration.

## Artifact Matrix

At minimum produce and test:

- Windows Electron installer;
- Windows portable/development artifact if required;
- headless Windows service package;
- headless Linux service or archive;
- headless container image.

The exact initial support matrix is a release decision. Unsupported targets must
not appear in the wizard or documentation as functional.

## Compatibility Matrix

CI should test:

- same-version Main and Child;
- supported minor-version skew;
- rejected major-version skew;
- upgraded Main with old Child;
- upgraded Child with old Main;
- rolling reconnect with jobs in accepted/running/completed states.

Auto-update must not create an unsupported Main/Child pair without warning and a
recovery path.

## Observability

Correlate every distributed operation using:

- trace ID;
- job ID and idempotency key;
- session/turn IDs;
- Main and node IDs;
- capability ID;
- protocol and implementation versions;
- terminal reason and artifact IDs.

Audit records are structured, append-oriented, bounded by retention policy, and
redact commands/content according to policy. Metrics cover node online status,
queue depth, job latency, approval latency, reconnects, transfer bytes/failures,
and migration outcomes.

## Operational Tests

1. Clean-machine desktop install starts without Deno or development dependencies.
2. Headless Main starts with no GUI packages/display and persists data on a mounted
   volume.
3. Backup/restore recreates agent identity, sessions, knowledge, and node registry
   without duplicating jobs.
4. Migration fixtures preserve complete session state and legacy workdirs.
5. Main kill, Child kill, network partition, packet delay, disk-full, and expired
   credential scenarios produce actionable terminal states.
6. Logs correlate one request from UI through Main, Child execution, artifact, and
   final session receipt.
7. Package signature/update verification failure is safe and recoverable.

## Release Gates

- S1-S7 acceptance suites pass.
- Migration dry run and rollback succeed on representative user data copies.
- Security review approves external listener defaults.
- Electron and headless smoke tests run from directories unrelated to the repo.
- No release depends on a developer's global Deno/npm cache.
- Known protocol compatibility and backup/recovery procedures are documented.
