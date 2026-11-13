# Workspace lineage and lifecycle

`workspace_fork` derives a registered Workspace without switching the caller.
New Git worktrees (local or remote) and registered-source LayerFS forks record
version-1 lineage: the direct parent Workspace ID, backend, and Shadow-derived
ownership. Recursive forks keep the immediate parent, not the original repository.
The parent is selected by registered identity, never inferred from paths, names,
Git common-directory sharing, or description strings.

The catalog remains version 2 with an optional, validated `lineage` extension.
Old records without lineage remain independent roots with unknown ownership;
no automatic ownership migration is attempted. Legacy `workspace_create` Git
creation also records lineage. Legacy LayerFS creation accepts a raw imported
branch rather than a registered source, so it remains lineage-unknown; use
`workspace_fork` for registered-parent lineage.

## Discovery

`read('v:project/workspaces')` is a Markdown nested list, recursively arranged by
direct parent. Each entry carries backend/node and availability labels. Node names
are labels, not grouping or identity keys. An unavailable/missing parent does not
hide its children: they appear as roots marked `parent unavailable`. Corrupt legacy
cycles are rendered once, with a cycle marker, rather than recursing forever.

Active registrations are shown by default. Existing catalog retirement records
are archive tombstones, preserving IDs and lineage after unregister/move.
`v:project/workspaces/archive` reads archived metadata; an exact historical
`v:project/workspaces/<id>` resolves its tombstone when no active registration
exists. This never grants resource access or reports the retired resource as
available. Archive metadata may refer to a still-existing physical checkout.
Archives are not included in default search/list enumeration.

## Completion is not reclamation

Work completion alone does not close, unregister, or delete a Workspace. Existing
registration-removal paths retain catalog tombstones and enforce their existing
Project activity/unknown-remote-job checks. They do **not** physically reclaim Git
worktrees or LayerFS branches, and do not prove current-tip integration.

`assessWorkspaceRecycle` is an internal, pure fail-closed assessment foundation,
not a tool, deletion service, authorization token, or claim that storage was
reclaimed. It requires verified Shadow-derived Git identity, no remaining tracked,
untracked or ignored changes, no active/unknown sessions or commands, no unknown
operations, and safe Git ancestry evidence for the exact current tip. Stale
integration and squash/rebase evidence fail closed. LayerFS cleanup is unsupported:
branches and recovery journals are retained. The assessment never consumes Work
completion as evidence.

Physical recycle and automatic integration hooks are deliberately **not wired**.
A future backend operation must obtain a resource-specific admission barrier that
excludes new local/remote sessions and exec commands, reconcile in-flight/unknown
operations, verify retained creation receipts and live Git identity, inspect all
filesystem changes, and query fresh tip ancestry against the intended integration
target while holding that barrier. It must repeat checks at the mutation boundary,
use supported backend removal capabilities without force or session termination,
and atomically retain a durable archive/lineage journal across partial failures.
The current assessment booleans are not substitutes for those live checks. LayerFS
additionally needs supported integration evidence and deletion APIs before any
physical cleanup can be offered.
