# LayerFS integration

Shadow's optional LayerFS backend is a **thin host integration**, not a repository
preparation/build pipeline. It uses the pinned official `@layerfs/runtime` and
`@layerfs/agent` APIs. Installation is optional and separate from source images.

## Boundaries

Shadow owns:
- Explicit installation consent and necessary single-owner runtime lifecycle.
- Immutable current-Project resource registrations and workspace creation/forking.
- Ordinary read/write/search/exec routing to registered branch-backed workspaces.
- Durable overlapping-operation exclusion and unknown-receipt protection.

Agents use ordinary exec and skills for fixed Git checkout/LFS, Dockerfile/build/
inspect, and standard official LayerFS Init, branch/history/diff/merge/publish calls.
There is no template plan/prepare recipe engine, source archive/blob repair, custom
LFS hydration, image builder, recipe approval or pipeline phase catalog. Obsolete
namespace/import/baseline/legacy mount repair dispatch is removed. Existing private
resources are not deleted or migrated; old template catalog records are not loaded
as new resource registrations. No compatibility conversion is attempted.

## Public contracts

Installation: `layerfs_doctor`, `layerfs_setup`, `layerfs_bootstrap_plan`,
`layerfs_bootstrap`, `layerfs_bootstrap_status`. Initial install/download/root-worker
consent remains host-verified; an agent task or a boolean alone does not authorize
bootstrap. Existing approved installation artifacts can be reused.

Runtime: `layerfs_runtime_plan`, `layerfs_runtime_start`, `layerfs_runtime_status`,
`layerfs_runtime_context`. Plan/start are routine artifact reuse, with no second
approval object. They require the direct owner authority boundary. The original
owner session can call `layerfs_runtime_start` again on the same runtime after a
confirmed normal worker stop (including a clean backend close/reopen). Concurrent
starts are exclusively admitted; running starts are refused without dispatch.
Starting, uncertain, unknown or crash-retained leases are not treated as stops and
are never replayed or cleared. Historical one-shot admissions remain untouched.
No cross-session ownership transfer is supported; resume the original session.

Runtime status separates `recordPhase` (saved configuration/start receipt) from
`phase` and `ready` (observed worker readiness). A saved `ready` record with a
normally stopped worker reports `phase: stopped`, `ready: false`, and
`next: layerfs_runtime_start`. Status, SDK context and ordinary resource operations
never implicitly start that stopped runtime. Initial installation consent is
unchanged; clean restart reuses the approved installation and retained home.

Resources: `layerfs_resource_register`, `layerfs_resource_list`,
`layerfs_resource_inspect`. Registration input:

```
{name, runtimeId, layerfsProject, baselineRef, image,
 source: {repository, commit}}
```

The catalog adds a UUID `revision` (the resource ID) and owning `projectId`. The
repository URL is credential-free HTTPS; the commit is a full SHA and image a
`sha256:` ID. Source provenance is supplied metadata, not a covert fetch or source
attestation. A registration has no recipe, verification checklist or build phase.

Before registration, the runtime queries official project metadata and checks the
selected name, initialized state, image and volume. Official volume inventory must
report the same volume/project with `owner:"this"` and `live:true` (home membership,
not running-container state). The agent SDK resolves the exact immutable baseline.
No smoke command defines resource readiness. Missing/foreign/changed resources fail
closed. Multiple projects/images and runtimes coexist without an active namespace.

`workspace_create {backend:"layerfs",source:RESOURCE_ID,...}` forks the immutable
baseline and returns a normal registered workspaceId. `workspace_fork` inherits the
selected workspace's exact resource/branch, refusing a foreign baseRef. A version 3
binding identifies owning Project, runtime, resource ID, official project and branch.
Only identities minted by the resource service route ordinary operations; manually
changing an encoded branch does not mint another workspace. Host filesystem paths
and old mount IDs are not LayerFS cwd values.

