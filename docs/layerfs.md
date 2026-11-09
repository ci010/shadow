# Optional LayerFS 1.1 integration

Shadow includes an opt-in dynamically imported `layerfs` tool and the builtin
`layerfs` skill. It does not ship or install the LayerFS SDK, native addon,
Linux daemon, runtime image, Docker, worker or WSL. This is a real SDK bridge,
not a file-copy snapshot implementation. No npm dependency was added. Windows can
now connect an explicitly approved existing installation through managed setup;
Shadow owns configuration and worker lifecycle without an environment variable or
backend restart. A first-run approval-gated source bootstrap now acquires/builds
the pinned runtime automatically on a supported existing Windows/WSL environment.
OS/WSL/Docker installation remains separate.

## Operator prerequisites

Upstream: [Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs).
The source `api/agent/package.json` currently identifies `@layerfs/agent` 1.1.0
as **private** (GitHub API inspection at commit
`35d36575c1eb4d23d4b54534a7030d855db890e7`, 2026-11-04); a source guide is not evidence of an npm release or a working
local installation. Build/install upstream artifacts separately following its
current guide and licensing. Select the actual built JS entry (`api/agent/src/index.js`
in that source layout), not an arbitrary module suggested by a model.

- Linux Store calls require Linux and a supported local shared filesystem
  (ext4/xfs/btrfs); a network filesystem or macOS filesystem is not a Linux Store.
- macOS requires Docker and the upstream provisioned Linux worker endpoint.
- Windows requires the upstream WSL worker route and its configured distribution.
- Sandbox Docker Engine must satisfy upstream's API requirements (1.48+ in 1.1).
- Provision a separate private LayerFS home, Store path and volume per Shadow
  Project. The adapter rejects identical configured home/Store/volume strings
  across Projects; operators must also avoid filesystem aliases to shared data.
- For operator-environment mode, provision the image, volume, daemon and worker
  before calling this tool. Managed Windows setup uses `@layerfs/runtime` to start
  an approved existing installation; managed create allocates its labeled volume.
  The approval-gated bootstrap can build/stage the pinned SDK; no mode installs
  OS/WSL/Docker prerequisites or exposes project removal.
- Use a plain Docker local volume with no bind-driver options. The tested upstream
  rejects bind-backed volumes even when the backing directory is on ext4.
- The tested Windows Store installer requires the official WSL worker to run as
  uid 0, matching the daemon's Store ownership. This requires explicit operator
  authorization; the Shadow adapter does not elevate privileges.

### Verified Windows compatibility (2026-11-05)

Focused real Windows/WSL tests passed on official upstream commit
`73d974dea8a8d0b056a16dc6b2380d89438ce484`, using matching SDK, daemon and sealed
addon bundle, Docker 29.1.3/API 1.52, an authorized root worker and a private plain
local volume. Verified: create/fork/mount, ordinary Shadow read/write/exec,
concurrent workspace isolation, commit/history/load restoration, dirty-unmount
refusal and clean unmount. This is not a qualification of crash durability,
large-workspace performance, merge/publish, or cross-worker/WSL lifecycle survival.

Release tag v1.1.0 (`9f97a7ec95b662e9cb288704afa165feff132cfa`) hard-codes Docker
API 1.54 and failed mount on that Docker server. The fixed commit above negotiates
API 1.48–1.54; do not identify compatible builds by the package version alone.
SDK layouts differ: the release tag uses `api/agent/sdk/src/index.js`, whereas
that fixed commit uses `api/agent/src/index.js`. Select the entry from the pinned
checkout and keep the SDK/native bundle matched. Mac qualification is separate;
Windows success is not evidence that the Mac deployment works.

### Mac/OrbStack qualification (2026-11-05): partial failure

Real tests on OrbStack 2.2.5 / Docker 29.8.2 (API 1.56), pinned release commit
`9f97a7ec95b662e9cb288704afa165feff132cfa`, verified ordinary Shadow read/write/exec,
concurrent workspace isolation, checkpoints and historical-byte recovery. However,
new sandbox connections intermittently failed with `ECONNREFUSED` after daemon
LISTEN, and two saved clean workspaces failed unmount with retained FUSE teardown
custody at stage Join. A diagnostic restore into an existing sandbox succeeded;
it is not a passing end-to-end test of the tool's new-sandbox mount route.

