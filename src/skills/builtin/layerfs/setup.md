# LayerFS: installation, official exec workflows, registration

Canonical guide: `v:skills/layerfs/setup.md`. Read flattened `v:tools/<name>`
contracts before invocation. This guide does not grant installation or publication
permission. Git/Docker/SDK operations below are explicit ordinary exec commands,
not a Shadow build/import pipeline.

## 1. Installation and one runtime owner

`layerfs_doctor` reports installation configuration with `runtime:"not_checked"`.
For missing artifacts, use `layerfs_bootstrap_plan`; pass its exact approvalRequest
to ask. After human approval, `layerfs_bootstrap` needs the returned plan, recorded
`approval:{sessionId,physicalId,requestId}`, `approved:true`, `allowRootWorker:true`
and `allowDownloads:true`. The plan is session-bound and expires after fifteen
minutes. The pinned installer accepts no arbitrary source URL, script or SDK path.
Wait for its background completion; inspect `layerfs_bootstrap_status` on failure.
Do not replay unknown provisioning or silently install OS/WSL/Docker prerequisites.

For an existing trusted installation, `layerfs_setup` accepts discovered matching
`installation:{apiRoot,bundle,image,distribution,node}` with initial explicit
`approved`/`allowRootWorker` consent. Paths refer to the approved installation, never
arbitrary executable modules. Installation artifacts are separate from source images.
`SHADOW_LAYERFS_CONFIG` is a historical operator override in the backend's environment;
do not edit it to select repositories or evade the installation boundary.

Reuse the approved artifacts without another routine approval:
- `layerfs_runtime_plan {runtimeId:"repos-1"}`
- `layerfs_runtime_start {runtimeId:"repos-1"}` for initial start; after a clean
  backend close/reopen, the same original owner session may explicitly start this
  same runtime again only when status reports `phase:"stopped"`, `ready:false`.
  `recordPhase:"ready"` alone is not live readiness. Do not create another runtime
  to bypass ownership; foreign sessions cannot take ownership. Running/concurrent,
  starting/uncertain/unknown and crash-retained starts are refused, not replayed.
- `layerfs_runtime_context {runtimeId:"repos-1"}` returns inspection access and the
  dedicated native `sourceRoot`. After authorized source preparation, add
  `sourceName:"repo-a"` to bind precisely that child directory for Init.

The first bootstrap/setup consent remains unchanged. Runtime plan/start have no
approval object. Unknown startup is not replayed. Each runtime has a separate home
and exactly one host-owned official Runtime/worker process. Existing resources and
old catalogs are retained, not migrated, adopted, overwritten or deleted.

`runtime_context` returns `executable`, `launcher`, `env`, `distribution` and
`linuxNode`. It returns no bearer/worker endpoint secret. Only the owning direct
session can obtain this launcher. It is a private same-user capability: do not read,
print, copy to a sandbox or share its contents. No extra network service installation
is involved. The existing child IPC channel is parent-only and cannot be inherited
by independently launched ordinary exec processes; the small authenticated loopback
adapter bridges just `project.list/start_init/get_init` and checked project config.
It binds 127.0.0.1 on an ephemeral port with per-runtime authentication, accepts no
module/eval/path-to-code operation, and closes with its runtime owner. It is not an
OS sandbox for programs already running as the host user.

A launcher invocation loads **your ordinary local exec script**, not server-side code.
It provides `{runtime,open,args}`. `runtime.project` forwards the three official
methods above to the existing owner; `open(name)` opens the actual agent SDK in the
exec process with host-checked project/volume/image configuration. One client/project
per exec process preserves the official SDK singleton constraint. Always close it in
finally. It never opens another Runtime or starts another worker. Do not use a host
path as a LayerFS cwd, and do not invoke this host launcher from a LayerFS workspace.

## 2. Fixed source with standard Git and Git LFS

Read the Git skill. The default and only Init input is a native ext4 directory in
this runtime's bound WSL distribution, outside the Store. Do not register a WSL UNC
workspace or relax global UNC rules. Host Windows checkouts remain untouched and
may be explicit Git/LFS object caches only, never DrvFS Init inputs. No automatic
copy/migration is performed.

First obtain runtime_context without sourceName. It returns a nonsecret sourceRoot
`/var/lib/shadow-layerfs-sources/<project-runtime-hash>` plus distribution/linuxNode.
The human's source-preparation request authorizes ordinary commands in this dedicated
root; the tool does not create directories, fetch Git or confer arbitrary `/etc`
access. Initial root-worker consent and direct owner checks still apply. A sourceName
is one safe child name, not a Linux/UNC/Windows path or distribution override.

Run a reviewed Bash script using the returned distribution; `$SCRIPT_IN_WSL` is
that script's discovered WSL-visible path (it may live in local session storage):

```powershell
& wsl.exe --distribution $DIST --user root --exec bash $SCRIPT_IN_WSL
exit $LASTEXITCODE
```

