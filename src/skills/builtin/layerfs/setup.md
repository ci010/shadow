# LayerFS setup and connection

## Fresh-session path: connect → one consent → automatic bootstrap → original task

Invoke `layerfs {action:"connect"}`. An existing approved installation is reused.
Without one, the owner Web session gets an automatic `bootstrap_plan`: WSL distro
inventory only, no root command, download or worker startup. A unique eligible
distribution is selected automatically; multiple candidates need a distro choice
using `bootstrap_plan {distribution:"name-from-inventory"}`. Docker Desktop's
internal distributions are never candidates.

For `status:"needs_approval"`, invoke ask with the **exact** returned
`approvalRequest` (kind, question, options, default_option), without rewriting its
plan-bound question/options. The question explains the pinned official source/images/dependency downloads, potentially
several GiB and a lengthy native build, root commands within the selected distro,
private retained resources, and future reuse of the root worker. One question
covers that scoped setup; neither an unanswered question nor `approved:true`
itself is authorization. A request to change application code is not consent to
run setup on the current PC.

After approval call:
```json
{"action":"bootstrap","plan":"RETURNED_SESSION_BOUND_TOKEN","approval":{"sessionId":"FROM_ANSWER_REFERENCE","physicalId":"FROM_ANSWER_REFERENCE","requestId":"FROM_ANSWER_REFERENCE"},"approved":true,"allowRootWorker":true,"allowDownloads":true}
```
Copy `approval` from the ask answer's `reference`; the host checks the persisted
human answer for this exact question and plan. A timeout, deferred/custom answer,
parent/foreign answer, invalidated decision or unrelated approval is refused.
Boolean flags alone cannot authorize root execution.

No SDK path, image choice, script, URL, JSON file or environment variable is taken
from the user on this path. The native tool derives them from the bundled recipe.
The plan is session-bound and expires after fifteen minutes. Setup runs as a
Project-owned background task and returns a `bg:` execution ID. Wait for its
completion event; do not poll or manually replay it. `v:bg` and `bootstrap_status`
allow inspection and the normal cancel tool can cancel the owned execution.
Cancellation does not prove WSL/Docker side effects stopped.

### Startup diagnostics and guarded recovery

Bootstrap first runs a no-input WSL readiness command with a 120-second startup
budget, then gives path conversion 30 seconds. Probes ignore stdin; only the
source-build recipe receives script input. Timeout, cancellation, spawn/stdin
errors, nonzero exits and signal termination have separate diagnostics, including
elapsed time and whether the host launcher closed. Bounded native output is
retained in private per-step logs, not echoed into the conversation.

`probe_failed` with `provisioningStarted:false` means the LayerFS provisioning
script was not dispatched; it does not claim that starting WSL had no OS/service
effects. Inspect `bootstrap_status`. If it reports `probeRecoveryCandidate`, call
`bootstrap_recover {executionId:"EXACT_FAILED_BG_ID"}`. This owner-only action
checks the exact attempt, launcher closure, absent build artifacts and absence of
an installed runtime; it archives the old journal and marks it `recovered`.
It does not delete evidence, terminate WSL, rerun a probe, download or build.
Legacy `uncertain/resolve_paths` records without launcher diagnostics additionally
require a read-only inventory showing the distro stopped. Running attempts,
unconfirmed launcher termination and any potentially dispatched build remain
blocked. A successful recovery permits a **new plan and approval**, not replay
of the old operation. Never emulate this action with file edits.

A separate, deliberately narrow recovery exists when the build finished but the
SDK host runtime **never opened**. `bootstrap_status.connectionRecoveryCandidate`
identifies only an original `uncertain/connect_worker` attempt with a saved
installation. After explicit owner consent to one root worker connection attempt,
call `bootstrap_recover_connection` with its exact `executionId`, `approved:true`
and `allowRootWorker:true`. Like advanced setup, these flags record caller-obtained
consent; they do not themselves grant permission. The owning tool checks the
saved installation matches, the SDK runtime directory is absent, no managed
helper remains, and valid WSL inventories show the selected distro installed and
stopped. It refuses to kill processes, stop WSL, delete resources, rebuild, or
recover a possible Init/import. It archives the old records and durably admits
one connection attempt; another uncertain result stays blocked. Inspection alone
never grants recovery permission. Existing runtime directories require operator
reconciliation even if the worker appears down.

