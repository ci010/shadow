---
name: workspace-fork
description: "Work in workspace forks/Git worktrees: select the right workspace, reuse pnpm dependencies safely, verify and hand off without implicit integration or cleanup."
core: true
metadata:
  category: tools
---

# Workspace forks and worktrees

Use when isolation is needed or a fork is assigned, not as mandatory task setup.
Reading this skill grants no permission or automatic setup/install.

## Target the right checkout

- Inspect status, applicable AGENTS.md, manifests, `packageManager`, lockfiles and
  configuration; preserve others' edits. For Git operations read `v:skills/git-github`.
- Discover `v:tools/workspace_fork`: source is a registered Workspace selector.
  Git requires an existing `baseRef` branch, forks its committed tip, never fetches
  or copies dirty files. LayerFS inherits its bound source branch; no fallback.
- Forking does not switch sessions: use the returned `workspaceId` explicitly or
  `workspace_use`. Remote/LayerFS display paths are not Main host paths.
  Manual Git worktrees belong beside the repo, not inside it; no bare conversion
  or special pnpm worktree command is required.
- For LayerFS work/integration read `v:skills/layerfs-worker` / `v:skills/layerfs-manager`;
  use live tool contracts rather than inventing mounts or lifecycle operations.

## pnpm hints

- Check pinned/installed versions and existing config first. The official
  [worktrees](https://pnpm.io/git-worktrees) and [global virtual store](https://pnpm.io/global-virtual-store)
  guides recommend `virtualStoreType: global` in `pnpm-workspace.yaml`; verify
  support in that pnpm version (older settings differ). Propose config changes,
  never silently mutate project/global policy; experimental symlink tooling needs testing.
- The content-addressable store caches contents; the global virtual store also
  shares dependency layouts. Each worktree still needs its own authorized install
  (usually `pnpm install --frozen-lockfile` for an unchanged lockfile). Do not
  auto-install/run lifecycle scripts or bypass lockfile/build approvals.
- Git does not copy dependencies: do not copy/symlink sibling `node_modules`.
  Writable shared stores require the same trust boundary. Resolve paths on the
  execution device/container; LayerFS reuse requires compatible platform/Node ABI
  and reachable internal links, never Windows store links into Linux.

## Verify and hand off

Test in the selected workspace; report workspace/branch, diff and check results.
Completed is not integrated. Recycle foundations are not automatic cleanup:
remove no worktree/branch merely on completion; require authorized cleanup,
verified ownership/integration and no unique edits. Preserve unknown failure state.