Scripts/arguments are ordinary exec, not a new Shadow preparation tool.
Set the following discovered values explicitly in that script: ROOT is returned
sourceRoot; NAME is a new safe name; CACHE is the authorized independent Windows
checkout as a WSL `/mnt/c/...` cache path; LFS_CACHE is its existing Git LFS storage
directory (the directory containing `objects`); SHA is the full fixed commit already
present in that cache; URL is credential-free HTTPS. No host config or dirty files
are copied. Use a separate script for each repository and retain the same runtime.

```sh
set -eu
umask 022
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_LFS_SKIP_SMUDGE=1
# Set ROOT, NAME, CACHE, LFS_CACHE, SHA, URL to the reviewed values above.
SOURCE="$ROOT/$NAME"
test ! -e "$SOURCE"
# These directories must be new or already root-owned, non-linked and protected.
# Do not chmod/chown an existing user directory to make a failed probe pass.
[[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]
for DIR in / /var /var/lib /var/lib/shadow-layerfs-sources "$ROOT"; do
  if test ! -e "$DIR"; then mkdir -m 755 "$DIR"; fi
  test ! -L "$DIR"
  test "$(realpath "$DIR")" = "$DIR"
  test "$(stat -c %u "$DIR")" = 0
  MODE=$(stat -c %a "$DIR")
  test "$((8#$MODE & 022))" -eq 0
  test "$(stat -f -c %t "$DIR")" = ef53
done
git -c core.hooksPath=/dev/null init --template= "$SOURCE"
git -C "$SOURCE" remote add origin "$URL"
# Local object transfer, not clone, alternates, tar, or copying the host .git/config.
git -c safe.directory="$CACHE" -c core.hooksPath=/dev/null -C "$SOURCE" fetch --no-tags --depth=1 "$CACHE" "$SHA"
git -C "$SOURCE" lfs install --local --skip-smudge
git -c core.hooksPath=/dev/null -C "$SOURCE" checkout --detach "$SHA"
# Standard LFS, reusing the already prepared object cache. No credential injection
# or network fallback. Missing/corrupt cache objects stop preparation for review.
git -C "$SOURCE" -c lfs.storage="$LFS_CACHE" lfs checkout
git -C "$SOURCE" -c lfs.storage="$LFS_CACHE" lfs fsck --objects "$SHA"
git -C "$SOURCE" lfs fsck --pointers "$SHA"
# fsck validates Git pointer blobs, not working-tree materialization. Check both.
git -C "$SOURCE" lfs ls-files > "$SOURCE/.git/lfs-materialization-check"
if grep -Eq '^[0-9a-f]+ - ' "$SOURCE/.git/lfs-materialization-check"; then
  echo 'LFS working tree still contains pointers' >&2; exit 1
fi
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$SHA"
test -d "$SOURCE/.git"
test ! -s "$SOURCE/.git/objects/info/alternates"
test -z "$(git -C "$SOURCE" status --porcelain)"
```

For repositories without LFS omit those three LFS commands. `lfs.storage` is a
temporary command override, not persisted in source config. Materialized files plus
standalone Git metadata are suitable Init input; this does not make the resulting
source an offline LFS object database. Future LFS operations need an authorized
cache/remote. `lfs fsck` can quarantine corrupt cache objects; use only the authorized
independent prepared cache, not a user's active checkout. Missing Git/LFS objects
require a separately authorized standard fetch of that fixed SHA, not a full clone,
a custom hydrator or a silent network/credential fallback. Do not copy global Git
config, credentials, dirty .env/.npmrc, external worktree pointers or alternates.

An independent clean source is not a credential-free attestation. Review authorized
tracked configuration by scope; never silently embed private feed tokens. Dependency
restore and private feeds are separate explicit work. Missing authorized access is a
blocker, not permission to inject credentials into Dockerfiles or logs.

## 3. Docker image: ordinary commands, separate context

Inspect/reuse the selected installed immutable image first:
`docker image inspect --format '{{.Id}}' "$IMAGE"` in the runtime's returned WSL
distribution. Source preparation and image building are independent. For a new image,
create an authorized separate minimal context containing the reviewed Dockerfile
(and a restrictive .dockerignore), then run:

```sh
set -eu
docker build --iidfile "$CONTEXT/image.id" --file "$CONTEXT/Dockerfile" "$CONTEXT"
IMAGE=$(cat "$CONTEXT/image.id")
docker image inspect --format '{{.Id}}' "$IMAGE"
```

Choose dev toolchains from the frozen source requirements. Do not copy the source,
Git metadata, host credentials or private feeds into a build context accidentally.
No automatic restore/smoke/build claim is made by resource registration. Use ordinary
exec background execution for long Git/LFS/Docker commands; preserve nonzero exit codes.

## 4. Official Init through the launcher

Read `v:skills/layerfs/sdk-init.mjs` and save that exact script to an absolute local
session-working `.mjs` path. It calls only official Init/status and baseline queries.
After preparing `$ROOT/repo-a`, obtain a new runtime_context with `sourceName:"repo-a"`.
Its returned Linux-absolute `sourcePath` is the exact Init argument, passed unchanged
to the official SDK. The owner probes that directory through existing controlled IPC
and a fixed read-only WSL Node command in the runtime's bound distribution.