On success, **continue the original request**: connect, check source import
safety, then perform the requested branch/isolation/tests. Do not mark the task
complete merely because the worker started. A subsequent fresh session reuses the
saved installation through connect with no repeated bootstrap or manual setup.

### Supported post-import quarantine (not bootstrap retry)

When `import_status` reports a retained failed/unknown import, use the direct
owner-session `import_recovery_plan`. It creates a 15-minute, session-bound plan
from a fingerprint of the installed profile and import/worker evidence; no root
inspection, worker close, pointer mutation or copying is performed by planning.
Call ask with the exact returned approvalRequest. A deferred, custom, foreign or
unrelated answer is not approval. After approval, invoke:

```json
{"action":"import_recover","plan":"RETURNED_PLAN","approval":{"sessionId":"FROM_ANSWER","physicalId":"FROM_ANSWER","requestId":"FROM_ANSWER"},"approved":true,"allowRootWorker":true}
```

Wait for the background completion event. The action holds Project setup ownership
and a cross-process recovery lock; it rechecks the fingerprint and shutdown state.
It only gracefully closes an owned worker after a fresh healthy response proves
zero active calls. Foreign/retained helpers or ambiguous ownership remain blocked;
absent helpers must be corroborated by complete OS inventories.
A stopped distro requires no Linux execution; a running distro receives a bounded
root read-only process census. The approval includes possible WSL startup if its
inventory races shutdown. No process is force-killed and no distro is terminated.

Success retains the old runtime, journal and Store resources **unchanged** and
selects a fresh generation with distinct SDK project name, host/Linux home and
container prefix. It does not repair or retry the old import, rebuild binaries,
import source or start the new worker. The result returns a `namespace`; pass it
to the next `connect`/`create`. `namespace_status` lists safe retained history.
Old mount IDs and in-flight old-namespace requests cannot route to the new Store.
Missing, malformed or foreign pointers and interrupted generation preparation
fail closed, including after app restart; never clear their history/locks manually
or guess which generation to select. A refused/incomplete recovery is not a
license to repeat the old import.

### Planned separate baseline preparation

`baseline_plan {workspace,destinationWorkspace}` performs only metadata/Git
inventory reads; copying requires its own exact approvalRequest to be answered. Both selectors
must resolve through the owning Project's local workspace route (source read,
destination write). The destination must be separate from the source; Project
Home is not used as a registered baseline. The plan reports selected file/byte
counts, exclusions and review warnings. It selects Git-tracked **working-tree**
regular files, not committed versions; untracked files are excluded.

After human approval use `baseline_prepare` with the same selectors, plan,
`approval` reference and `approved:true`. Preparation is background work; wait for
its result. It creates a unique exclusive directory in the destination workspace's
`.layerfs-baselines` and registers it only after successful copying/revalidation.
The original checkout and Git index are not edited. Known credential artifacts,
VCS/dependency trees and linked/unsafe paths cannot be copied through this path.
Names of code/docs/assets discussing secrets produce warnings rather than blanket
refusal. Unknown embedded secrets remain possible: review contents and then run
`import_preview` on the returned workspace before `create`.

Plans are source/owner-bound, single-use and expire after 15 minutes. Traversal,
copying, outputs and bytes are bounded. Source/destination metadata is rechecked;
these checks are not a hostile-filesystem sandbox or immutable snapshot. Partial
destinations and uncertain registration are retained for inspection, not cleaned,
replayed or reported ready. Do not copy into or remove material from the original
checkout merely to get past import checks.

### Supported bootstrap and boundaries

The bundled source recipe targets Windows x64, an existing x86-64 WSL2 distro,
Python ≥3.9, git, FUSE, local rootful Docker API ≥1.48 with the default
`/var/lib/docker` data root, and a supported Linux local filesystem. The pinned
Bookworm build conservatively requires glibc ≥2.36. Root-only prerequisites are
checked after consent and before downloads/resources. OS/WSL/package installation,
Docker daemon changes, networking/proxy/TLS changes and repository import are not
part of this recipe. If a prerequisite is missing, report its exact code and ask
for the separate platform change; do not fall back to manual LayerFS paths/env.