The cause of the connection failures is not established; forwarding readiness is
only a hypothesis. The Windows API-negotiation fix does not change the checked
create/unmount/fuser lifecycle implementation. Do not treat OrbStack deployment
as stable or automatically retry these failed operations. See
[layerfs-e2e-macos-20261105.md](layerfs-e2e-macos-20261105.md) for evidence, retained
resources and unresolved lifecycle boundaries.

Restart investigation corrected a historical path-search omission: official
`35d36575c1eb4d23d4b54534a7030d855db890e7` (#500) fixes stalled normal unmount
under the relocated engine paths. That official build still reproduced a fresh
sandbox connection failure on this Mac. A matching **patched upstream** build
with explicit `LAYERFS_DAEMON_HOST=docker-bridge` then passed four fresh Projects,
12 new-sandbox mounts and 12 clean closes. This is a same-Engine default-bridge
qualification, not readiness of the unpatched release or the running Shadow
service. No production configuration was activated. The environment key is
already accepted by Shadow; installing the matched patched bundle and private
worker/Store remains an operator prerequisite. Patch, pins, harness and durable
receipts: [Mac restart repair](layerfs-e2e-macos-restart-20261105.md).

For the alternative **operator-environment mode**, set `SHADOW_LAYERFS_CONFIG`
in the Shadow backend's environment to an absolute
operator-owned JSON file, outside model-editable workspaces. Do not put credentials
in it. The model cannot select SDK modules, environment variables or source paths.
Example (replace placeholders with an actual, separately provisioned installation):

```json
{
  "projects": {
    "YOUR-SHADOW-PROJECT-ID": {
      "sdkModule": "/opt/layerfs/api/agent/src/index.js",
      "env": {
        "LAYERFS_HOME": "/private/operator/layerfs-project-a",
        "LAYERFS_STORE_PATH": "/layerfs-store/global/store.sqlite",
        "LAYERFS_VOLUME": "operator-provisioned-project-a-store",
        "LAYERFS_IMAGE": "sha256:REPLACE_WITH_REAL_IMMUTABLE_DIGEST",
        "LAYERFS_DAEMON": "/opt/layerfs/layerfs-daemon"
      }
    }
  }
}
```

On macOS/Windows also set `LAYERFS_WORKER_ENDPOINT`; Store paths then refer to
the worker's Linux filesystem, not the host. Complete platform settings must come
from the upstream installation, not this illustrative example. The exact allowed
keys are `LAYERFS_HOME`, `STORE_PATH`, `DOCKER`, `IMAGE`, `VOLUME`, `DAEMON`,
`NATIVE`, `WORKER_ENDPOINT`, `CONTAINER_PREFIX`, `DAEMON_HOST`, `STORE_POLICY`
(all prefixed `LAYERFS_`). Other keys are refused. Inherited `LAYERFS_*` variables
are stripped from each bridge child before explicit Project settings are applied.
Other normal host environment variables remain inherited; the child is not an OS
security sandbox. SDK singleton state is confined to that child.

Legacy SDK project names are deterministic: `shadow-` plus the first 40 hexadecimal
characters of SHA-256 of the Shadow Project ID. Operator mode retains that naming.
Managed import quarantine selects a new generation: its SDK project name hashes
the Project ID plus the generated namespace ID, with distinct host/Linux homes and
container prefixes. Tool routes resolve the active generation and pin its identity;
old mount IDs cannot alias a newly imported Store. `create` explicitly calls `LayerFS.init`; subsequent
operations call `LayerFS.open` and never reacquire/overwrite source. Source is
resolved only through the host's authorized registered local workspace selector
with the existing `filesystem.read` operation. This authorizes selecting the source
workspace, not a new remote grant. Init recursively reads the entire selected tree,
including dotfiles and untracked files: use a curated credential-free source. This
adapter does not implement ignore rules or a content credential scanner.
`import_preview` enforces a metadata/name preflight before `create` with an explicit
`importPolicy`: `curated` (default) rejects VCS/dependency/build entries as outside
its scope, not as secrets; `whole_tree` includes and recursively reviews those
entries, with warnings. Neither policy filters the source: any blocked or incomplete
scan refuses import, because upstream Init reads the entire tree with no ignores.
Use `whole_tree` on both preview and create to include `.git`, `node_modules`, etc.
Git history, configuration and dependencies require human content review too.
Both policies block symlinks, private runtime/credential/key artifacts (including
`.shadow`, `.ssh`, `.env` and key material), unreadable entries and unbounded scans.
Credential-related source directories such as `src/credentials` warn and are
traversed, not skipped. Code/docs/assets inside can be reviewed; non-code data inside
those directories remains blocked, as do explicit credential artifacts anywhere.
Names are not a content scanner. Review a separate curated baseline if the original
contains blocked artifacts; never silently omit files from preview then import them.
The owner must pass the single-use `sourceReview` plus `sourceReviewed:true` after
content review. Tokens bind session, resolved source and policy, expire in 15 minutes,
and require a matching metadata rescan. Repeat the preview policy on create;
changing it (including omitting `whole_tree`) requires a new preview. A preview is not a secret-free certification or immutable snapshot; the
original checkout must not be deleted/modified merely to make preview pass.
Remote targets fail without fallback. SDK home ownership checks remain upstream.

## Fresh-session automatic bootstrap

Acceptance goal: the unchanged parallel-development prompt in a fresh session
must not require a human to supply SDK paths, image IDs, JSON or environment
variables. `connect` now returns an automatically discovered first-run plan when
there is no approved installation. `bootstrap_plan` inventories WSL distribution
names only; it does not start root code or download artifacts. A unique eligible
distro is selected; ambiguous choices need only a distro name. Docker Desktop's
internal distributions are excluded.

The owner approves the exact plan once, including pinned downloads/source build,
root execution in the selected WSL distro, potentially several GiB/lengthy build,
retained private resources and subsequent runtime reuse. `bootstrap` requires the
session-bound plan, `approved`, `allowRootWorker`, `allowDownloads` and the
`approval` reference returned by ask. The agent passes the exact plan-generated
question/options to ask; admission verifies the stored human answer, origin,
question/options and uninvalidated status through the owning SessionManager.
Model booleans alone, parent/time-out/custom/deferred answers or linked unrelated
decisions cannot authorize bootstrap. It accepts no source URL, script, image or
installation path from the model. Plans expire
after fifteen minutes. Setup is a Project background task with a `bg:` handle,
normal cancellation/inspection and a completion callback to the originating
session, instructing it to continue the original task rather than stop at setup.

The fixed recipe downloads the public MIT upstream source at
`73d974dea8a8d0b056a16dc6b2380d89438ce484`, uses pinned official rust/node images,
and runs official `tools/worktree.py register/prepare/build`. It verifies source
revision, image platform/digest, sealed manifest and file hashes; retains license
notices; extracts private Node; stages matching host APIs/shims; and automatically
registers/connects the resulting installation. No backend restart is needed.
The pinned Windows identity-read path needs a byte-identical host-only mirror
under `api/node_modules/@layerfs/src`; original shims and API module identity are
preserved and the sealed Linux bundle is never modified.

Supported recipe: Windows x64, existing x86-64 WSL2 distro, Python >=3.9, git,
FUSE, supported local filesystems and rootful Docker API >=1.48 at the default
`/var/lib/docker` data root. The Bookworm build conservatively requires glibc >=2.36.
Privileged preflight checks precede downloads/resource allocation, after consent.
The recipe does not install OS packages/WSL/Docker, reconfigure daemons or networking,
change TLS, or import OfficeAgent. Missing platform prerequisites produce bounded
machine-readable refusal codes rather than fabricated install/download success.

A durable journal records background ownership and phase. A definite preflight
refusal allows a newly approved plan after correction. Any failed/unknown build,
cancellation or crash retains artifacts and blocks blind retry.

WSL startup and path conversion now have separate no-input probes: `/bin/true`
with a 120-second startup budget, then `wslpath` with 30 seconds. Ignored stdin
avoids spurious empty-pipe failures. The command runner retains bounded stdout/
stderr and differentiates timeout, cancellation, spawn/stdin error, signal exit
and normal nonzero exit; status exposes safe elapsed/deadline/exit/launcher data,
not native output. Private per-step logs survive failures as well as successes.
If a log cannot be written, `evidenceWriteFailed` reports that gap without masking
the original command/refusal code. Manual setup, bootstrap (including its background
lifetime) and recovery share a Project setup-ownership guard.

The journal persists `provisioningStarted:true` **before** dispatching the source
build. Terminal earlier failures are `probe_failed`, not evidence of an uncertain
installation. WSL itself may have started services; this is not a no-OS-effects
claim. `bootstrap_recover` takes the exact failed execution ID, enforces local
owner context, verifies the pre-build boundary/launcher closure/absence of build
artifacts or an installation, and archives the prior journal before marking it
recovered. Legacy terminal `resolve_paths` records additionally require a
read-only inventory showing the distro stopped. It never deletes state, terminates
a distro, retries a command or launches provisioning. Running work, unconfirmed
launchers and dispatched builds are refused. A recovered attempt can receive a
fresh plan/approval; prior attempt history is preserved when a new one is admitted. Native output is
bounded and retained privately, not returned to the model. `bootstrap_status`
reports historical setup state, never current runtime health. After successful
bootstrap, normal connect/branch tools continue the original work with the same
managed service. Live provisioning and the actual fresh-provider-session acceptance
remain to be qualified; synthetic tests do not establish that result.

## Managed Windows setup and reuse

`layerfs {action:"connect"}` is the everyday entry. Without a saved approved
installation the owning runtime returns a bootstrap plan; discovery starts no
root code. The advanced existing-installation path remains available: after
explicit owner consent, `setup` accepts `approved:true`,
`allowRootWorker:true` and an `installation` object containing:

- `apiRoot`: absolute host root with the matching `api/agent/src/index.js` and
  `api/runtime/src/index.js`, package metadata and module-resolution shims;
- `bundle`: absolute sealed Linux bundle path in the chosen distribution;
- `distribution`, absolute Linux `node`, and installed `image` ID (`sha256:…`).

The supported API contract/layout is pinned to commit
`73d974dea8a8d0b056a16dc6b2380d89438ce484`. Setup requires a direct durable local
owner Web session, not tasks, scripts, borrowed tools or a recovered tool call.
The installation is trusted executable code selected with human approval; package
names and the upstream sealed manifest do not establish publisher authenticity.
No SDK/environment module path is chosen incidentally on an ordinary operation.

Shadow persists the approved choice under Project config `layerfs-managed.json`.
It derives a private host runtime directory, a Linux home keyed by Project ID and
Project Home, and a unique container prefix. No manual Store/volume paths, parent
environment mutation or backend restart are needed. A separate long-lived helper
calls `LayerFSRuntime.open` with `sweep:false` and starts the root WSL worker.
It reports worker/Docker health without secrets; `ready:true` does not qualify
sandbox behavior, and `sandboxVerified` remains false. Both managed and one-shot
SDK helpers explicitly set `ELECTRON_RUN_AS_NODE=1` in their child environment:
the desktop utility backend removes that flag, but its `process.execPath` still
points to Electron. Omitting it launches Electron instead of the Node helper and
can leave IPC requests waiting until their deadline. The parent environment is
not changed. Synthetic launch tests cover plain Node and Electron without a real
WSL worker or SDK.

Managed `create` uses the official `project.start_init/get_init` job API and,
in the owning Project runtime, returns a background task handle promptly. Its
completion event—not task admission—confirms the initialization result. Background
import admission is restricted to the direct durable owning session: tasks, leaf
calls, nested scripts, borrowed tools and recovered calls are refused before the
review token is consumed or any work starts. The
runtime creates a labeled plain local Docker volume and retains its own Project
record. `import_status` reports allowlisted stage, job ID, counts and failure code,
including safe classification of older retained SDK `Project(Deadline)` records.
Raw native diagnostics may contain catalog keys and are never returned by this path.
For the pinned native `project.init refused <path>: <reason>` message only,
status can additionally project `refusal` with an allowlisted reason and bounded
source-relative ASCII path (and four octal digits for Mode). Upstream `jobs.js`
drops structured detail; unrecognized messages, cleanup suffixes, out-of-source
paths and unsafe names deliberately yield no refusal detail. This is not a
promise that every native failure remains diagnosable.

### Windows import staging

Managed Windows drive-letter sources are copied before `start_init` into an
exclusive mode-0700 Linux ext4 envelope under `/var/tmp`, keyed to the managed
namespace plus a fresh random suffix. The original source is not edited. The
Windows Runtime scans its same-distribution `\\\\wsl.localhost` UNC path; the
existing native worker translates that path and imports Linux-native files.
This avoids the observed DrvFS read-open ctime change without modifying upstream
FileStamp/Changed checks or the sealed installation. Managed UNC/non-drive source
imports currently fail closed; explicit operator/native routes are unchanged.

The fixed helper runs the approved Node executable as the distribution's default
user (which may be root), never a model-selected command or shell. That user must
be able to execute this Node binary and read the reviewed source. An inaccessible
binary, non-ext4 staging location or failed/unknown copy blocks Init, with no
fallback to reading DrvFS. It copies every approved entry under the exact consumed
review source and policy, including `whole_tree` dependencies/VCS/build data;
credential-name rules remain enforced. Links, special files, hardlinked regular
files and unsupported permission bits are refused. Per-file identity/size/mtime
checks and a second whole-tree content-hash pass detect instability; only atime
and ctime are excluded from these staging comparisons. The existing review guard
is unchanged. This remains a mutable-source check, not an immutable snapshot or
an adversarial filesystem sandbox: same-user/root mutation and path races are
not eliminated. File contents are unchanged; copied timestamps use Node's
available precision, and portable permission bits are preserved inside the
private envelope.

Allow additional Linux disk space for a full copy plus the Store (no automatic
staging deletion), two full source reads, and up to ten minutes of cooperative
staging work before the separate SDK Init budget. Staging is capped at 100,000
entries including root, depth 128 and 16 GiB regular-file bytes. A 615-second
launcher watchdog bounds observation, not proof of Linux helper termination.
Cancellation stops observation; copy/native work may continue. Successful,
partial and unknown attempts are retained, never silently reused/replayed.
The namespace-keyed staging envelopes remain operator-inspectable in `/var/tmp`;
failed/unknown imports still require the existing approved quarantine workflow,
which does not delete these envelopes. These changes have synthetic test coverage;
real managed Init and Windows/WSL end-to-end operation are not claimed verified.

`importTimeoutMs` is the single import budget (default 300000 ms, range
1000–1800000), validated by one shared policy and passed unchanged to the SDK in
both managed and operator modes. The managed runtime's preparatory counting pass
precedes this budget; native scanning and construction share it. Native deadline
checks are cooperative, so completion/unwind can occur after the nominal budget.
Shadow does not impose a competing import wall-clock timeout: both the old
330-second cutoff and the budget-plus-15-minute observation cap are removed.
Managed progress heartbeats and operator-bridge IPC heartbeats renew a 90-second
helper-silence watchdog. They attest only helper liveness, not native progress or
completion. A live but stalled native operation can remain observed until its
own result or explicit cancellation. Silence/disconnection/cancellation means
unknown effects, not `ImportDeadline`, rollback, or permission to retry; stopping
an operator bridge does not prove that the worker stopped native work.
Progress and terminal observations are retained privately in `import-state.json`;
any prior import attempt and uncertain worker marker block reimport.

Health and import-status IPC bypass the mutation queue. While a mutation is active,
health returns `health:"not_checked"`, unknown worker/Docker values and import
progress rather than inventing a failed health check. Idle health probes are bounded
and single-flight. These diagnostics never reset retained state or initialize a
worker. Subsequent isolated bridge processes get their environment from that
record and the private worker endpoint. Ordinary read/write/exec and dedicated
LayerFS calls share the owning Project service. Session sleep/reset does not
stop it. Project startup failure and normal shutdown both gracefully close it,
after agents quiesce in normal shutdown. Clean shutdown allows on-demand reuse of
the saved choice on the next backend instance.

`runtime_status` inspects saved/current state without starting code. An unresolved
worker start, lost reply, failed Windows Init, or failed graceful close leaves a
durable uncertain/ownership marker, blocking automatic restart and reimport.
Inspection is allowed; blindly clearing journals or retrying is not.

`bootstrap_recover_connection` is a narrow owner-approved exception for the
original `uncertain/connect_worker` bootstrap with a retained completed build.
It requires the exact execution ID, explicit approval/root-worker consent,
matching saved installation, absent SDK host runtime directory, no retained
managed helper, and valid installed/running WSL inventories proving the selected
distro is stopped. It archives the original bootstrap/worker evidence and writes
`recover_connect_worker` before one launch, never exposing a reusable `stopped`
phase in between. Failed recovery cannot replay itself. It never rebuilds,
imports a repository, deletes resources, kills processes, or stops WSL. An
existing runtime directory (including a symlink) or possible Init/import stays
blocked for operator reconciliation. Shutdown owns the full recovery lifecycle;
recovery cannot start a worker after Project closure. A connected but unhealthy
runtime reports `not_ready`, not successful readiness.

A live Windows/WSL smoke test on 2026-11-06 recovered a retained built-but-unstarted
installation through this path using the Electron Node-mode helper: one helper
launch, worker answering, Docker healthy, no rebuild or repository import. Graceful
close then persisted `stopped`. This qualifies that connection/recovery case only;
parallel sandbox edits, checkpoint recovery and merge behavior remain unverified
by that test.

Graceful
shutdown failures disconnect the helper through EOF without force-killing the
daemon and report uncertainty; admitted daemon work may continue. Worker/WSL
lifecycle survival and crash recovery remain unqualified upstream boundaries.

An explicit `SHADOW_LAYERFS_CONFIG` takes precedence: invalid configuration never
falls back to a managed worker, and setup never overwrites that override. Linux
and macOS still use operator configuration. Advanced `setup` uses existing artifacts;
`bootstrap` performs the pinned source build described above. Neither installs
WSL/Docker or a system service. Upstream releases have no prebuilt assets; the
source recipe is used instead of a fabricated npm/download URL. Bundled workflow:
`v:skills/layerfs/setup.md`.

## Failed-import quarantine and baseline preparation

`import_recovery_plan` observes retained failed/unknown import metadata and creates
a source-state fingerprinted, session-bound 15-minute plan. `import_recover`
requires the exact recorded human decision returned for that plan, plus explicit
approval/root-worker flags in a direct durable owner session. Flags, old decisions,
custom/deferred answers, task/call/script contexts and replayed tool calls cannot
admit it. The owning background task reports completion; admission is not recovery.

The action serializes against setup/import/shutdown, holds an exclusive on-disk
recovery lock, and checks its evidence fingerprint before effects and before pointer
commit. An owned helper is gracefully closed only after a fresh healthy response
proves zero active calls. Complete host inventories must show no retained helper;
a stopped installed distro needs no root execution, while a running distro receives
a bounded root read-only `/proc` census. The exact approval covers a possible WSL
startup race. Active/ambiguous ownership fails closed, without kills or WSL shutdown.
These are moment-in-time observations, not a universal OS ownership lease.

Success does **not** retry or repair the failed Init. All old runtime/worker/import
journals and Store volumes remain in place. A fresh, empty generation under
`state/layerfs/generations/<id>` gets a disjoint SDK project, host/Linux home and
container prefix. `active-generation.json` is the atomic selection point;
`generation.json` records its previous namespace and safe quarantine evidence.
The original installation approval is reused, without build/download/import.
`namespace_status` exposes a bounded, sanitized quarantine chain. Explicit namespace
assertions and pinned in-flight identities reject old requests/mount IDs instead
of redirecting them. Use the returned namespace on the next connect/create.

A durable `namespace-history.json` tombstone is written before generation creation.
Missing/foreign/malformed pointers, dangling descriptors or interrupted preparation
never silently fall back to legacy—even after restart. An interrupted prepared
directory stays retained and unselected. Do not clear locks/pointers/history or guess
a generation; an ambiguous state requires operator inspection. The tests cover
pointer loss, stale requests, shutdown and preserved original bytes.

A missing separate local destination can be created and registered by the owner
agent through `workspace_register {path,mode:"create_empty"}` (absolute user-authorized
path, existing parent), without a UI registration step or session switch. Use
`mode:"existing"` for an explicitly authorized existing directory. Registration
uses Project ownership checks; failures retain outputs. Its returned `workspaceId`
is the `destinationWorkspace` selector. This does not bypass any baseline,
bootstrap or import approval; see the [automated sequence](../src/skills/builtin/layerfs/setup.md#planned-separate-baseline-preparation).

`baseline_plan {workspace,destinationWorkspace}` performs metadata and fixed,
bounded `git ls-files --cached -z` inventory through authorized registered local
source-read and destination-write routes. Git hooks/fsmonitor and inherited Git
configuration are disabled for this inventory. The plan selects tracked working-tree
regular files (not committed versions), excludes untracked files, VCS/dependency
and build trees and known credential artifacts, and reports bounded exclusions/warnings/counts.
This fixed curated scope is not a full clone. Source modules under `src/credentials`
are retained with warnings; nested non-code data remains excluded. To include VCS or
dependencies, use `importPolicy:"whole_tree"` on a separately content-reviewed tree.
Source and destination must not overlap. It performs no copying or registration.

After its exact human approval, `baseline_prepare` runs as owner-session background
work. Its source/destination-bound token is single-use, expires after 15 minutes,
and is revalidated against metadata. It creates an exclusive new directory under
the destination workspace's `.layerfs-baselines`, copies bounded selected contents
without exposing them, checks metadata again, and registers the complete baseline.
No original files or Git index are edited; existing destinations are never replaced.
Project Home is deliberately not the destination because it cannot be registered as
a workspace. Partial copies and uncertain registration stay retained, never reported
ready, cleaned automatically, or silently replayed.

These helpers are not a secret scanner or hostile-filesystem sandbox. Metadata
checks cannot eliminate races; Windows copy validation excludes read-induced change
time but retains identity/mode/link/size/mtime/birthtime checks. Human content review
and `import_preview` on the returned workspace are still required before `create`.
Warnings alone are not evidence of secrets or a credential-free certification.

This iteration was exercised with synthetic ownership/SDK fixtures and temporary
Git repositories only. Live post-import quarantine, copied OfficeAgent baseline,
parallel edits, isolation, checkpoints and merge remain to be tested by the owner.

## Setup diagnostic

Updating Shadow does not provision LayerFS. Before using it, invoke
`layerfs {action:"doctor"}`. This reads and validates the operator-selected JSON
configuration without loading SDK code, starting a worker or creating a sandbox.
In operator mode it returns `configured:false` with a stable diagnostic `code`
and actionable message for missing/invalid configuration, or `configured:true`
after validation. Managed mode reports the saved phase and next setup/connect
action without starting the worker.
Both return `runtime:"not_checked"`: neither validates SDK artifacts, connectivity,
Store, Docker or sandbox health. Raw configuration contents and environment values
are not included. Other operations continue to refuse invalid configuration with
an explicit no-effect error before dispatch. Project/remote-target guards apply
to the diagnostic as well.

Only for operator-environment mode, set `SHADOW_LAYERFS_CONFIG` in the **backend
launch environment** and restart the backend after operator setup. Setting it in an agent's exec child cannot update
the parent backend. The bundled `v:skills/layerfs/setup.md` explains prerequisites
without requiring a source checkout; this document is repository documentation,
not a skill-relative resource.

## Workflow and API

Read `v:skills/layerfs`, discover/import `v:tools/layerfs`, use `connect` (or
configuration-only `doctor`), complete any required approved setup, then invoke
`layerfs`:

1. `import_preview` with `workspace` = a registered curated source selector. Review
   the source contents and freeze the baseline; do not strip files from the original
   checkout. Then `create` with the same selector, returned `sourceReview` token and
   `sourceReviewed:true`. No original files are overwritten. Managed imports return
   a background handle; wait for its completion event before fork/mount. The SDK
   Init deadline defaults to 300 seconds after the managed preparatory counting
   pass; native scanning is included. `importTimeoutMs` configures this single
   budget; progress is available through `import_status`.
2. `fork` with `branch` and optional baseline `ref` (use a fixed ref for concurrent
   agents). `load` requires a historical `ref` and a **new** `branch`; it is not an
   in-place rollback. For >1 GiB multi-agent jobs, share baseline Store data and
   give every agent its own branch and mount, rather than copying the whole tree.
3. `mount {branch}` creates one sandbox and mounts one workspace. Its response
   contains a Project-bound `layerfs:`-prefixed `workspace` ID for ordinary tools. Container paths are informational.
4. `read {workspace,path,start?,end?}` reads 200 lines by default, maximum 1000.
   `write {workspace,path,content}` replaces one sandbox file, at most 64 KiB text.
   These use sandbox POSIX `sed`/`printf` through the public SDK exec API; the image
   must provide those commands. Write creates parent directories. Paths reject `..`.
   Symlinks and other sandbox access follow upstream/container semantics.
5. `exec {workspace,command,message?}` executes in that workspace; run tests here.
   `commit {workspace,message?}` checkpoints through `workspace.commit`, without
   force. `history {branch,offset?}` lists saved commits.
6. `diff {ref,branch,offset?}` compares branches without hunks; `merge
   {ref,branch,name,message?}` creates a named integration branch. Conflicts are
   returned by SDK without automatic resolution. Test the merged branch in a new
   mount before publishing. `publish {branch,ref?}` changes **LayerFS main only**.
7. `close {workspace}` calls unmount with discard=false and force=false. Dirty
   deletion is refused by upstream; commit first. Clean temporary mounts are
   removed; upstream expires idle empty sandboxes. Store, branches and saved
   commits are retained. There is deliberately no destructive force/remove API.

`list` lists sandboxes; `branches` lists branches; `status {workspace}` lists the
workspace's sandbox records, including activity/changed. Find the matching path.
List/history/diff use pages of 100, with optional nonnegative `offset`.

## Ordinary read/write/exec contract

- `read {workspace,path,offset?,limit?}` supports relative UTF-8 regular text files,
  positive 1-based offset (default 1), limit 1–1000 (default 200). Unlike host reads,
  omitted ranges mean the **first** 200 lines. Directory listing, image/binary
  input, numbering/list/raw flags and non-UTF-8 encodings are rejected, not emulated.
  UTF-8 decode is strict; a clipped multibyte character may require a smaller range.
- `write {workspace,path,content}` supports UTF-8 full overwrite (64 KiB), creating
  parents. `encoding:"utf8"` is accepted. match, append/global flags, legacy edits
  and BOM encoding are rejected **before** dispatch. Historical records use the
  opaque LayerFS URI, never a fake host target; prior bytes/diff are explicitly
  unavailable and written content is retained for view_edit. No record sink means
  the receipt explicitly reports history was not recorded.
- `exec {workspace,script,shell?:"sh"|"bash",cwd?,timeout_ms?}` executes a quoted
  script in the sandbox. Default shell is sh, irrespective of host OS. cwd is a
  relative subdirectory, default `.`; absolute/traversing cwd is refused. args,
  node and other runtimes, background timeout 0 and leaf-call execution are
  unsupported and rejected before dispatch. timeout is 1–300000 ms, default 120000.
  This is a **receipt deadline**, not host exec's background-on-timeout behavior:
  timeout/cancellation raises UNKNOWN; daemon commands may continue. Do not retry.
- Relative symlinks resolve inside the upstream sandbox; this is not a new host
  filesystem sandbox. File helpers require POSIX sh, sed, grep, mkdir and printf
  in the image. Outputs retain SDK code and bounded stream/truncation metadata.
- Malformed, foreign-Project or stale IDs never fall back to Main. Registered
  Workspace selectors still use the existing authorization/locality resolver.

## Safety and integration limits

- LayerFS IDs are not host workspace registrations. Ordinary read/write/exec accept
  the mount ID in `workspace`; use_project, search and child cwd do not. Never
  register `/workspaces/1` as a host Folder or pass it as a host cwd. There is no
  host export, automatic source merge-back, or remote route. Old unprefixed opaque
  IDs remain supported by the dedicated layerfs tool only, never guessed by ordinary tools.
- Only one operation per workspace is admitted; overlapping calls fail busy before dispatch (wait for the receipt, do not replay). different workspaces can run in
  parallel. Project management operations have a separate lock. Non-import SDK
  operations have a default 330-second bridge receipt deadline; ordinary routed
  exec uses its explicit receipt timeout. Imports use the single SDK budget and
  renewable silence watchdog described above. Cancellation kills the bridge, **not necessarily the daemon
  command**. Lost/invalid receipts, SDK Unknown, abnormal bridge exit, or oversized
  protocol output raise outcome-unknown; nothing is automatically resent.
  Inspect status/history and reconcile manually before retrying any mutation.
- Exec uses SDK Writable sinks; each output stream retains only 64 KiB with total
  byte counts and truncation markers. The protocol is limited to 1 MiB. SDK pages
  and daemon/native buffers remain under upstream control.
- Mount failure can leave a newly created sandbox: inspect `list`; do not blindly
  replay mount. No project/volume removal is automated here.
- Definite SDK error receipts are marked as completed tool failures (`isError`),
  preserving code/detail; SDK Unknown still raises outcome-unknown. A refusal may follow earlier effects;
  errors are not general rollback guarantees. Conflicts require human/agent review.
- LayerFS working state is disposable, not a reliable backup. Keep source and
  independently backed-up durable outputs. Credentials must not enter snapshots.

## Verification scope

Managed-setup tests use synthetic Runtime/SDK modules and injected subprocesses,
not WSL or root execution. They cover approval/context gates, private paths,
persistence/reuse after clean shutdown, real helper IPC, automatic bridge wiring,
uncertain-state no-replay, SDK Unknown handling and graceful-close failure cleanup.
These are application integration tests, not live qualification of managed setup
against the real upstream worker on this host.

Focused tests use a synthetic SDK to verify real child-process dispatch, bounded
Writable capture, Project-bound selectors, dirty unmount arguments, cancellation,
abnormal exit and local/remote admission guards. They do not prove upstream Store,
Docker, WSL, conflict resolution or runtime provisioning works on this machine.
No SDK, daemon or image was installed to perform those synthetic tests. Later real
platform tests are recorded above and in
[layerfs-e2e-wsl-20261105.md](layerfs-e2e-wsl-20261105.md) and
[layerfs-e2e-macos-20261105.md](layerfs-e2e-macos-20261105.md); their limited
passing matrix and unresolved failures must not be expanded into a general
platform-readiness claim.
