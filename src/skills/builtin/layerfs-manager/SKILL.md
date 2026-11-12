---
name: layerfs-manager
description: "Create and assign LayerFS branch workspaces, inspect results and integrate committed branches; no implicit setup/import."
metadata:
  category: tools
---

# LayerFS manager

Use this scenario for branch/workspace coordination after approved setup and a
successful source import. If either is missing, the authorized owner must read
`v:skills/layerfs-setup`; branch creation never implicitly installs or imports.
Read `v:skills/layerfs-worker` for ordinary file/exec capabilities and limits.

## Create and assign

Read `v:tools/workspace_create`, then invoke the exact name, for example:
`invoke_tool {name:"workspace_create",args:{backend:"layerfs",source:"main",idempotencyKey:"task-stable-key"}}`.
Optional `branch` names the new branch. `source` is an existing LayerFS branch,
**not a host path or registered host workspace**; no `ref` field is exposed here.
The tool forks and registers a versioned branch-backed workspace without a
persistent mount and returns a regular `workspaceId`. Preserve the stable key;
uncertain creation is not permission to replay with a fresh key. Confirmed
binding registration can be retried with the same key under the live contract.

Assign independent branches to parallel workers, with the returned workspaceId,
bounded scope and expected tests/results. Select via ordinary per-call workspace
or `workspace_use`; children inherit selected workdir. Do not pass container paths
as host workspaces or infer identities. Root/nested AGENTS.md still apply.
Failures never fall back to Main. Main is readonly; fork before file writes/exec.

## Inspect and integrate

Tools are flattened independently in `v:tools`. Read the exact contract needed,
such as `v:tools/layerfs_branches`, then use
`invoke_tool {name:"layerfs_branches",args:{}}`. No source initialization or
skill tool aliases are required; reading this skill grants no permissions.

- `layerfs_status` inspects workspace phase evidence; `layerfs_history` and
  `layerfs_diff` inspect committed state (diff has no hunks). Review worker test
  results and checkpoint receipts; file writes checkpoint automatically and exec
  checkpoints even nonzero exits. Command failure is not rollback.
- `layerfs_fork` and `layerfs_load` create new branches; load restores a historical
  ref into a new branch, never an in-place rollback.
- `layerfs_merge` creates an integration branch. Inspect conflicts, test and review
  before `layerfs_publish`. Ordinary testing needs a registered branch workspace;
  workspace_create forks from the integration branch, so publish the actual
  reviewed/tested resulting branch, not an assumed unchanged predecessor.
- Publish updates LayerFS main only, never host source files. Export/merge-back
  and project/volume removal are not automated. Preserve durable backed-up outputs.

Independent branches run concurrently; same-branch overlap is refused while
reserved. Fork/load reserve source + output; merge reserves both inputs + output;
publish reserves source + main. Durable reservations/journals retain UNKNOWN.
Known unrelated mounts are allowed; matching mounts (even clean), missing branch
metadata or unreadable inventory fail closed. Unknown native sandbox allocation
may block new exec starts globally while unrelated committed-file tools remain
available. Never clear guards or infer ownership from mount numbers/paths.
Do not use concurrent external SDK writers; coordination is not cross-client.

## Legacy and failures

Legacy mount records are preserved but ordinary tools refuse them. Inspect the
known mount, explicitly checkpoint/close it, then create a branch workspace from
its known branch. `layerfs_mount`, `layerfs_commit` and `layerfs_close` are legacy
maintenance, not ordinary file routing; close refuses dirty mounts with no force
or discard. New workspaces have no persistent mount to manually commit/close.

Unknown receipts may leave daemon work running. Do not automatically replay,
force cleanup or edit/delete private profiles, journals, staging or Store data.
Retained failures need explicit reconciliation; the owner reads
`v:skills/layerfs-setup` and `v:skills/layerfs/setup.md` for guarded lifecycle
recovery, not improvised journal removal. Scoped skill/MCP and UI file/Git/media
routes and remote Shadow executors remain unsupported; no Main fallback.
LayerFS is disposable working state, not a reliable backup or universal sandbox.
