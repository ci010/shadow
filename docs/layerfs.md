# Optional LayerFS 1.1 integration

Shadow includes an opt-in dynamically imported `layerfs` tool and the builtin
`layerfs` skill. It does not ship or install the LayerFS SDK, native addon,
Linux daemon, runtime image, Docker, worker or WSL. This is a real SDK bridge,
not a file-copy snapshot implementation. No npm dependency was added.

## Operator prerequisites

Upstream: [Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs).
The source `api/agent/package.json` currently identifies `@layerfs/agent` 1.1.0
as **private** (GitHub API inspection at commit
`35d36575c1eb4d23d4b54534a7030d855db890e7`, 2026-11-04); a source guide is not evidence of an npm release or a working
local installation. Build/install upstream artifacts separately following its
current guide and licensing. Select the actual built JS entry (`api/agent/src/index.js`
in that source layout), not an arbitrary module suggested by a model.

- Linux Store calls require Linux and a supported local shared filesystem
  (ext4/xfs/btrfs); a network filesystem or macOS filesystem is not a Linux Store.
- macOS requires Docker and the upstream provisioned Linux worker endpoint.
- Windows requires the upstream WSL worker route and its configured distribution.
- Sandbox Docker Engine must satisfy upstream's API requirements (1.48+ in 1.1).
- Provision a separate private LayerFS home, Store path and volume per Shadow
  Project. The adapter rejects identical configured home/Store/volume strings
  across Projects; operators must also avoid filesystem aliases to shared data.
- Provision the image, volume, daemon and worker before calling this tool.
  This version does not implement `@layerfs/runtime` provisioning or project removal.

Set `SHADOW_LAYERFS_CONFIG` in the Shadow backend's environment to an absolute
operator-owned JSON file, outside model-editable workspaces. Do not put credentials
in it. The model cannot select SDK modules, environment variables or source paths.
Example (replace placeholders with an actual, separately provisioned installation):

```json
{
  "projects": {
    "YOUR-SHADOW-PROJECT-ID": {
      "sdkModule": "/opt/layerfs/api/agent/src/index.js",
      "env": {
        "LAYERFS_HOME": "/private/operator/layerfs-project-a",
        "LAYERFS_STORE_PATH": "/layerfs-store/global/store.sqlite",
        "LAYERFS_VOLUME": "operator-provisioned-project-a-store",
        "LAYERFS_IMAGE": "sha256:REPLACE_WITH_REAL_IMMUTABLE_DIGEST",
        "LAYERFS_DAEMON": "/opt/layerfs/layerfs-daemon"
      }
    }
  }
}
```

On macOS/Windows also set `LAYERFS_WORKER_ENDPOINT`; Store paths then refer to
the worker's Linux filesystem, not the host. Complete platform settings must come
from the upstream installation, not this illustrative example. The exact allowed
keys are `LAYERFS_HOME`, `STORE_PATH`, `DOCKER`, `IMAGE`, `VOLUME`, `DAEMON`,
`NATIVE`, `WORKER_ENDPOINT`, `CONTAINER_PREFIX`, `DAEMON_HOST`, `STORE_POLICY`
(all prefixed `LAYERFS_`). Other keys are refused. Inherited `LAYERFS_*` variables
are stripped from each bridge child before explicit Project settings are applied.
Other normal host environment variables remain inherited; the child is not an OS
security sandbox. SDK singleton state is confined to that child.

SDK project names are deterministic: `shadow-` plus the first 40 hexadecimal
characters of SHA-256 of the Shadow Project ID. Use that exact name if provisioning
an existing upstream project. `create` explicitly calls `LayerFS.init`; subsequent
operations call `LayerFS.open` and never reacquire/overwrite source. Source is
resolved only through the host's authorized registered local workspace selector
with the existing `filesystem.read` operation. This authorizes selecting the source
workspace, not a new remote grant. Init recursively reads the entire selected tree,
including dotfiles and untracked files: use a curated credential-free source. This
adapter does not implement ignore rules or a credential scanner.
Remote targets fail without fallback. SDK home ownership checks remain upstream.

## Workflow and API

Read `v:skills/layerfs`, discover/import `v:tools/layerfs`, then invoke `layerfs`:

1. `create` with `workspace` = registered source selector. Source is read for Init;
   no original files are overwritten. Initialization has a 300-second SDK deadline.
2. `fork` with `branch` and optional baseline `ref` (use a fixed ref for concurrent
   agents). `load` requires a historical `ref` and a **new** `branch`; it is not an
   in-place rollback. For >1 GiB multi-agent jobs, share baseline Store data and
   give every agent its own branch and mount, rather than copying the whole tree.
3. `mount {branch}` creates one sandbox and mounts one workspace. Its response
   contains a Project-bound `layerfs:`-prefixed `workspace` ID for ordinary tools. Container paths are informational.
4. `read {workspace,path,start?,end?}` reads 200 lines by default, maximum 1000.
   `write {workspace,path,content}` replaces one sandbox file, at most 64 KiB text.
   These use sandbox POSIX `sed`/`printf` through the public SDK exec API; the image
   must provide those commands. Write creates parent directories. Paths reject `..`.
   Symlinks and other sandbox access follow upstream/container semantics.
