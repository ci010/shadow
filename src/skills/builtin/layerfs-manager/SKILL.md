---
name: layerfs-manager
description: "Create and assign LayerFS workspaces from registered immutable resources; integrate with explicit official SDK scripts."
metadata:
  category: tools
---

# LayerFS manager

Read `layerfs_resource_list` / `layerfs_resource_inspect` contracts. An existing
registration is identity-checked, not a claim that dependencies or tests passed.
Missing resources: the authorized owner follows `v:skills/layerfs-setup`.

## Create and assign

Read `v:tools/workspace_create`, then invoke:
`invoke_tool {name:"workspace_create",args:{backend:"layerfs",source:"EXACT_RESOURCE_ID",idempotencyKey:"task-stable-key"}}`.
`source` is the registration's revision/ID, not main, a moving branch, SDK module or
host path. Optional `branch` names the new branch. Creation forks the exact immutable
baseline, mints a resource-bound identity and registers a normal workspace ID.

`workspace_fork` selects an existing registered workspace and inherits its exact
resource binding and current branch; it accepts no foreign baseRef. Unknown creation
cannot be replayed with another key. Assign scopes and tests explicitly. Use ordinary
workspace selectors/`workspace_use`, not manually encoded LayerFS identities.

Legacy mount records are preserved but ordinary tools refuse them. Version 3 IDs
must have been minted by the current Project's resource service. No namespace fallback,
implicit installation, catalog migration or cleanup occurs.

## Inspect and integrate

Use the owner's `layerfs_runtime_context` launcher and explicit SDK scripts shown in
`v:skills/layerfs/setup.md`: `open(officialProject)` gives the real agent SDK client.
Call `project.list_branches`, `branch.list_commits`, `branch.diff_branches`, `branch.merge` and
`branch.publish` directly as needed; consult pinned official signatures rather than
inventing adapters. Always close the client in finally; one client per exec process.

In the setup guide's `open`/`finally close` script, use these bodies in **separate
exec invocations**, substituting actual branch names:

```js
// Read-only history / diff (keep paging while hasMore):
console.log(JSON.stringify(await client.branch.list_commits("feature-a", 100, 0)));
console.log(JSON.stringify(await client.branch.diff_branches("main", "feature-a", 100, 0, {hunks:false})));
```

```js
// Only when a merge is requested; choose a new integration name:
const merged = await client.branch.merge("feature-a", "feature-b", "integration-1", "Reviewed integration");
if (merged.kind !== "Merged" || merged.branch !== "integration-1" || merged.conflicts?.length) throw Error("Merge not confirmed; inspect receipt");
console.log(JSON.stringify(merged));
```

After inspecting and testing that integration branch, a separately authorized
publication invocation uses:

```js
const receipt = await client.branch.publish("integration-1");
if (!["Added", "UpToDate", "NoChanges"].includes(receipt.kind)) throw Error("Publication not confirmed; do not replay");
if (receipt.kind === "Added" && !receipt.publishedLayer?.id) throw Error("Missing published Layer identity");
console.log(JSON.stringify(receipt)); // review overwroteCount/overwrote too
```

These are official SDK calls, not internal tools or a bundled mutation pipeline.
Review changed content and actual test results. Merge to a new integration branch;
inspect conflicts and test that result before publication. Publish updates LayerFS
main only, never host source files. It is not a Git push or source checkout merge-back.
Registration baselines remain fixed after publication. Register a new immutable
resource if a different baseline is deliberately selected.

Independent ordinary-tool branches can run concurrently. Overlapping ordinary-tool
operations are reserved and unknown receipts block replay. Do not run external SDK
mutations concurrently against branches used by ordinary tools: the host's coordination
journal is not a cross-client transaction. Finish/inspect external operations before
handing the resource back. Never clear reservations by hand.

Synthetic fixtures are not real SDK/image/import qualification. Report tests actually
run and preserve backups; LayerFS is not a universal security sandbox or backup service.