## Executable SDK access

Canonical executable instructions and the tiny live fixture entry are in
[`src/skills/builtin/layerfs/setup.md`](../src/skills/builtin/layerfs/setup.md) and
[`sdk-init.mjs`](../src/skills/builtin/layerfs/sdk-init.mjs). Scenario navigation:
`v:skills/layerfs`, `layerfs-worker`, `layerfs-manager`, `layerfs-setup`.

The runtime owner gets a private launcher from runtime_context. Returned parameters
include the actual executable/launcher paths and WSL distribution/Node, not endpoint
secrets. An ordinary local script exports `default async ({runtime,open,args}) => ...`:
- `runtime.project.list/start_init/get_init` delegate directly to the one already
  running official Runtime owner. Init receives an explicit source/image/timeout;
  runtime_context binds `sourceName`, one child of its returned dedicated native
  `sourceRoot` (`/var/lib/shadow-layerfs-sources/<project-runtime-hash>`). This is
  a typed runtime source scope, not a new workspace platform or global UNC exception.
  The existing owner IPC runs a fixed read-only WSL Node probe in the bound distro.
  Before each Init it rechecks owner/installation plus every ancestor's canonical
  path, device/inode identity, root ownership, protected permissions and ext4 statfs
  type. Linked/rebound directories, DrvFS/9p/unknown filesystems and arbitrary or
  cross-distro paths fail closed. The script scope remains the exact Linux absolute
  path; only the owner maps it to same-distribution WSL UNC for the Windows host API.
  No volume/import implementation is copied into Shadow.
- `open(project)` opens the actual agent SDK in that exec process with checked
  configuration, one client/project per process. Scripts close it in finally.

The existing Node child IPC is parent-only, so unrelated exec processes cannot use
it. A small per-runtime bearer-authenticated ephemeral 127.0.0.1 adapter supplies only
those official methods and checked configuration. It has no arbitrary server-side
module/path/eval operation, worker restart, resource deletion, Git or Docker command
router. The private launcher holds its capability; its contents must not be logged or
copied to sandboxes. Owner shutdown closes the listener. This is same-user capability
separation, not an OS sandbox against a program already able to read host-user files.

Ordinary exec owns output, stderr, exit codes, wait/background lifecycle and cancellation.
Official job IDs/states are visible. A durable exclusive per-project-name Init admission
prevents replay if the caller loses a receipt; it is not a pipeline/retry state engine.
Lost observation is unknown, not cancellation of the official job or rollback. A new
exec script may inspect get_init(jobId); it must not start the same Init again.

## Ordinary tools and concurrency

Reads/search use official committed-state fs APIs; UTF-8 reads are bounded, complete
within the requested window, and reject clipped or changing snapshots. Binary input,
encoding conversion and regex grep parity are not provided. Writes overwrite or
exact-unique edit and checkpoint immediately. Append/global replacement are unsupported.

Exec mounts the current branch, runs sh/bash, checkpoints even on a nonzero command
exit, unmounts without discard and closes its sandbox. Nonzero remains a tool failure.
Cancellation/unknown receipts retain evidence rather than pretending to roll back.

Independent branches can overlap. Branch reservations include all affected refs and
are scoped to runtime plus official project. Crash-safe coordination retains exact
owner/phase/receipt evidence; publication receipt validation and conservative native
mount ownership checks remain. Do not mutate a branch concurrently through external
SDK scripts and ordinary tools: host journals are not a cross-client transaction.
Do not clear unknown journals/locks or infer a sandbox owner from its number/path.

## Verification and limitations

Focused tests include the real owner IPC/launcher/bridge against **synthetic official
API fixtures**: two project/image registrations, foreign volume/image/ref rejection,
Project isolation, forged workspace rejection, baseline fork/read, explicit stderr/
nonzero exit and repeated/lost Init refusal. Existing branch lifecycle tests cover
nonzero checkpointing, cancellation/unknown no-replay, parallel branches, crash-safe
coordination and publication receipt validation. Electron launch tests exercise the
compiled helper's Node-mode contract. These are not real SDK, Docker or image tests.

