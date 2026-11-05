# LayerFS Windows/WSL qualification — fixed upstream commit passes focused E2E

**Latest result (2026-11-05 03:57 UTC): PASS for the focused real Shadow tool
matrix on upstream commit `73d974dea8a8d0b056a16dc6b2380d89438ce484`, not for
release tag v1.1.0.** See the follow-up section below for pins, receipts,
configuration fixes and lifecycle limits. The earlier root restriction was
explicitly revised for an independent WSL root test worker; no system daemon,
Shadow production configuration, or upstream/Shadow source was modified.

## Historical first attempt — v1.1.0 blocked before mount

Date: 2026-11-05. Shadow source: `f5f1a118c0451636c4ab765810b5998b85fc953c`.
This is a **real upstream build and worker-start result, not a passing Shadow
end-to-end qualification**. No synthetic SDK replaced upstream. No production
Shadow configuration, Project data, source baseline, credentials, or running
Shadow process was changed. No commits or pushes were made.

## Result matrix

- PASS — Ubuntu WSL diagnosis: Linux uid 1000, ext4, `/dev/fuse` available;
  its own Docker Engine 29.1.3/API 1.52 was already active.
- PASS — official LayerFS `v1.1.0` source checkout, locked native release build,
  sealed Linux bundle, and manifest with artifact hashes.
- PASS — Windows Node 24.18.0 / official `@layerfs/runtime` starts an answering
  WSL worker using Linux Node 22.23.2, with no administrator/password operation.
- FAIL — actual `LayerFSTool.execute({action: 'create', ...})` at Store install:
  `Failed: Store install: the Store install runs as user 1000; it must run as
  user 0, the daemons' user, which opens only a Store it owns`.
- NOT RUN — fork/mount; ordinary `ReadTool.execute`, `WriteTool.execute`, and
  `ExecTool.execute` with `layerfs:` workspace; commit/history/load restoration;
  two-workspace concurrent isolation; dirty-close rejection; clean close.
  They depend on successful installation and are **not inferred from worker
  readiness, a build, or the pre-existing stub tests**.
- PASS — runtime gracefully closed after each attempt; final inventory found no
  worker entrypoint process and no Windows worker endpoint file.

The task boundary prohibited system elevation. On request, the parent explicitly
selected “do not allow a root worker; preserve evidence and stop as blocked”.
No root worker or `sudo` mutation was attempted. A prior `sudo -n true` diagnostic
only reported that a password would be required; no password was requested.

## Pins and artifacts

- Upstream: <https://github.com/Ephemeral-AI-Lab/layerfs>.
  Annotated tag `v1.1.0`: `80a973326887ed5c1d46a7dea0165b1529273c97`;
  dereferenced commit: `9f97a7ec95b662e9cb288704afa165feff132cfa`.
- Windows installation guide reviewed:
  <https://github.com/Ephemeral-AI-Lab/dsh-layerfs#windows-live>;
  research-time main: `b9bf3bc819b42007354f08c9444156188c4fbadb`.
  The guide defaults `wslUser` to root and requires a separate WSL Docker
  Engine, a sealed bundle, and a local Linux Store filesystem. Docker Desktop's
  Windows named pipe is not this worker route.
- Official Rust image: `rust:1.85.1-bookworm`, linux/amd64 manifest
  `sha256:bf7d87666c4da6eace19e06d21bc4859c6e2a5c97a21ac273b0e082112753cf0`;
  loaded config/image ID
  `sha256:ff51ccb0286798735d451f5ed56a4b501627a89a9cfd2aaa8afbf691f61bc82a`.
