# LayerFS on a Windows Child controlled from Main

A Mac Main can select a registered Windows Workspace and use the typed LayerFS
node service. This does not start a second Shadow Project/session/provider runtime
on Windows. The Child owns a narrow, pairing- and Project-scoped service holding
installation records, runtime ownership, catalogs, workspace creation receipts and
operation journals. Runtime binaries, WSL sources, Docker resources, private
launchers and SDK operations stay on Windows. Main holds the registered Workspace
reference and its explicit target/pairing/Project binding. Display paths are never
resolved on Main, and unavailable or changed targets have no local fallback.

## Authority and installation

Only the authenticated paired Main can submit service requests. Main verifies its
actual Project/session/actor context. Lifecycle operations require a direct durable
owner Web session, not a task, nested script, borrowed tool owner or recovery replay.
Ordinary registered-branch operations retain their separate Project/session access
boundary and carry a `workspace-session` assertion, not generic management authority.
Lifecycle calls carry a separately verified `direct-owner` assertion. Origin actor
provenance is retained; a verified Project owner may reconcile worker receipts without
impersonating that worker actor. A target support advertisement is implementation availability, not consent.

For missing installation artifacts use `layerfs_bootstrap_plan` on the selected
Windows target. Its exact human question names the target device, target Project
scope, immutable target plan, pinned revision and WSL distribution. Submit that exact
question/options/default to `ask`. `layerfs_bootstrap` requires the actual recorded
human answer reference. Main verifies the record (including invalidation/custom/
parent-answer checks); the Child additionally matches its own canonical target plan.
Main retains the canonical question from the authenticated target plan response and
compares the entire recorded question/options/default before transport, not just a
question prefix or a model-supplied assertion. A Main restart/expired/superseded plan
requires a fresh plan/decision before installation, never a provisioning replay.
Booleans alone, a decision for another device/Project/plan, or a stale pairing cannot
approve installation.

For an existing trusted installation, remote `layerfs_setup_plan {installation}`
returns an equivalent target-bound question. After its recorded human decision use
`layerfs_setup {plan,approval,approved:true,allowRootWorker:true}`. The target uses
its retained installation parameters, not replacement parameters supplied at commit.
Local setup keeps its existing installation contract.

## Runtime, source preparation and Workspace use

After installation, `layerfs_runtime_plan/start/status/context` and
`layerfs_resource_register/list/inspect` use the selected target service. Routine
approved-artifact reuse does not ask for a second installation decision. Runtime
start still refuses concurrent, uncertain and crash-retained ownership. Status and
observation never implicitly start a runtime.

`runtime_context` returns Windows-local executable/launcher parameters, target
provenance and `leaseExpiresAt`. Run that launcher only through ordinary **native
Windows exec**, not Mac exec or a LayerFS sandbox. Its target-owned capability is
bounded to five minutes, the exact pairing/connection epoch, Project, runtime,
installation and optional native source identity. Disconnect, reconnect, re-pair,
expiry or source/installation substitution requires a new context. Closing the Main
Project also revokes its issued/possibly-issued target contexts through a dedicated
host-only, revocation-only typed assertion; this cannot install, start a runtime or
borrow direct-owner authority. Revocation uncertainty remains a cleanup error. These checks
cover list/get_init and SDK configuration/open as well as Init. A source-less
context allows inspection but cannot admit Init. Invocation-context authority is
revoked after each tool dispatch; the launcher lease is a separate host capability.
No capability token or launcher contents should be logged or copied to a sandbox.

Fixed Git/LFS checkout, Docker image preparation and official Init remain ordinary
authorized commands on Windows using the existing controlled launcher. There is no
remote shell installer, arbitrary service-script runner or hidden preparation recipe.
See [the setup guide](../src/skills/builtin/layerfs/setup.md) for native WSL source
requirements and immutable registration fields.

`workspace_create {backend:"layerfs",source:RESOURCE_ID,...}` on the selected Windows
target creates and registers a target branch. `workspace_fork` inherits a registered
source's exact target/resource/branch; changing devices or adopting a new pairing is
not implicit. Select the returned Workspace ID with ordinary read/write/search/exec
or `workspace_use`. It remains a LayerFS Workspace with a separate execution location,
not a native Windows directory. Writes and exec use target SDK checkpoint/exclusion
semantics, including checkpoint on nonzero command exit. Admitted exec runs until its
terminal SDK receipt rather than a hidden five-minute transport cutoff; ordinary exec
wait/background ownership and cancellation remain with Main. Bounded live progress is
forwarded separately from the final structured receipt. Independent branches remain
isolated. VFS `v:layerfs/<Workspace UUID>/branches|history|diff/...` routes fixed
read-only queries to that same registered target; it never starts a worker.

## Target jobs and uncertain outcomes

Remote bootstrap returns `targetNodeId` and `targetJobId` (`layerfs-target:...`). These
are **not Main `v:bg` executions** and do not produce Main background completion events.
Use `layerfs_bootstrap_status` on that same selected target to inspect the durable
bootstrap journal, or `layerfs_bootstrap_cancel {targetJobId}` to request cancellation.
Cancellation is not rollback: artifacts/worker activity can remain, and the returned
status must be inspected. After a target process restart the durable journal remains,
but an absent live cancellation handle is not permission to kill or repeat provisioning.

Before bootstrap transport dispatch, Main persists a target/pairing/Project/request
reservation using its existing pending-remote-job Project deletion guard. Admission
adds the exact target job ID without an unprotected crash window. Main restart or
network loss does not release it. Read `v:project/remote-layerfs-jobs` from an available
session in the same Project for durable target/job/request IDs and recovery guidance,
even while the Windows device is offline. This projection does not contact the target.

Use `layerfs_bootstrap_reconcile {targetJobId}` for explicit terminal reconciliation.
The target reads its own exact current/archived bootstrap journal, checks Project and
approval provenance and live activity, and returns bounded evidence. Main independently
checks the target/pairing/Project, original approval and job, and terminal facts before
releasing its reservation. Ready completion and verified stopped pre-provisioning/
blocked attempts can settle; a cancellation request, disconnect, uncertain state,
changed pairing, missing/corrupt journal or incomplete cleanup cannot. The returned
target journal/step/code identifies where authoritative inspection is required. No
operator override, forced cleanup, automatic adoption or retry is provided for an
unprovable outcome. A lost initial response can be recovered through its request
receipt or the canonical target bootstrap journal without reissuing provisioning.

Typed service mutations have target-retained request receipts before dispatch. A
lost response, cancellation or disconnect is not proof of no effect. Error messages
include a request ID; `layerfs_reconcile {requestId}` inspects that Project-owned, actor-provenanced
receipt without replay. Completed exact receipts can be returned; dispatched/unknown
mutations are never dispatched again under the same ID. Existing underlying bootstrap,
runtime, Init, branch and SDK journals continue protecting their own mutation scopes.

## Verification boundary

Automated fixtures exercise Main gateway, Project executor, Child typed handler,
real resource/workspace services, ordinary tool routing, VFS, owner/consent checks,
launcher IPC and lease rejection with synthetic official SDK/runtime drivers. They
are not evidence of a real Windows WSL/Docker installation, production deployment,
source import, or live multi-device acceptance. Those require a separately authorized
installation/start and explicit target-side acceptance run.
