---
name: layerfs
description: "Thin LayerFS integration: ordinary workspace tools, immutable resource registration, and official SDK workflows through exec."
core: true
metadata:
  category: tools
---

# LayerFS: choose the scenario

- Assigned workspace: read `v:skills/layerfs-worker`.
- Create/assign workspaces and integrate results: read `v:skills/layerfs-manager`.
- Installation, official Git/Docker/SDK preparation and resource registration:
  read `v:skills/layerfs-setup`, then [setup.md](setup.md).

These are workflow scenarios, not role-based tool visibility or permission gates.
Skill reads do not activate the builtin LayerFS factory. No preliminary source
initialization is required. Read exact flattened contracts at `v:tools/<name>`.
For example read `v:tools/layerfs_resource_list`, then
`invoke_tool {name:"layerfs_resource_list",args:{}}`.

A registered resource binds a name, runtime, official LayerFS project, immutable
baseline Layer, image ID and supplied repository/commit provenance. Multiple
repositories/images coexist within one Shadow Project without an active namespace.
Registration checks official identity/existence, not recipe smoke or source truth.

Read `v:layerfs/overview` for bounded read-only branches/history/immutable diffs.
Lazy `layerfs_fs_*` contracts expose mkdir/rm/cp/mv/apply/diff_files/blame on
registered workspaces without extending ordinary tool schemas.

Git fixed checkouts/LFS, Docker builds and standard LayerFS init/merge/publish
are explicit ordinary exec scripts, not bundled business tools. Any direct authorized session in the same Project
obtains a thin SDK launcher from `layerfs_runtime_context`; setup.md gives runnable
scripts. Installation and approved runtime lifecycle remain host-owned. Workers
use ordinary tools with registered workspace IDs, never host paths as LayerFS cwd.

No replay of unknown effects, manual lock clearing or deletion of old resources.
Current boundaries and verification: `docs/layerfs.md`.

Selecting a registered LayerFS workspace and actual ordinary/`layerfs_fs_*` filesystem operations lazily ensure its previously-ready runtime. Selection failure retains the prior context; session history, listings, status and read-only VFS observation do not activate. Installation, first startup and Init still require their explicit approval paths.
