# Project folder discovery

Read `v:project/folders` for a compact Markdown inventory of the current Project.
The VFS list entry has the same content as the read response. The overview has a
Project heading, one section per owning node, and `**selector**: path` entries.
Only unavailable entries carry a status/reason; availability describes the live
workdir capability, not authorization or support for every operation.

Node sections are grouped by identity, not display name. Runtime node inventory
supplies real display names: local folders are explicitly under Main; remote
nodes include their node ID, falling back to that ID when no name is known.
Names and paths are escaped as untrusted Markdown metadata. Remote paths remain
display-only and must never be resolved on Main.

Selectors are unique across the entire current Project, including folders with
the same name on different nodes. Discovery tries a unique short name, then a
name-ID selector, then the full folder UUID. Each candidate is checked with the
same `selectFolder` resolver used by selection; short UUID prefix collisions or
names resembling another selector cannot silently select the wrong folder.
Use the listed selector with `use_project(folder)` or `session.create(folderId)`.
The registered folder determines the node; there is no independent node override.
`use_project` changes an existing session's folder context, not its node, and does
not currently implement remote-folder switching. Creating a session still applies
its own locality, availability and authorization checks.

For full metadata, read `v:project/folders/<uuid>`: this remains JSON, including
folder identity, selected identifier, workdir reference and availability. Virtual
search also exposes these individual detail entries. Discovery neither selects a
folder nor changes cwd or grants access. An empty Project returns its heading,
an explicit empty message and the same safety notice.

Implementation: `src/folders/discovery.ts`, `src/folders/identifier.ts`,
`src/cluster/node-inventory.ts`; Main wires the live session node inventory in
`src/runtime/main/project-runtime.ts`.
