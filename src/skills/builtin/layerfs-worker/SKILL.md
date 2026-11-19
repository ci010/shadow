---
name: layerfs-worker
description: "Work and test in an assigned LayerFS branch with ordinary workspace tools and lazy official FS operations."
metadata:
  category: tools
---

# LayerFS worker

Use the assigned registered workspace selector with ordinary `read`, `write`,
`search`, `exec`, or `workspace_use`. Children inherit the selected workdir.
Read applicable AGENTS.md before editing. Workspace display paths are not host paths.
For workspace creation/integration use `v:skills/layerfs-manager`; missing runtime
or resource bindings go to the owner, not a host-filesystem fallback.

## Files and inspection

Files use official committed-state SDK APIs. UTF-8 reads are bounded to 256 KiB
and reject clipped lines or changing snapshots. Binary/image reads and encoding
conversion are unsupported. AGENTS.md must fit the complete 128000-byte instruction
bound. Writes (64 KiB maximum) overwrite or exact-unique edit and auto-checkpoint;
append, global replacement and newline/BOM conversion are unsupported. Main is readonly.

Read `v:tools/layerfs_fs_mkdir`, `layerfs_fs_rm`, `layerfs_fs_cp`, `layerfs_fs_mv`,
`layerfs_fs_apply`, `layerfs_fs_diff_files` or `layerfs_fs_blame` for lazy official
FS contracts, then invoke the chosen tool with the registered workspace selector.
Mkdir creates parents; apply publishes 1–100 ordered text changes atomically
(64 KiB request bound). Copy/move destinations must not exist.

Search is SDK glob or **literal** grep, without an include filter. Receipts retain
items/hasMore/nextPagePos, binary skips and lineTruncated. Continue search with
offset=nextPagePos; directory read with offset=nextPagePos+1.
Read `v:layerfs/overview` for read-only branch/history/immutable-diff inspection.

## Exec and coordination

Exec supports sh/bash, args and branch-relative cwd. Each call selects a live
same-project/deployment/image sandbox with capacity (or creates one), mounts the
branch, runs once, checkpoints **even on nonzero exit**, and unmounts without discard.
Nonzero remains a tool failure with its checkpoint receipt. Sandboxes are reused,
not closed per call; upstream closes them after two idle minutes without mounts.
Commit does not require unmount. `shell: "javascript"` computes in an authorized Main worker; its bound `@shadow/exec` calls still use sh/bash on the branch and checkpoint normally. Installed Node commands inside sh/bash are ordinary commands, not JavaScript bridge code.

Follow the exec wait-window/background contract; inspect owned output at `v:bg`.
Independent branches can overlap; same-branch operations are reserved. Unknown or
cancelled operations retain journals/mount evidence and are not rollback evidence.
Do not replay uncertain mutations, clear reservations or mutate coordinated branches
concurrently through external SDK clients. Canonical recovery and approval reference:
`v:skills/layerfs/setup.md`. Scoped skill/MCP and UI/Git routes remain unsupported.

Report workspace/branch, changed files, actual tests, checkpoint receipts and any
retained UNKNOWN/background execution ID. LayerFS working state is not a backup.
