---
name: layerfs
description: "LayerFS isolated branches for parallel development; first-run Windows/WSL discovery, one-consent pinned source bootstrap, automatic configuration and reuse. No manual SDK paths/env; existing WSL/Docker prerequisites required."
core: true
metadata:
  category: tools
---

# Optional LayerFS

Discover `v:tools/layerfs`, then invoke `layerfs {action:"connect"}`. In a fresh
owner Web session, missing installation returns a discovered first-run plan—not
an instruction to supply SDK paths or environment variables. Read
`v:skills/layerfs/setup.md`. If multiple eligible WSL distributions exist, select
one with `bootstrap_plan {distribution:"discovered-name"}`; never use Docker
Desktop's internal distributions.

For `status:"needs_approval"`, call ask with the **exact** returned
`approvalRequest` fields (kind, question, options, default_option). Explain the
pinned downloads/source build (potentially several GiB and lengthy), root WSL
execution, private retained resources and future reuse; do not rewrite the
plan-bound question/options. After explicit human approval, invoke
`layerfs {action:"bootstrap", plan:"returned-token", approval:answer.reference,
approved:true, allowRootWorker:true, allowDownloads:true}`. The host checks the
recorded human decision; flags or an unrelated approval cannot authorize setup. The tool discovers all
paths and builds/configures/connects automatically. Wait for its background
completion event; do not poll or resend bootstrap. On success, **continue the
original user request**—runtime setup is not completion of the parallel test.

Do not ask humans for SDK paths, image IDs, JSON or environment edits on this
normal path. Do not substitute ad hoc shell installers. Existing approved setups
are reused with no environment variable or backend restart. A code-change request
is not approval to provision this machine. Setup/start is forbidden if the user declined it.

`doctor` is configuration-only; `runtime_status` inspects saved/current runtime
state without starting a worker. `ready:true` from managed connect means the
worker answers and Docker is reachable, not that sandbox operations passed.
Normal session close/sleep does not stop the Project-owned worker. After a clean
backend shutdown it can be restored on demand; uncertain state is never replayed.
An explicit operator SHADOW_LAYERFS_CONFIG takes precedence without fallback and
retains operator-owned lifecycle. Its connect result has `runtime:"not_checked"`.

Reading this skill installs nothing. The upstream packages are private and the
checked releases have no prebuilt assets; bootstrap uses a bundled pinned official
source-build recipe instead. Never invent npm installs or binary URLs. Automated
bootstrap targets Windows x64 with an existing compatible WSL2/Docker/Python/git/
FUSE environment; it does not install OS packages or change Docker configuration.
If prerequisites are blocked, report the exact code and request the affected
platform setup rather than asking for manual LayerFS configuration. A definite
preflight refusal may receive a new plan after its cause is corrected; uncertain
builds cannot be replayed. Readiness/path-probe failures are different: inspect
`bootstrap_status` for `probeRecoveryCandidate`, then use `bootstrap_recover` with
the exact `executionId`. It checks and archives the failed attempt without
restarting WSL or provisioning; legacy path failures additionally require a
stopped-distro inventory. If refused, stop—never clear/edit the journal. A distinct
`connectionRecoveryCandidate` may allow `bootstrap_recover_connection` for a
completed build whose SDK host runtime never opened: get explicit owner consent
for one connection attempt, then pass the exact `executionId`, `approved:true`
and `allowRootWorker:true`. It verifies absent runtime state, no managed helper,
and a stopped installed distro; preserves evidence; and never rebuilds, imports,
deletes or kills. Any failed recovery or existing SDK runtime needs operator
reconciliation, not another automatic attempt. After
successful recovery, get a fresh bootstrap plan and approval. `bootstrap_status`
is retained-state inspection, not proof of current worker health. Advanced `setup` connects an operator-supplied
existing installation; Linux/macOS retain operator configuration. Full workflow:
`v:skills/layerfs/setup.md`; operator details: repository `docs/layerfs.md`.

## Failed-import recovery and a separate baseline

A retained failed/unknown import is **not** a bootstrap probe failure. Use
`import_recovery_plan` in the direct owner session. It reads safe retained evidence
and returns an exact `approvalRequest`; call ask with those fields unchanged and
wait. Only after approval call `import_recover {plan,approval,approved:true,
allowRootWorker:true}`. Wait for its background result, never replay it.
It can gracefully close this runtime's worker only after proving it idle, then
checks host/WSL ownership (root read-only process census if the distro is running).
Active or ambiguous ownership is refused—no force kill, WSL shutdown or cleanup.

