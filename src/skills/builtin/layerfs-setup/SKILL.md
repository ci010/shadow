---
name: layerfs-setup
description: "Owner lifecycle workflow for LayerFS connect/bootstrap, reviewed imports, separate baselines and guarded recovery; exact approvals required."
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

Source import is separate: metadata preview is not a content/secret scan. Review
contents, keep the source stable and use the matching single-use sourceReview and
sourceReviewed acknowledgement with the exact importPolicy. Neither policy
silently filters files or bypasses credential/symlink checks. Never strip the
original checkout to pass review; use the separately approved baseline workflow.

Wait for background completion, never poll/replay; then continue the original task.
Cancellation or unknown receipts do not prove native work stopped or rolled back.
Retain profiles, journals, staging and Store resources. Bootstrap probe recovery,
connection recovery and failed-import quarantine have distinct guarded procedures;
never substitute one for another or clear private state manually.

`layerfs_doctor` checks configuration only; `layerfs_runtime_status` never starts
a worker. `ready:true` is connectivity, not passing sandbox tests. Session sleep
does not stop the Project worker. An explicit SHADOW_LAYERFS_CONFIG takes
precedence without fallback. LayerFS is not a backup or universal security sandbox.
