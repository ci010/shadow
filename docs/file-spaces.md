# File explorer sources

The document workbench starts with its file explorer collapsed, including on wide screens. An explicit initial-open setting, explorer toggle, or linked-file reveal can open it.

The explorer distinguishes two sources:

- **Project files**: the selected registered Folder, using its registry-backed API and owning device. Drafts use their selected Folder; existing conversations use the persisted `folderId` from the scoped session graph, including after reload. Without a selected Folder this root is omitted. Folder identity is never inferred from a local or remote workdir display path. Project Home is not a file resource and is never substituted here.
- **Session files**: the current session's managed storage directory (respecting its workspace owner), on Main. This is separate from its effective execution directory, including when execution is remote. The visible heading is localized; the physical path remains available in workspace details. No directory is renamed.

Session storage reads use the explicit `/api/sessions/:key/workspace/` namespace for directory listings, path searches, previews, raw/media bytes, static HTML assets and Git reads. These routes retain session existence and Folder-access authorization. Static assets retain the namespace in their path, rather than relying on a query parameter that relative asset URLs would lose. They resolve only the known session storage directory, never a renderer-provided absolute root.

Legacy `/api/sessions/:key/{files,preview,raw,static,git}` endpoints remain compatible: they browse effective execution directories, with the Home override for learning views. The new workbench does not use that compatibility override.

Open documents retain their originating source independently from the selected explorer root. Identical relative paths in Project files and Session files therefore have independent tabs, previews, archive reads and diffs. Context-menu paths and file-reference drags use the listing's verified workspace metadata. Explicit session storage never participates in the legacy shared-Home tree cache.