A successful result is `quarantined`, not imported: all old runtime/journal/Store
resources remain in their old namespace. A fresh private namespace is selected
without a worker start, rebuild or import. Use its returned `namespace` on
subsequent `connect`/`create`; this is a genuinely new resource, not a replay of
the old uncertain call. `namespace_status` exposes safe quarantine history. Old
mount IDs and stale in-flight requests are refused, never redirected. Missing or
inconsistent namespace pointers do not fall back to legacy; stop for inspection.

To prepare a baseline without hand-editing or stripping the checkout, call
`baseline_plan {workspace:"source-selector",destinationWorkspace:"separate-target"}`.
If the separate local destination is not registered, import
`v:tools/workspace_register` and use `mode:"create_empty"` with the user-authorized
absolute destination path (existing parent required); use `mode:"existing"` only
for an authorized existing directory. No UI step or session switch is needed.
Pass its returned `workspaceId` as `destinationWorkspace`. Registration does not
replace baseline/bootstrap/import approvals; see [setup.md](setup.md).
Both must be registered local workspaces; destination must authorize writes and
not overlap the source. It plans selected **Git-tracked working-tree** files,
excluding VCS/dependency/build trees, known credential artifacts and all untracked
files. This is a fixed curated scope, not a full clone. Credential-named source
modules are retained with warnings; non-code data inside those directories is excluded.
Use `importPolicy:"whole_tree"` on a separately reviewed tree to include dependencies.
Review its bounded exclusions/warnings/counts. Ask its exact approvalRequest; after
approval call `baseline_prepare` with the same selectors, plan, approval reference
and `approved:true`. Wait for its background event. It creates an exclusive new
directory under the destination's `.layerfs-baselines` and registers that complete
baseline. The original source is unchanged. Partial output is retained, not
reported ready or silently overwritten. A copy/registration is not source-content
review or an import; use the returned workspace for `import_preview` next.

For >1 GiB repositories with concurrent agents, import a stable baseline once:
- Run `layerfs {action:"import_preview", workspace:"registered-source-workspace-id"}`
  first. `importPolicy:"curated"` (default) rejects dependency/VCS/build entries as
  outside its scope, not secrets. To include them, specify `importPolicy:"whole_tree"`
  on both preview and create: all entries are recursively reviewed, with no ignores.
  Both policies block symlinks and credential/private-runtime artifacts. Source
  directories such as `src/credentials` warn and are traversed; code is reviewable,
  but nested non-code data, `.env` and keys remain protected. Names are not a content
  scanner. If blocked, use a **separate curated baseline**; never delete from
  the original checkout to satisfy preview. It is not a content/secret scanner.
- After human content review, call `layerfs {action:"create", workspace:"same-selector",
  sourceReview:"returned-reviewToken", sourceReviewed:true}`. The token is single-use,
  session/source/policy-bound, expires after 15 minutes, and requires unchanged metadata.
  Repeat the exact preview `importPolicy`; changing scope needs a new preview.
  Freeze the source during import; metadata review is not an immutable snapshot.
  The selector resolves through Shadow's authorized local workspace route, not a path.
  Managed imports return a `bg:` execution ID: **wait for completion**, do not poll or
  repeat create. `import_status` reports safe progress/retained failures; runtime
  health reports `health:"not_checked"` while busy rather than waiting behind Init.
  Optional `importTimeoutMs` is the single native Init budget in both modes
  (300000 default, 1000–1800000 ms). Managed pre-counting is outside it; native
  scan/construction share it. Shadow has no competing import wall-clock cutoff.
  A 90-second renewable helper-silence watchdog is only a liveness check, not
  evidence of native progress. Silence or cancellation means unknown effects;
  it stops observation, not necessarily native work.
- `fork` with a distinct `branch` and the same baseline `ref` for each agent.
- `mount` each branch; pass the returned opaque `workspace` ID to that agent.
- `read {workspace,path,start,end}`, `write {workspace,path,content}`, and
  `exec {workspace,command}` operate in that disposable sandbox. Writes replace
  the exact sandbox file (64 KiB maximum); they are not Shadow host-file writes.
