---
name: layerfs
description: "LayerFS isolated branches through workspace_create backend layerfs; explicit mount routing, safe reviewed imports and approval-gated Windows/WSL setup."
core: true
metadata:
  category: tools
---

# LayerFS workspaces

For an already imported LayerFS branch, discover `v:tools/workspace_create` and
invoke `workspace_create` with `backend:"layerfs"`, `source:"main"` (or another
existing LayerFS branch), and optionally `branch:"unique-task-branch"`.
`source` is a LayerFS branch name, **not a host path or registered host workspace**.
No `ref` field is exposed on this workspace entry. It forks a new branch from
source, mounts it and registers a LayerFS-backed workspace, returning a regular
`workspaceId`. Use ordinary `read`, `write`, `search` and `exec` with that ID, or
`workspace_use` to select it as the ongoing context. Tools then keep its target
by default, and child agents inherit the selected workdir. The context snapshot
identifies the LayerFS backend and sandbox location: location is visible, but
ordinary tool calls do not require low-level fork/mount orchestration.

Registration preserves the mount identity, not a local directory binding.
`/workspaces/1` is a container path, never a Main host path. Failures never fall
back to Main. On an initially bound session, read root `AGENTS.md` in the workspace
before ordinary work if it has not yet been loaded; read nested instructions
before entering a subtree.

## Connect and import only when needed

For low-level tools, initialize the on-demand source with
`invoke_tool {source:"layerfs",args:{}}` (registration only, not provisioning).
Then inspect the returned independent contracts and invoke `layerfs_connect {}`.
Reuse an approved
runtime. A missing installation returns a first-run plan, not a request for SDK
paths, environment edits or ad hoc shell installers. Read [setup.md](setup.md)
for exact setup, recovery and import procedures before proceeding.

For `needs_approval`, ask with the exact returned `approvalRequest` fields and
wait for a recorded human answer. Only then invoke `layerfs_bootstrap` with its
plan, approval reference, approved/allowRootWorker/allowDownloads flags. Flags
alone are not consent. This is a pinned source build on existing compatible
Windows x64/WSL2/Docker prerequisites, potentially several GiB and lengthy; it does
not install OS prerequisites. A code-change request is not runtime approval.
Wait for background completion, never poll/replay; then continue the original task.

Host source import remains a separate low-level workflow:
- `layerfs_import_preview {workspace:"registered-local-source"}` performs bounded
  metadata review, **not** a content/secret scan. Curated policy rejects VCS,
  dependency and build trees; whole_tree includes and recursively reviews them.
  Neither silently filters files or bypasses credential/symlink checks.
- Review source contents and keep the baseline stable, then
  `layerfs_import {workspace:"same-selector",sourceReview:"returned-token",sourceReviewed:true}`.
  Repeat the preview's exact importPolicy. Tokens are session/source/policy-bound,
  single-use and expire in 15 minutes. Import reads all allowed files; ignored and
  untracked files are not implicitly excluded. Never strip the original checkout
  to bypass checks: use a separate reviewed baseline instead (setup guide).
- Managed import returns a background execution ID. Wait for its completion;
  inspect `layerfs_import_status` on failure, never resend an unknown import.
  Timeout/cancellation can stop observation without stopping native work.
- Only after successful import use the workspace_create entry above.

## Work, test and checkpoint

Use ordinary tool parameters: read text/encodings, directory listings and images;
write overwrite/match/global/append/BOM; search grep/glob/include/pagination; exec
script/args/cwd with sh (default) or bash. Sandbox search requires `rg` already
installed in the image; no automatic installation or host search fallback occurs.
Current file transport limits remain: text reads 256 KiB and writes 64 KiB.
Exec uses the ordinary wait-window contract: timeout_ms:0 starts in background;
a positive timeout waits that long, then returns a bg: handle if still running.
The original SDK execution continues without a competing receipt deadline; do not
resubmit the command. Read v:bg for live output and use cancel with that handle.
Leaf calls remain foreground-only and must confirm process cleanup on timeout or
abort. Actual transport loss or unconfirmed cancellation remains UNKNOWN, never
proof the command stopped. Node runtime is not supported on this Linux adapter.
Same-mount overlap is refused while the SDK execution remains active.
Image read limits match ordinary read. Scoped skill/MCP execution is not yet
available in LayerFS; do not resolve those declarations on Main.

Test before `layerfs_commit {workspace:"layerfs:...",message:"checkpoint"}`.
Inspect `layerfs_history {branch}` and `layerfs_diff {ref,branch}` (paged offset,
100 items; diff currently has no hunks). `layerfs_status {workspace}` inspects
sandbox activity/changes. `layerfs_close {workspace}` refuses dirty mounts: commit
first, no force/discard. Branches/checkpoints remain retained.

Advanced low-level `layerfs_fork {branch,ref}`, `layerfs_load {branch,ref}` and
`layerfs_mount {branch}` remain available; load forks history, not in-place rollback.
`layerfs_merge {ref,branch,name}` creates an integration branch. Inspect conflicts,
mount, test and commit before `layerfs_publish {branch}`. Publish changes LayerFS
main only, **not host files**. Source export/merge-back is not automated.

## Safety and diagnostics

`layerfs_doctor` checks configuration only. `layerfs_runtime_status` never starts
a worker; `ready:true` means worker/Docker connectivity, not passing sandbox tests.
Normal session sleep does not stop the Project-owned worker. An explicit operator
SHADOW_LAYERFS_CONFIG takes precedence, with no silent fallback.

Unknown receipts are not rollback evidence; daemon commands may continue. Never
replay mutations automatically or edit/delete private profiles, journals, staging
or Store resources. For retained failures read the setup guide's exact guarded
recovery procedures; bootstrap probe recovery and failed-import quarantine are
not interchangeable. LayerFS is disposable working state, not a reliable backup
or universal security sandbox. Preserve the original and durable backed-up outputs.
Reading this skill installs nothing. Full technical/approval boundaries:
`v:skills/layerfs/setup.md`; source contract: repository `docs/layerfs.md`.
