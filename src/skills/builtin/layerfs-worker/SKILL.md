---
name: layerfs-worker
description: "Work and test in an assigned LayerFS branch with ordinary read/write/search/exec; checkpoint and failure boundaries. No installation management."
metadata:
  category: tools
---

# LayerFS worker

Use this scenario after a manager supplies a registered branch-backed workspaceId.
Use ordinary `read`, `write`, `search` and `exec` with that workspace selector,
or `workspace_use` for ongoing work. Children inherit the selected workdir.
Read root AGENTS.md if not already loaded and nested instructions before entering
subtrees. Display locations and `/workspaces/1` are never Main host paths.
Never fall back to Main. Do not install, connect, import, provision or repair the
runtime for an assigned coding task: report the blocker to the owner/manager.
For branch creation/integration read `v:skills/layerfs-manager`; for lifecycle
work the authorized owner reads `v:skills/layerfs-setup`.

No LayerFS-specific discovery is needed for ordinary work. The assigned version 3
workspace binds one exact owning Project/runtime/resource/project/branch.
Do not substitute a raw branch or namespace. For catalog diagnostics, the manager
uses `layerfs_resource_inspect` with the exact resourceId; reading a skill is guidance,
not permission or runtime activation. Old mount-status repair tools are not public
workflow intents.

## Work, test and checkpoint

Files use official @layerfs/agent v1.1 fs APIs against the committed branch, not
shell/Python file emulation. UTF-8 reads are bounded to 256 KiB; SDK pages are
assembled, clipped lines or changed snapshots are refused. Binary/image reads
and encoding conversion are unsupported. Root AGENTS.md must be complete and
within the instruction bound (128000 bytes); no partial instructions are loaded.
Writes (64 KiB maximum) overwrite or exact-unique edit and create a checkpoint
automatically. No append, global replacement, BOM conversion, newline-normalized
match, or host edit patch is promised. Parent directories must exist; explicitly
run exec `mkdir -p` (auto-checkpoint) before writing a new nested path. No hidden
shell mkdir or fs.mkdir/fs.apply tool is provided. Main is readonly: fork first.

Search uses SDK glob or **literal** grep (not regex); no include filter. Directory
and search receipts preserve items/hasMore/nextPagePos, binary skipped counts and
lineTruncated markers. Continue search offset=nextPagePos; directory read
 offset=nextPagePos+1. No rg installation is needed.

Exec supports sh/bash, args and branch-relative cwd. It creates a sandbox, mounts
the current branch, runs once, checkpoints changes **even on nonzero command exit**,
unmounts without discard and closes the sandbox. The command's nonzero exit is
still a tool failure, with its checkpoint receipt. Follow the live exec contract's
wait-window and background rules; leaf calls cannot detach work. Where the owning
session supports background transfer, it retains the same complete lifecycle.
Do not resubmit. Read v:bg for owned background output. Cancellation or lost receipts retain the
journal/mount for reconciliation; neither cancellation nor UNKNOWN means rollback.
No automatic forced cleanup runs on an aborted signal. The tool shell=node runtime is unsupported; installed Node commands inside sh/bash are ordinary sandbox commands.

Independent branches support concurrent file operations and full exec lifetimes.
Same-branch overlap is refused while reserved. Workspace forks reserve source + output;
merge reserves both inputs + output; publish reserves source + main. Durable
branch-scoped reservations/journals survive restart and UNKNOWN without blocking
unrelated branches. Known unrelated mounts are allowed; matching mounts (even
clean), missing branch metadata or unreadable inventory fail closed. Ownership is
from official SDK branch metadata, never a mount number/path. Unknown native sandbox
allocation may retain upstream create.intent and block new exec starts globally;
unrelated committed-file tools can still proceed. No guard is automatically cleared.
Do not mutate this Project concurrently through an external SDK/client; Shadow's
coordination is not a cross-client transaction.
Scoped skill/MCP and UI file/Git routes remain unsupported; no Main fallback.

There is no persistent mount to manually commit/close for new workspaces.
Report the workspace/branch, changed files, test results, checkpoint receipts and
any retained UNKNOWN/background execution ID. Do not claim a failed command
rolled back changes. Legacy mount IDs require manager reconciliation, not worker
migration, inferred branch IDs or ad hoc cleanup.

Unknown receipts are not rollback evidence; daemon commands may continue. Never
replay mutations automatically or edit/delete private profiles, journals, staging
or Store resources. LayerFS is disposable working state, not a reliable backup
or universal security sandbox. Preserve original and durable backed-up outputs.
Full approval/recovery constraints: `v:skills/layerfs/setup.md`.