- Run tests before `commit {workspace,message}` to checkpoint. Inspect `history`
  and `diff`; `load {branch:"new-recovery-branch",ref:"historical-commit"}` forks
  history without rolling back or overwriting the original source or branch.
- `merge {ref:"branch-a",branch:"branch-b",name:"integration"}` creates an
  integration branch. Inspect conflict diagnostics; do not blindly retry or
  publish a conflict. Mount integration, test, commit, and inspect before
  `publish {branch:"integration"}`. Publish changes LayerFS main only, not host files.
- `close {workspace}` unmounts only a clean workspace. Commit first if dirty.
  There is no discard/force action. Empty sandboxes expire upstream; branches,
  commits and Store are retained, not deleted by close.

`list`, `branches`, `history`, `status` provide inventory. `status` lists the
selected sandbox's workspaces (including activity/changed); find the ID's path.
Listings and diffs are paged by offset (100 items). Diff currently omits hunks.
Exec captures 64 KiB per stream with truncation/byte counts. Cancellation or lost
receipts are UNKNOWN, not proof of no effects: inspect status/history before any
manual retry; daemon commands may continue. Never automatically resend a mutation.

## Important execution boundary

These IDs are **not registered host workspaces**. Ordinary read/write/exec accept
new `layerfs:` mount IDs explicitly in `workspace`; the dedicated LayerFS tool
also accepts them. Search/workspace_use do not. `/workspaces/1` is a container path,
never a local Folder. Give each agent its mount ID and require explicit workspace
routing; subagent cwd is not changed.
Remote Shadow executors are refused, with no Main fallback. Commands can access
whatever the configured LayerFS sandbox permits; this is not a universal sandbox.
LayerFS is disposable working state, **not a reliable backup**. Keep the original
source and independently backed-up durable outputs; source export/removal and
OS provisioning remain outside this integration. Pinned artifact bootstrap and
managed Windows worker startup require explicit approval.

## Ordinary tools

Pass the new `layerfs:` mount ID as `workspace` to ordinary read/write/exec.
Read: relative UTF-8 regular files, offset/limit (first 200 by default, max 1000);
no directories, images, binary/non-UTF-8, or flags. Write: UTF-8 overwrite only,
max 64 KiB; no match/append/global/BOM. Historical receipts use a LayerFS URI and
explicit unavailable prior diff, never a host path. Exec: script, sh (default) or
bash, relative cwd, positive timeout_ms up to 300000 (default 120000); no args,
node, background or leaf calls. Timeout is UNKNOWN, not a background handle;
daemon work may continue. Never retry automatically. Same-workspace overlap is
refused; wait for its receipt. Old unprefixed IDs work only in the dedicated tool.
Search/workspace_use/host cwd do not support these IDs. Setup and boundaries:
`v:skills/layerfs/setup.md`; full contract in the repository's `docs/layerfs.md`.

### Managed Windows import staging

`create` on a reviewed Windows drive-letter source now stages the entire approved
scope to an exclusive private Linux ext4 directory before upstream Init. This
avoids DrvFS read-open ctime changes; upstream Changed checks are not weakened.
`whole_tree` still includes all entries and never exempts credentials. The fixed
helper uses the approved Node binary and the distro's default user (possibly
root); failure to access it blocks, with no direct-DrvFS fallback. Managed UNC
sources currently fail closed; operator/native routes are unchanged.
Budget extra Linux disk for a complete copy plus Store, two source reads and up
to ten minutes cooperative staging (100k entries, depth 128, 16 GiB), separately
from `importTimeoutMs`. The launcher watchdog is not proof of helper termination.
Copy stability checks are not an immutable snapshot or protection from same-user
mutation/path races. All staging attempts are retained under namespace-keyed
`/var/tmp` envelopes. Cancel means observation stopped, not rollback. Failed or
unknown staging/Init stays blocked until the approved quarantine workflow; never
retry automatically or remove resources to bypass it.
`import_status.refusal`, when available, contains only a recognized native
reason and safe source-relative path. Upstream jobs lose structured detail;
unknown message shapes and unsafe paths are deliberately omitted. No real Init
or production integration success follows from synthetic tests.
