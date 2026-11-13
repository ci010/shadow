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

Git fixed checkouts/LFS, Docker builds and standard LayerFS init/history/merge/publish
are explicit ordinary exec scripts, not bundled business tools. The runtime owner
obtains a thin SDK launcher from `layerfs_runtime_context`; setup.md gives runnable
scripts. Installation and approved runtime lifecycle remain host-owned. Workers
use ordinary tools with registered workspace IDs, never host paths as LayerFS cwd.

No replay of unknown effects, manual lock clearing or deletion of old resources.
Current boundaries and verification: `docs/layerfs.md`.
