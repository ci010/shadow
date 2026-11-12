---
name: layerfs
description: "LayerFS scenario navigation: assigned branch work, manager workspace/integration workflow, or owner-approved setup/import/recovery; flattened tool discovery."
core: true
metadata:
  category: tools
---

# LayerFS: choose the scenario

- Assigned branch coding/testing: read `v:skills/layerfs-worker`.
- Create/register branches, distribute work and review/integrate results: read
  `v:skills/layerfs-manager`.
- Connect/bootstrap, review/import a source, prepare a baseline or recover retained
  lifecycle failures: read `v:skills/layerfs-setup`, then its canonical guide
  [setup.md](setup.md) (`v:skills/layerfs/setup.md`).

These are workflow scenarios, not role-based tool visibility or permission gates.
An assigned worker normally needs only ordinary workspace tools, not setup tools.
A code-change request is not runtime approval. Reading skills installs nothing.

## Discovery follows the scenario

LayerFS tools are already flattened as independent names under `v:tools`.
After reading the relevant skill, search `v:tools` for `layerfs_` or read the
exact contract, for example `v:tools/layerfs_branches`, then call
`invoke_tool {name:"layerfs_branches",args:{}}` when that operation is needed.
For workspace creation read `v:tools/workspace_create`.
There is no public `layerfs {action:...}` router and no worker/manager/setup
source partition. Skill reads do not activate the builtin LayerFS factory;
exact-name invocation lazily loads the implementation. No preliminary source
initialization is required. The legacy `invoke_tool {source:"layerfs",args:{}}`
remains an optional contract-discovery fallback, not a provisioning step.

Use the live contract and existing authorization checks. Discovery is neither
connection, installation nor consent. Never fall back to Main, infer a host path
from a LayerFS location, replay unknown mutations, or clear retained evidence.
Keep independent backups; LayerFS is not a universal security sandbox or backup.
Full technical constraints and qualification limits: repository `docs/layerfs.md`.