Every Init dispatch rechecks owner/runtime/installation binding and all ancestor
realpaths, lstat identities, ext4 statfs type, root ownership and non-group/world-write
permissions. Symlinks, renamed/recreated directories, DrvFS even mounted at a native-
looking path, unknown filesystems, source substitutions and cross-distro UNC paths
fail closed. A denied probe never admits Init. Do not move/edit the source during Init.
This is scoped tool authorization, not an OS sandbox for root or arbitrary host exec;
there is no atomic lock against a privileged process replacing a path after the probe.
Upstream's scan/read Stamp checks remain intact. Do not normalize timestamps or relax
the upstream consistency checks to work around a refusal.

Using the exact executable/launcher returned by runtime_context, run ordinary exec
with shell=powershell (substitute resolved values, not guessed user paths):

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $EXE $LAUNCHER $SCRIPT $OFFICIAL_PROJECT $SOURCE_PATH $IMAGE $REPOSITORY_URL $COMMIT_SHA
exit $LASTEXITCODE
```

`$EXE/$LAUNCHER` are returned fields; `$SCRIPT` is the saved sdk-init.mjs;
`$OFFICIAL_PROJECT` is a new safe name; `$SOURCE_PATH` is the returned sourcePath.
The image, URL and SHA come from the independent Git/Docker steps.
Normal exec owns streaming stdout/stderr, exit code, background ID and cancellation.
The first output line contains the official job ID; subsequent lines are official
job states. Save that ID. Lost observation/cancellation is not rollback: inspect the
job with `runtime.project.get_init(id)` in another launcher script, never rerun Init.
The owner consumes a durable per-name admission before start_init and refuses replay.

For a tiny real SDK demonstration, in the same authorized WSL root Bash script:

```sh
set -eu
umask 022
# ROOT is returned sourceRoot; use a new NAME, e.g. tiny-<unique-suffix>.
SOURCE="$ROOT/$NAME"
test ! -e "$SOURCE"
[[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]
for DIR in / /var /var/lib /var/lib/shadow-layerfs-sources "$ROOT"; do
  if test ! -e "$DIR"; then mkdir -m 755 "$DIR"; fi
  test ! -L "$DIR"
  test "$(realpath "$DIR")" = "$DIR"
  test "$(stat -c %u "$DIR")" = 0
  MODE=$(stat -c %a "$DIR")
  test "$((8#$MODE & 022))" -eq 0
  test "$(stat -f -c %t "$DIR")" = ef53
done
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git init --template= "$SOURCE"
printf 'tiny LayerFS fixture\n' > "$SOURCE/README.md"
git -C "$SOURCE" add README.md
git -C "$SOURCE" -c user.name=LayerFS-Fixture -c user.email=fixture@example.invalid commit -m fixture
git -C "$SOURCE" rev-parse HEAD
```

Bind that NAME with runtime_context and use the returned Linux sourcePath in the
same sdk-init invocation. Use a discovered installed immutable image, a new official
project name, a clearly labeled fixture HTTPS repository URL and the printed SHA.
The fixture URL is provenance, not fetched. This is an executable live acceptance
entry, not a claim that real SDK/WSL ran in unit tests.

## 5. Register and use the immutable resource

The final sdk-init output supplies `layerfsProject`, `baselineRef`, `image` and source
provenance. Main is a **Layer**; do not infer the baseline from its empty commit history.
Call `layerfs_resource_register` with those fields plus `runtimeId` and `name`.
Registration checks official project initialization/image, Docker volume ownership
and existence via official runtime queries, then resolves the exact immutable Layer
through the agent SDK. Provenance is supplied metadata, not secretly fetched/attested.
It returns `revision`, the resource ID. No recipe or approval gate is involved.

`workspace_create {backend:"layerfs",source:"RETURNED_REVISION",idempotencyKey:"tiny-1"}`
forks that baseline and returns a registered workspaceId. Use it with ordinary
read/write/search/exec; inspect README, write a file, and run `exit 7` to verify nonzero
execution still checkpoints. Create a second workspace to verify isolation. Use a
new resource registration for a second official project/image; no active namespace
switch is needed. Read `v:skills/layerfs-manager` before assignment/publication.

A simple inspection script for the same launcher is:

```js
export default async ({open,args}) => {
  const client = await open(args[0]);
  try { console.log(JSON.stringify(await client.project.list_branches(100, 0))); }
  finally { await client.close(); }
}
```

History/merge/publish use the real SDK directly. Consult the pinned official agent
API for signatures; review receipts and conflicts. Do not mutate the same branch
concurrently through external SDK scripts and ordinary workspace tools. Publish only
when authorized; it updates LayerFS main, not source Git. No automatic Git merge-back,
worker reconciliation, old catalog migration or resource deletion is provided.
