---
name: layerfs-setup
description: "Owner lifecycle workflow for LayerFS connect/bootstrap, Git-aware imports, separate baselines and guarded recovery; exact approvals required."
metadata:
  category: tools
---

# LayerFS setup, import and recovery

Read the canonical bundled guide `v:skills/layerfs/setup.md` before any lifecycle
operation. It retains the exact bootstrap, existing-installation, source-review,
baseline, quarantine, diagnostic and operator-environment procedures and limits.
Return to `v:skills/layerfs-manager` after successful import and to
`v:skills/layerfs-worker` for ordinary assigned branch work.

Tools are already flattened under `v:tools`; read the exact contract, for example
`v:tools/layerfs_connect`, then use `invoke_tool {name:"layerfs_connect",args:{}}`
when authorized to reuse/connect. No source initialization is required and reading
this skill does not activate the builtin factory or start a worker. Scenario
names do not partition sources or grant role-based permissions. Host owner-session,
workspace and recorded approval checks still govern the operation.

Reuse the approved installation. A missing installation returns a first-run plan,
not a request for SDK paths, environment edits or ad hoc shell installers.
A code-change request is not runtime approval. For `needs_approval`, ask with the
exact returned approvalRequest and wait for the recorded human answer. Bootstrap
requires its session-bound plan, approval reference and approved/allowRootWorker/
allowDownloads flags; flags alone are not consent. This can be a lengthy multi-GiB
pinned build with root WSL execution, not OS/WSL/Docker installation.

Import uses one Git-aware selection: tracked working-tree files (even matching ignore
rules), nonignored untracked files, and standalone `.git` metadata. Git enumerates names
with `ls-files --cached --others --exclude-standard`; no manual ignore parser or
directory/credential-name blacklist. `dist` and `build` follow those same rules.
Dependency reuse exception for the Linux target: source OS comes from the actual source
execution device (the Windows staging helper passes `win32` explicitly, never its WSL
host OS). Linux-source `node_modules` are included even when Git-ignored, to reuse
installed dependencies; all other ignored entries remain excluded. Non-Linux or
unknown-source `node_modules` are excluded even when tracked; the unchanged index can
therefore show working-tree deletions. This is a dependency-specific compatibility rule,
not a general directory blacklist. Symlinks remain refused, including local dependency
links; no external dependency dereferencing and no automatic installs. Linux-to-Linux
does not guarantee matching CPU architecture or ABI. This is not an exact clone: local
changes and nonignored untracked files enter, and working-tree deletions remain deleted.
Non-Git folders include every safe entry; `.gitignore` is not interpreted there. Preview
is advisory; no manual content review, token or acknowledgement is required. Legacy
`curated`/`whole_tree` are aliases for `git`; old review fields are ignored. Standalone
Git metadata is retained unchanged; external `.git` pointers, linked worktrees and
alternate object stores are refused. Symlink, containment, authorized workspace and
scan-limit checks remain. No automatic dependency installation; cross-OS native
dependencies may be incompatible. Setup/install permissions remain separate. The
original source and index are not modified; staging is filtered before SDK Init. A
mutable source still requires stability during copy, not a secret-free certification.

Wait for background completion, never poll/replay; then continue the original task.
Cancellation or unknown receipts do not prove native work stopped or rolled back.
Retain profiles, journals, staging and Store resources. Bootstrap probe recovery,
connection recovery and failed-import quarantine have distinct guarded procedures;
never substitute one for another or clear private state manually.

`layerfs_doctor` checks configuration only; `layerfs_runtime_status` never starts
a worker. `ready:true` is connectivity, not passing sandbox tests. Session sleep
does not stop the Project worker. An explicit SHADOW_LAYERFS_CONFIG takes
precedence without fallback. LayerFS is not a backup or universal security sandbox.
