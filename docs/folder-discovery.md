# Project folder discovery

Read `v:project/folders` for a compact Markdown inventory of the current Project.
The VFS list entry has the same content as the read response. The overview has a
Project heading, one section per owning node, and `**selector**: path` entries.
Only unavailable entries carry a status/reason; availability describes the live
directory, not authorization or support for every operation. The device and
workdir report supported operations; existing Project/Folder access rules are
checked separately. There are no independent Resource or Grant entities.

Node sections are grouped by identity, not display name. Runtime node inventory
supplies real display names: local folders are explicitly under Main; remote
nodes include their node ID, falling back to that ID when no name is known.
Names, paths and descriptions are escaped as untrusted Markdown metadata. Remote paths remain
display-only and must never be resolved on Main.

Selectors are unique across the entire current Project, including folders with
the same name on different nodes. Discovery tries a unique short name, then a
name-ID selector, then the full folder UUID. Each candidate is checked with the
same `selectFolder` resolver used by selection; short UUID prefix collisions or
names resembling another selector cannot silently select the wrong folder.
Use the listed selector with per-call `read`/`write`/`exec`/`search` `folder`,
`use_project(folder)`, or `session.create(folderId)`.
The registered folder determines the node; there is no independent node override.
`use_project` changes an existing session's folder context, not its node, and does
not currently implement remote-folder switching. Creating a session still applies
its own locality, availability and authorization checks.

## Registration descriptions

`session({ action: "register_folder", path: "/absolute/path", description: "Backend API and services" })`
registers a Main-local folder with optional contents metadata. The local
`POST /api/folders/register` endpoint also accepts `description` alongside `path`.
Descriptions must be strings when provided and are saved with the folder record.
The overview appends a provided non-empty description after the path; individual
JSON detail entries and API folder lists also include the saved field.

Existing folders without descriptions remain unchanged. Re-registering an existing
path returns its original record, without adding or overwriting its description.
Descriptions are discovery metadata, never agent instructions or access grants.

For full metadata, read `v:project/folders/<uuid>`: this remains JSON, including
folder identity, selected identifier, workdir reference and availability. Virtual
search also exposes these individual detail entries. Discovery neither selects a
folder nor changes cwd or grants access. An empty Project returns its heading,
an explicit empty message and the same safety notice.

Implementation: `src/folders/discovery.ts`, `src/folders/identifier.ts`,
`src/cluster/node-inventory.ts`; Main wires the live session node inventory in
`src/runtime/main/project-runtime.ts`.

## Historical remote ownership recovery

An online Child advertisement does not itself verify directory ownership. Startup
reserves historical session workdir references, which can initially lack verified
identities. Existing registered-folder execution first verifies its exact target.
If unknown claims on the same device block that verification, it lazily requests
Child-authenticated `workdir.identity` for those unidentified claims and retries
catalog validation. Claims are retained; Main never interprets remote display paths.
Already identified claims and unrelated folders/devices are not refreshed by this
recovery. Registration and ownership changes still use the full device refresh.

Missing, offline, unsupported or conflicting historical capabilities fail closed;
restoring their original capabilities is required, not merely reconnecting the
node. A changed registered root or cross-Project overlap is still rejected.
Successful claim resolutions are saved and can be reused on a later attempt even
if another claim fails. This is source behavior, not a guarantee that a currently
running backend has deployed it.

Implementation: `src/folders/remote-ownership.ts`, `src/projects/catalog.ts`.