5. `exec {workspace,command,message?}` executes in that workspace; run tests here.
   `commit {workspace,message?}` checkpoints through `workspace.commit`, without
   force. `history {branch,offset?}` lists saved commits.
6. `diff {ref,branch,offset?}` compares branches without hunks; `merge
   {ref,branch,name,message?}` creates a named integration branch. Conflicts are
   returned by SDK without automatic resolution. Test the merged branch in a new
   mount before publishing. `publish {branch,ref?}` changes **LayerFS main only**.
7. `close {workspace}` calls unmount with discard=false and force=false. Dirty
   deletion is refused by upstream; commit first. Clean temporary mounts are
   removed; upstream expires idle empty sandboxes. Store, branches and saved
   commits are retained. There is deliberately no destructive force/remove API.

`list` lists sandboxes; `branches` lists branches; `status {workspace}` lists the
workspace's sandbox records, including activity/changed. Find the matching path.
List/history/diff use pages of 100, with optional nonnegative `offset`.

## Ordinary read/write/exec contract

- `read {workspace,path,offset?,limit?}` supports relative UTF-8 regular text files,
  positive 1-based offset (default 1), limit 1–1000 (default 200). Unlike host reads,
  omitted ranges mean the **first** 200 lines. Directory listing, image/binary
  input, numbering/list/raw flags and non-UTF-8 encodings are rejected, not emulated.
  UTF-8 decode is strict; a clipped multibyte character may require a smaller range.
- `write {workspace,path,content}` supports UTF-8 full overwrite (64 KiB), creating
  parents. `encoding:"utf8"` is accepted. match, append/global flags, legacy edits
  and BOM encoding are rejected **before** dispatch. Historical records use the
  opaque LayerFS URI, never a fake host target; prior bytes/diff are explicitly
  unavailable and written content is retained for view_edit. No record sink means
  the receipt explicitly reports history was not recorded.
- `exec {workspace,script,shell?:"sh"|"bash",cwd?,timeout_ms?}` executes a quoted
  script in the sandbox. Default shell is sh, irrespective of host OS. cwd is a
  relative subdirectory, default `.`; absolute/traversing cwd is refused. args,
  node and other runtimes, background timeout 0 and leaf-call execution are
  unsupported and rejected before dispatch. timeout is 1–300000 ms, default 120000.
  This is a **receipt deadline**, not host exec's background-on-timeout behavior:
  timeout/cancellation raises UNKNOWN; daemon commands may continue. Do not retry.
- Relative symlinks resolve inside the upstream sandbox; this is not a new host
  filesystem sandbox. File helpers require POSIX sh, sed, grep, mkdir and printf
  in the image. Outputs retain SDK code and bounded stream/truncation metadata.
- Malformed, foreign-Project or stale IDs never fall back to Main. Registered
  Workspace selectors still use the existing authorization/locality resolver.

## Safety and integration limits

- LayerFS IDs are not host workspace registrations. Ordinary read/write/exec accept
  the mount ID in `workspace`; use_project, search and child cwd do not. Never
  register `/workspaces/1` as a host Folder or pass it as a host cwd. There is no
  host export, automatic source merge-back, or remote route. Old unprefixed opaque
  IDs remain supported by the dedicated layerfs tool only, never guessed by ordinary tools.
- Only one operation per workspace is admitted; overlapping calls fail busy before dispatch (wait for the receipt, do not replay). different workspaces can run in
  parallel. Project management operations have a separate lock. Commands have a 330-second
  bridge deadline. Cancellation kills the bridge, **not necessarily the daemon
  command**. Lost/invalid receipts, SDK Unknown, abnormal bridge exit, or oversized
  protocol output raise outcome-unknown; nothing is automatically resent.
  Inspect status/history and reconcile manually before retrying any mutation.
- Exec uses SDK Writable sinks; each output stream retains only 64 KiB with total
  byte counts and truncation markers. The protocol is limited to 1 MiB. SDK pages
  and daemon/native buffers remain under upstream control.
- Mount failure can leave a newly created sandbox: inspect `list`; do not blindly
  replay mount. No project/volume removal is automated here.
- Definite SDK error receipts are marked as completed tool failures (`isError`),
  preserving code/detail; SDK Unknown still raises outcome-unknown. A refusal may follow earlier effects;
  errors are not general rollback guarantees. Conflicts require human/agent review.
- LayerFS working state is disposable, not a reliable backup. Keep source and
  independently backed-up durable outputs. Credentials must not enter snapshots.

## Verification scope

Focused tests use a synthetic SDK to verify real child-process dispatch, bounded
Writable capture, Project-bound selectors, dirty unmount arguments, cancellation,
abnormal exit and local/remote admission guards. They do not prove upstream Store,
Docker, WSL, conflict resolution or runtime provisioning works on this machine.
No SDK, daemon or image was installed to perform those tests.