- Reused pre-existing official runtime image, no new runtime image pull:
  `node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`,
  Node 22.23.2 (meets the Windows guide's >=22.19 minimum).
- Bundle ID: `build-linux-818864cc52c6407894c919886c0cd9a3`.
- `layerfs-daemon` SHA-256:
  `659121ecc48a1ec5d87e78ed5f38c798399c2ee269f099f96f9a6ca2bbc6c026`.
- `layerfs.node` SHA-256:
  `ceacd0abe15efa66163816077814ea40b4bf7893a0dd7cb2419a42c5c7dbc69b`.

The tagged package layout is `api/agent/sdk/src/index.js`, not the earlier
`api/agent/src/index.js` example in `docs/layerfs.md`. The test selected the actual
tagged SDK entry. Existing integration code/docs were not rewritten in this task.

## Setup and command evidence

All checkout, dependency transfer, builds, and execution happened on CI010
Windows/Ubuntu, not Main. The independent Windows evidence directory is:

`C:\Users\ci010-4090\Workspace\shadow\.tmp\layerfs-e2e-20261105-0316-dfc1ef91`

The independent Linux ext4 directory is:

`/home/ci010-4090/layerfs-e2e-20261105-0316-dfc1ef91`

The initial `docker pull rust:1.85.1-bookworm` failed resolving Docker Hub through
the daemon's existing DNS/network route. No daemon/proxy/DNS setting was changed.
An HTTPS probe through the user's existing Windows proxy at localhost:7890
succeeded. A process-local HTTP(S)_PROXY was then used with pinned
`github.com/google/go-containerregistry/cmd/crane@v0.20.3` (Go module checksum
verification; Go fetched its required toolchain). `crane digest --platform
linux/amd64` resolved the official image; `crane pull` used that digest, followed
by `docker load`. Registry content digests were verified by the registry client.
The archive's locally measured SHA-256 is recorded in `rust-tar.sha256`; it is
not represented as a separately published upstream archive checksum. Imported
Docker tag: `rust:i-was-a-digest` (the import's tag, not a version pin).

The build used upstream tooling without source edits:

1. `python3 tools/worktree.py register --worktree <source> --root
   <test>/worktree-resources --owner shadow-e2e-dfc1ef91 --build-image
   <exact-image-ID> --runtime-image <exact-image-ID> --sandbox-image <exact-image-ID>`
2. `python3 tools/worktree.py prepare --resources <resources.json> --platform linux`
3. `python3 tools/worktree.py build --resources <resources.json> --platform linux
   --profile release --jobs 6`

The sealed manifest records the Cargo invocation (`--locked --offline`, daemon
and native addon only). Build log: release finished in 48.88 s. A created but
never-started node extraction container supplied `/usr/local/bin/node` to the
private test `bin/node`; no system Node installation was performed. Windows
`npm --prefix <test>/api install --ignore-scripts --offline` only linked the
upstream local workspaces.

The task-local `real.ts` called the actual Shadow tool classes, with a temporary
JSON config and credential-free baseline containing only `hello.txt` and
`.ignored-fixture`. Only `LayerFSTool.create` was reached; the remainder is an
**unvalidated draft harness**, not a reusable passing test. Do not rerun it
against the retained partial project automatically.

Three distinct setup attempts are retained in `receipts.jsonl`:

1. Windows `whoami.exe` resolved to Git's GNU executable; runtime start failed
   before a worker existed. Fixed only the test process PATH by prepending
   `%SystemRoot%\System32`.
2. Worker started, but Init refused a non-private test Linux home. Inventory
   showed the home/store empty before changing their task-owned modes to 0700.
3. Worker started and Init reached Store install, then refused uid 1000.
   This left `sealed.sqlite`, `project.record`, and `ownership.lock` in the
   private Linux home. The Store target remains empty. No replay followed.

Evidence files include `receipts.jsonl`, `build-manifest.json`,
`build-resources.json`, `build-evidence/` (Cargo logs and receipts), setup scripts,
`setup.log`, `diagnostic.log`, `fetch-build.log`, `build.log`, and
`final-inventory.log`. No worker secret/endpoint content is copied into reports.
The running download/build background attempts did not persist through the
remote execution boundary; the successful commands ran synchronously within the
120-second limit. Do not describe those failed launch attempts as live jobs.

## Retained resources and next step

No test resources were deleted (destructive cleanup was not authorized).

- WSL Docker service remains active as found; Docker Desktop service remains
  stopped. No service was started/restarted by this task.
- No worker remains running. No Sandbox was created.
- Created extraction container `layerfs-e2e-dfc1ef91-node` remains in `Created`
  state (ID prefix `22082db13a00`).
- Test Store volume `layerfs-e2e-dfc1ef91-store`: local bind volume, device
  `<Linux test>/store` on ext4, not `/mnt/c`.
- Upstream build cache volumes:
  `lfs-dev-source-5c57e369930d-cargo`,
  `lfs-dev-source-5c57e369930d-target`.
- Rust image, its transfer archive, pinned crane/Go cache, source checkout,
  build bundle and partial Init state remain. The Linux test directory used
  about 1.5 GiB at final inventory; Docker image/cache volumes are additional.

To continue requires an explicit revised authorization for the upstream-required
root WSL worker, with a newly scoped private root-owned test home/Store and a
fresh project name after inspecting this partial Init. That authorization was
not granted here. Alternatively upstream would need to support a non-root
Store-install/daemon topology. This result is an upstream deployment prerequisite
block, not evidence that Shadow's ordinary LayerFS routing works or is broken.


## Follow-up — official API negotiation fix, real Windows E2E

### Authorization and scope

The parent explicitly approved a narrowly scoped WSL root official worker and
new private test home/Store/project resources after the earlier refusal. A
second Docker daemon was declined: none was installed or started. The parent
then selected the official fix commit below and authorized one final fresh
project after a harness assertion error. No existing uncertain Init was replayed.
No source files under Shadow `src/` or upstream were edited. No commits/pushes,
system configuration changes, production Shadow configuration changes, or
Shadow restarts occurred. Only the opt-in task-local harness, build resource
records and this report changed. Existing resources were not deleted.

### Exact compatibility differences and corrections

1. v1.1.0 commit `9f97a7ec95b662e9cb288704afa165feff132cfa` with a root worker:
   real create and two forks PASS, mount FAIL. Its Rust Docker requests hard-code
   `/v1.54/`; existing Docker 29.1.3 supports API 1.44–1.52. Read-only
   `GET /v1.54/volumes/<test-volume>` returns HTTP 400 with
   `client version 1.54 is too new. Maximum supported API version is 1.52`.
   This is independent of the earlier uid1000 Store install refusal.
2. Official fix `73d974dea8a8d0b056a16dc6b2380d89438ce484` (PR #476, merge
   `4b5276216a2e9f780194a554ef9f0c33f9b6ba6d`) reads unversioned `/version`
   once and selects API 1.48–1.54, capped at 1.54. Below 1.48 is refused;
   unreadable version falls back to 1.54. It does not retry failed mutations.
   New sealed daemon/addon and matching SDK were built from this exact commit.
3. The old bind-backed local volume is **not supported** by the upstream
   `plain_volume` check: the fixed build reached HTTP 200 but rejected nonempty
   Docker volume Options (`Protocol("exact plain local VM volume")`). A new
   ordinary Docker local volume with no bind options solved this configuration
   error; Store path is its Linux `/var/lib/docker/volumes/<name>/_data/global/store.sqlite`.
4. SDK entry is version-dependent: tag v1.1.0 uses
   `api/agent/sdk/src/index.js`; the fixed commit uses `api/agent/src/index.js`.
   The first fixed-build bridge invocation failed module import before Init;
   correcting the test path allowed create. Do not prescribe one layout for all
   versions merely because their package version strings both say 1.1.0.
5. The draft harness wrote `printf concurrent-a` (12 bytes, no newline) but
   expected `concurrent-a\n` after restore. The first plain-volume test reached
   successful restore reads and failed only that assertion. Its subsequent
   read-only status found containers already stopped; it did not retry mount.
   Final verification used a separately authorized fresh project with the
   exact no-newline expectation, not a replay of previous successful mutations.
6. Test process PATH prepends `%SystemRoot%\System32` so upstream `whoami.exe`
   resolves to Windows SID reporting, not Git's GNU executable. Test Linux homes
   are root-owned 0700, as required by the official Store/worker design. No SDK
   permission checks were bypassed.

### Final real Shadow entrypoint matrix

Final command (Windows, repository root):
`pnpm exec node --import tsx .tmp/layerfs-e2e-20261105-fixed-b75311c8/real-final.ts`
with process-local System32 PATH precedence. Exit code: **0**.

- PASS — official `LayerFSRuntime.worker.start`: answering sealed Linux worker.
- PASS — `LayerFSTool.execute`: create, fork `a`/`b`, mount two workspaces.
- PASS — actual `ReadTool.execute({workspace: 'layerfs:…', path: 'hello.txt'})`:
  baseline is `baseline\n` (9 bytes).
- PASS — actual `WriteTool.execute` writes `branch-a\n`; actual ReadTool and
  ExecTool (`cat hello.txt`) each see exactly those 9 bytes; file change recorded.
- PASS — actual concurrent `ExecTool.execute` calls via `Promise.all` on distinct
  workspace handles: same relative `isolated.txt` becomes `concurrent-a` and
  `concurrent-b` respectively (12 bytes each); branch b hello remains baseline.
- PASS — commit checkpoint-a, history exposes exact checkpoint id; checkpoint-b.
- PASS — dirty close of b returns SDK code `Dirty` and lists `/isolated.txt`;
  subsequent status remains dirty, then explicit commit succeeds.
- PASS — clean close returns `Unmounted` for both original workspaces.
- PASS — load forks `restored` from checkpoint-a, mounts a third workspace;
  ordinary ReadTool sees `branch-a\n` and `concurrent-a` (no newline).
- PASS — restored workspace clean close returns `Unmounted`; original Windows
  baseline file remains unchanged. Final harness emits PASS and runtime-closed.

Project: `shadow-677b9d1b0c265a4742f9e893ccc4c7408703cb0f`.
Checkpoint-a: `122cd08fcf081e4ef17c51a10f93afd6c97e8a6d57e6e0cd729d9ae542037b722c`.
This is a credential-free fixture and in-process real tool-class test, not a UI,
provider-driven agent loop, production activation or broad upstream qualification.
Workspace close is unmount, **not Sandbox container deletion**.

### Fixed build identity and evidence

All paths below are on CI010 Windows, relative to
`C:\Users\ci010-4090\Workspace\shadow`:

- `.tmp/layerfs-e2e-20261105-root-b75311c8/receipts.jsonl`: tag/root create/fork
  success and API mount failure.
- `.tmp/layerfs-e2e-20261105-fixed-b75311c8/real-final.ts`: exact opt-in final harness.
  It is single-use: do not automatically rerun Init against this retained project.
- Same fixed directory `receipts-final.jsonl`: every actual management/ordinary
  tool receipt, expected Dirty refusal, three clean Unmounted receipts, PASS,
  live Docker container snapshot, runtime-closed.
- `receipts.jsonl`, `receipts-plain.jsonl`, `continue-plain.ts`: earlier failures
  retained separately; their FAIL records are not rewritten as PASS.
- `build-manifest.json`, `build-resources.json`, `build.log`: sealed build identity.
- `final-inventory.log`: post-run process/container/volume/disk/source inventory.
- Setup/export/build scripts remain under the root/fixed task evidence directories.

Linux source/artifact root:
`/home/ci010-4090/layerfs-e2e-20261105-fixed-b75311c8`.
Bundle: `build-linux-536fe3d9169c4f61b53bd8577e958c53`.
Daemon SHA-256: `aec83d7e35c08cfaa73129837912337ee659b03b950919a96fa4c824795cc90c`.
Addon SHA-256: `11f48047a28a086b28cc2fca7235447596df9eb1fd9b0455c8bb098a86520191`.
Build image and runtime image are the same exact image IDs recorded above.
New upstream-owned build cache volumes were created; the old Cargo cache was
copied read-only into the new Cargo volume, preserving upstream ownership checks.
An attempted direct old-volume reuse was rejected by those checks before build.

Final live Docker snapshot, before runtime close: three running genuine Sandbox
containers with project labels and loopback ports; IDs begin `cc17d5cd4724`,
`69c5470949eb`, `7ee1bd2bb8dd`, all using runtime image
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
All mount the new plain volume `layerfs-e2e-final-b75311c8-store` at `/layerfs-store`.

### Retained resources and lifecycle limitation

Inventory at 03:57:30 UTC found **no node/LayerFS worker or daemon processes** and
no endpoint.json files in the scoped Windows evidence directories. All six
Sandbox containers (three earlier plain + three final) remain as stopped Docker
objects, `Exited (255)`, OOMKilled=false. The final containers were running in
harness evidence, then all finished at approximately 03:57:24, after worker/runtime
close. The cause of their later stop was not established; persistent Sandbox
survival across WSL/runtime lifetime is **not qualified** and must not be inferred
from the focused PASS. No forced stop, restart, re-mount or deletion was attempted.

Also retained: prior extraction container (Created), cache-copy container (Exited
0), existing rust/node images, build artifacts and dependency caches. Five test
Store volumes remain: `layerfs-e2e-dfc1ef91-store`,
`layerfs-e2e-root-b75311c8-store`, `layerfs-e2e-fixed-b75311c8-store`,
`layerfs-e2e-plain-b75311c8-store`, `layerfs-e2e-final-b75311c8-store`.
Four build cache volumes remain: `lfs-dev-source-5c57e369930d-{cargo,target}` and
`lfs-dev-source-c963e5e3efd0-{cargo,target}`. Linux directory sizes are 1.5 GiB
(original), 236 KiB (tag/root), 236 MiB (fixed); Docker volumes/images are additional.
No cleanup authorization was assumed. Remaining operator decisions are whether
to adopt this fixed upstream commit for deployment, investigate post-worker WSL
Sandbox lifetime, and separately authorize scoped resource cleanup. No production
LayerFS configuration has been activated by this test.