Bootstrap uses upstream commit `73d974dea8a8d0b056a16dc6b2380d89438ce484` and pinned
official rust/node image digests, verifies the image/source/sealed bundle identity,
uses official `tools/worktree.py register/prepare/build`, and extracts its private
Node from the pinned image instead of installing system Node. It retains MIT/Node
license notices. Matching API files and resolution shims are staged on the host;
a byte-identical identity-read mirror accommodates the pinned Windows SDK check
without changing the sealed Linux bundle or importing a second SDK instance.

State is private and Project-scoped. The recipe reserves a new Linux build root
and a new host output leaf; it never replaces old state. A definite **preflight**
refusal can get a new plan only after the cause is corrected. Failed/uncertain
builds, crashes or lost receipts remain retained and block automatic replay.
Do not clear journals or delete/recreate resources to bypass this boundary.
`bootstrap_status` reports saved state, not current runtime health.

No `SHADOW_LAYERFS_CONFIG`, hand-written JSON or backend restart is needed for
managed setup. Session sleep/reset does not stop the shared worker. Clean Project
shutdown closes it gracefully and permits later on-demand restart. Persistence of
running sandboxes across worker/WSL lifetime is not guaranteed. Uncertain worker
startup or imports still block automatic restart/replay.

## Advanced: connect an existing operator installation

Use this path only when an operator supplies/selects an existing installation;
it is not the default response to the original parallel-development prompt.

Supported installation layout: matching Windows JavaScript API tree and sealed
Linux bundle from upstream commit `73d974dea8a8d0b056a16dc6b2380d89438ce484`.
The older v1.1.0 release has a different SDK layout and Docker API incompatibility;
package version alone is not evidence of compatibility.

1. Discover the installed API root, sealed Linux bundle, WSL distribution,
   absolute Linux Node executable and **installed image ID**. The API root contains
   `api/agent/src/index.js`, `api/runtime/src/index.js` and their package metadata/
   resolution shims. Use trusted existing operator installation records when
   available. Do not sweep unrelated home directories or read credentials. If the
   installation location cannot be discovered, ask for that existing location,
   not a JSON configuration or manually set environment variable.
2. Explain and obtain explicit owner consent to execute this installation,
   start a **root WSL worker**, allocate private Project resources, and reuse that
   approved installation across sessions and after clean backend restarts.
   Approval of a code change or historical test is not runtime approval. The
   worker can reach its configured distribution's Docker Engine; this is not a
   universal security sandbox. Never infer consent from `approved:true` itself.
3. In a durable local owner Web session, call:
   ```json
   {
     "action": "setup",
     "approved": true,
     "allowRootWorker": true,
     "installation": {
       "apiRoot": "ABSOLUTE_HOST_ROOT_OF_MATCHING_API_TREE",
       "bundle": "/absolute/linux/sealed-bundle",
       "distribution": "SELECTED_WSL_DISTRIBUTION",
       "node": "/absolute/linux/node",
       "image": "sha256:ACTUAL_64_HEX_INSTALLED_IMAGE_ID"
     }
   }
   ```
   These placeholders are explanatory, never executable defaults. Agents discover
   real values; do not ask humans to construct this tool payload. Setup rejects
   an existing different choice rather than overwriting it. It persists approval,
   allocates private paths and starts the official worker with sweeping disabled.
   It does not import OfficeAgent, install Docker/WSL/Node, or download/build code.
4. Check the returned `ready`, `answering`, `docker`, and `sandboxVerified` fields.
   `ready:true` means the worker answers and Docker is reachable; it is **not** a
   passing import/mount/isolation/merge test. `sandboxVerified` remains false.
5. Run `import_preview {workspace:"registered-curated-baseline"}` and review the
   source contents for credentials. Do not remove anything from the original
   checkout to satisfy preview. `create` requires its `sourceReview` token plus
   `sourceReviewed:true`; missing, expired, changed, foreign-session or reused
   tokens fail before import. Managed create returns a `bg:` task and uses the
   official Runtime initialization job to allocate its own labeled plain Docker
   volume and import once. Background import admission requires the direct durable
   owning session, not a task, leaf call, nested script or recovered invocation.
   Wait for the completion event; do not poll or resend. Shadow derives the bridge environment from the
   official Project record; the user need not supply Store paths or volume names.
   Ordinary read/write/exec and dedicated LayerFS tools share this same runtime.

