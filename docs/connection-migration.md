# Offline Connection → BOT policy migration

This command has **not** been run on Default, xmc, BOT or other real Projects.
Do not distribute the v3-only reader before migrating each device's v2 files.
Startup rejects v2 without writing it back. Locked/incomplete journals also block
new-runtime startup; startup never performs migration or repairs a stale lock.

## Authority after migration

- Connection document version 3 contains transport options/credentials, identity
  and enablement, not allowFrom/adminChats/trustedChats/triggerMode.
- The BOT.md companion's `connectionPolicies[connectionId]` owns the migrated
  intersection. QQ/Feishu intersect it with binding allowFrom; Discord additionally
  enforces participant roles and live platform permission. Legacy Connection
  `allowFrom: []` meant unrestricted and becomes omission. A BOT binding's `[]`
  still permits nobody. Service triggers remain binding-owned, never overridden
  by a legacy Connection trigger. Restricted Service BOTs never become admins.
- Unbound Connections need no collector BOT: they record common receipts but no
  model is admitted without a deployed BOT. No personal/general fallback is
  invented. Trusted-chat audience declarations are looked up in the BOT package.
- `bot_package propose` validates/publishes exact source without another native
  ask. Revision checks, live owner/platform/tool checks and exclusion remain.
  `create` writes a new directory and publishes a zero-subscription Service BOT;
  `link` edits/publishes the existing BOT companion, not Connection/Workflow copies.
  Direct DM/thread assignment is rejected; explicit verified parent inheritance
  remains possible for future child events, never historical replay.
- Workflow source `{kind:'bot',id:botId}` has exactly one node
  `{kind:'bot-reference',botId}` and no binding/gate/filter. At most one execution
  reference per BOT may pause its existing live inputs. It cannot admit synthetic
  observations or create replayable channel runs. Actual BOT enablement and
  permission still apply. Removing/resuming a reference never replays input.

## Stop and identify first

Quit all Electron/Main/service processes owning the listed Homes, including dev
instances, and disable auto-restart for this window. Verify exit with the local
process/service manager. Keep them stopped through plan/apply/recovery. Disabling
a Connection is not runtime shutdown. `--runtime-stopped` is an explicit operator
assertion, **not** automatic process discovery or a universal runtime lock. Old
binaries cannot enforce this new migration lock; operator exclusivity is required.

Run on the actual device owning the files. Do not interpret a Windows path on
Main/macOS. Git sync does not migrate Project data or credentials.

## Private explicit manifest

Use verified stable Project IDs, not display names. All paths must be absolute
on the executing device. Create the manifest outside Git after inventory review:

```json
{
  "version": 1,
  "projects": [{
    "projectId": "verified-project-id",
    "home": "/absolute/project-home",
    "connections": "/absolute/project-home/config/bots.v1.json",
    "deployments": "/absolute/existing-deployment-store",
    "sources": [{"folderId": "registered-folder-id", "directory": "bot-dir", "path": "/absolute/registered-folder/bot-dir"}],
    "privateFiles": ["/absolute/project-owned-credential-store.json"],
    "discordKinds": {"connection-id/verified-parent-channel-id": "channel"}
  }]
}
```

`sources` maps every active release's existing folderId/directory and can include
unpublished candidates. The existing deployment owner marker must match Project.
`privateFiles` is the explicit credential-backup inventory; none are discovered
or fetched. Those stores are backed up, not modified. The manifest schema is
`MigrationManifestSchema` in `src/bots/connection-migration.ts`.

## Commands (repository root)

```sh
pnpm exec node --import tsx scripts/migrate-connections.ts plan /absolute/private-manifest.json --runtime-stopped
pnpm exec node --import tsx scripts/migrate-connections.ts apply /absolute/private-manifest.json --runtime-stopped
pnpm exec node --import tsx scripts/migrate-connections.ts restore /absolute/private-manifest.json --runtime-stopped
```

`plan` is read-only, emitting only IDs/counts. `apply` first writes a private 0600
journal at `<home>/.connection-policy-migration/journal.json` containing original
Connection config/credentials, source bytes, active files/metadata and credential
copies. Never upload, log, commit or Git-sync it. Connection v3 switches last.
Active releases and candidates are transformed separately; candidates never
replace active. Omitted subscriptions versus [], disabled settings, tool/archive
scopes remain. New generations invalidate old execution contexts. Sessions,
JSONL/SQLite history, Workflow run snapshots and BOT mutable data are not rewritten.
No platform or BOT source code is invoked. Apply/restore use the existing
BotDeployments isolated local Git plumbing for private deployment history (no
remote access, hooks, source filters or signing). Git must be installed for an
existing Git-managed BOT; unavailable Git fails closed, never downgrades that
store to bounded mode. Plan does not invoke Git or change that history.

Re-run `apply` with the same manifest to resume exact old/new identities. Unexpected
edits fail closed. Already migrated BOTs are not reactivated. After verifying no
runtime/migration process remains, `--recover-lock` explicitly removes that exact
empty migration lock; no age-based guessing occurs. Interrupted deployment locks
or promotion journals need existing deployment operator recovery first.

`restore` restores exact original Connection/source bytes and original active BOT
content through the deployment store with a fresh generation, not revived context.
Git-managed restores append local history and retain Git mode. Restore marks its
journal `restoring` before changing anything, so an interrupted restore blocks
startup and must be resumed with `restore`, not `apply`.
Credential copies are recovery evidence because those files were never changed.
Restored v2 requires the old reader or another reviewed migration. This is
process-interruption recovery, not power-loss atomicity or an all-Project
transaction. Keep an independent durable private backup.

Ownership/format mismatches, missing source mapping, linked/special files,
conflicting existing BOT policies, post-backup edits or oversized journals stop
migration. Unknown Discord target types require verified offline evidence. Legacy
exact thread assignments are reported, never elevated to whole-parent permission;
they require an explicit scope decision before changing the source. No-BOT
Connections are not a blocker and no collector is fabricated.

Synthetic coverage: `src/bots/connection-migration_test.ts`. Real inventory,
platform acceptance and actual Project migration remain unperformed.
