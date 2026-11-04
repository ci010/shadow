---
name: layerfs
description: "Optional LayerFS 1.1 isolated branches, disposable sandbox workspaces and checkpoints for large concurrent tasks; requires operator-installed SDK and Linux Store/worker."
core: true
metadata:
  category: tools
---

# Optional LayerFS

Discover `v:tools/layerfs`, then invoke `layerfs`. Reading this skill installs nothing.
The host must configure SHADOW_LAYERFS_CONFIG per Project with a real built SDK,
private home, Store, runtime image/daemon/volume and platform prerequisites. The
upstream 1.1 source package is private: do not assume npm install works. Linux
Store requires a supported local filesystem. macOS needs a provisioned Docker
Linux worker; Windows needs the upstream WSL worker. Never download big binaries,
install Docker or change user data as an incidental setup step. Report missing
prerequisites instead. Full setup and boundary details: docs/layerfs.md.

For >1 GiB repositories with concurrent agents, import a stable baseline once:
- `layerfs {action:"create", workspace:"registered-source-workspace-id"}`. The selector
  resolves through Shadow's authorized local workspace route, not a path.
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

These IDs are **not registered host workspaces**. Ordinary read/write/exec and
use_project do not transparently target LayerFS in this first version. Use the
LayerFS-specific tool. `/workspaces/1` is a container path, never a local Folder.
Agents must receive IDs and explicitly call LayerFS; subagent cwd is not changed.
Remote Shadow executors are refused, with no Main fallback. Commands can access
whatever the configured LayerFS sandbox permits; this is not a universal sandbox.
LayerFS is disposable working state, **not a reliable backup**. Keep the original
source and independently backed-up durable outputs; source export/removal and
runtime provisioning are operator tasks outside this integration.

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
Search/use_project/host cwd do not support these IDs. Full contract: docs/layerfs.md.