For live acceptance, an authorized Windows/WSL installation and running single-owner
runtime are needed. Obtain runtime_context without sourceName to discover sourceRoot;
prepare a new root-owned native ext4 source there with ordinary Git/LFS commands in
the returned distribution, then bind its sourceName. The skill supplies executable
fixed-SHA cache-reuse commands and a tiny native fixture. Windows checkouts are kept
unchanged and used only as explicitly authorized Git/LFS object caches, never Init
sources. No automatic copy, host config import, giant clone, custom hydrate/tar or
Git/Docker recipe pipeline is introduced. The source area is independent of the Store.
Do not repair existing ownership/mode problems by silently chmod/chowning user files.

Run sdk-init through the returned launcher, register its official baseline and
create/read/write/exec a workspace. Then validate the independent real repositories,
images and actual build commands. Dependency restore/private feeds are separate work.
The [pinned runtime documentation](https://github.com/Ephemeral-AI-Lab/layerfs/blob/73d974dea8a8d0b056a16dc6b2380d89438ce484/api/docs/runtime.md#L126-L129)
specifies a WSL2 worker; the [upstream path adapter](https://github.com/Ephemeral-AI-Lab/layerfs/blob/73d974dea8a8d0b056a16dc6b2380d89438ce484/api/runtime/src/worker/server.js#L79-L89)
accepts Linux absolute paths and same-distribution UNC. However, the
[pinned host Init API](https://github.com/Ephemeral-AI-Lab/layerfs/blob/73d974dea8a8d0b056a16dc6b2380d89438ce484/api/runtime/src/project/init.js)
first uses host `isAbsolute`, `existsSync`, `statSync`, then recursively scans with
`opendir`/`lstat`. Linux-only paths are not sufficient for that Windows host check.
Shadow maps only the already-authorized Linux binding to `\\wsl.localhost\<bound-distro>\...`
at the owner-to-official-API boundary; the official worker maps it back to Linux.
Caller UNC inputs remain refused; there is no workspace/global UNC exception or
DrvFS fallback. Host scanning over UNC has filesystem-bridge overhead and requires
the UNC user's Linux read/traverse permissions, independent of the root probe.
Do not change source permissions or skip upstream scanning to mask a refusal.
A pre-job failure can leave no official job ID; the consumed admission stays retained.

Source preparation requires the human's authorization for the dedicated runtime
source area; a sourceName or agent boolean is not initial installation consent.
The direct owner can scope exactly one prepared child for each launcher; old
sourceWorkspace inputs are refused rather than falling back to DrvFS. Scope checks
are not an OS sandbox: privileged root/host exec can race or alter directories after
a probe. Keep sources quiescent during Init; upstream scan/read consistency checks
remain unchanged. Synthetic tests exercise the scope and IPC boundaries, not live
WSL filesystem behavior, Git/LFS transfer or real repository builds.

An Init `entry changed while Init read it` refusal does not by itself prove a
content edit. Upstream compares device, inode, length, mode, mtime and ctime,
including nanoseconds, across scan and file reads. A local synthetic DrvFS probe
observed ctime changing across a read-only open while the other fields stayed
unchanged; this is mechanism evidence, not attribution of any real Init failure.
Keep the consistency check intact and retain the failed job evidence; do not retry
Init, normalize timestamps or substitute a source without explicit authorization.
The launcher explicitly reports script/import errors to stderr and sets exit code 1;
its real Node/Electron subprocess tests do not establish the status of a real SDK job.
Remote execution parity, UI/Git routes and scoped skill/MCP behavior remain separate
unfinished boundaries. No automatic Git merge-back or resource removal is provided.
LayerFS is not a backup system or universal security sandbox.