Managed profiles are private Project config; they are not user-created workspaces
or deliverables. Do not edit them or recovery journals with write/exec to bypass
setup approval, replace an installation, clear an uncertain state or force restart.
`runtime_status` inspects the current owned helper or saved state without starting
one. While the helper is busy it immediately reports `health:"not_checked"` and
import progress instead of queueing a probe behind Init. `import_status` reads
sanitized current or retained progress; it can recognize older SDK deadline
failure records without exposing paths, catalog keys or raw native errors.
A retained `uncertain` marker still blocks another import—diagnostics never clear it.
`importTimeoutMs` is the single SDK Init budget (1000–1800000 ms, default
300000), passed unchanged in managed and operator modes. It begins after the
managed preparatory counting pass and includes native scanning/construction.
There is no second Shadow import wall-clock cutoff. A 90-second helper-silence
watchdog renews on managed progress or operator IPC heartbeats; it measures
liveness, not native progress. Silence/cancellation means unknown effects, not
native deadline failure. A stalled native operation with a responsive helper can
remain observed until its own result or explicit cancellation. Neither path retries. On failure, report the safe code and inspect retained
resources before manual recovery. No force restart, delete or automatic
reinitialization is exposed.

## Artifact provenance and OS prerequisites

Updating Shadow installs the bootstrap recipe, **not** LayerFS binaries or Docker
images. The upstream npm packages are private and the checked releases have no
prebuilt assets. The approval-gated source build is the normal acquisition route;
never invent an npm install or substitute an unverified download URL. Immutable
source/image pins and sealed-file hashes are checked, and license notices retained.
A sealed manifest alone establishes consistency, not publisher authenticity.

A full fresh-machine installer requires separate platform provisioning. This
feature automates LayerFS acquisition/configuration on a supported existing WSL
and Docker environment; it does not install Windows features, a distro or Docker.
Do not confuse a fresh **session** with a bare operating system.

## Diagnostics and operator configuration compatibility

`layerfs {action:"doctor"}` only reads configuration. It never loads SDK code,
starts a worker or imports a repository. Managed mode reports saved phase and
next action; operator mode reports stable codes such as `CONFIG_NOT_SET`.
Both use `runtime:"not_checked"`; configuration validity is not runtime health.
No raw configuration values, SDK errors or worker endpoint secrets are returned.

An explicit `SHADOW_LAYERFS_CONFIG` still takes precedence, with no silent fallback
to managed settings if invalid. It names an absolute operator-owned JSON file
outside model-editable workspaces, with `projects` keyed by Shadow Project ID.
Each entry contains `sdkModule` and an allowlisted `env` object. The operator must
provision private home/Store/volume/runtime/worker resources first. On Windows and
macOS a worker endpoint is required; Linux needs a supported local filesystem.
To use this legacy mode, set the variable in the **backend's environment** and
restart that backend; an agent exec child cannot change its parent's environment.
Managed setup deliberately does not replace this explicit override.

The full contract and compatibility evidence are in the Shadow repository's
`docs/layerfs.md`, not a bundled `docs/` resource. This guide is always readable
as `v:skills/layerfs/setup.md` without a source checkout.

## Before importing a repository

`create` recursively imports **all** files, including dotfiles, ignored and
untracked files. There are no import ignore rules or content credential scanner.
`import_preview` adds an enforced metadata/name preflight: `.git`, `.venv`,
`node_modules`, symlinks, common credential names and unreadable/unbounded trees
are blocked. Counts and findings are bounded; blocked subtrees are not traversed.
Review tokens last 15 minutes and are consumed once after a matching metadata
rescan. A successful preview is not proof of no embedded secrets and cannot
eliminate races in a mutable source tree. Use a separate, content-reviewed,
credential-free registered baseline and preserve the original source.
Do not treat `.gitignore` as a security boundary or import auth files for a test.
A clean sandbox close retains branches and checkpoints. LayerFS is disposable
working state, not a backup or an automatic merge-back to the host repository.
