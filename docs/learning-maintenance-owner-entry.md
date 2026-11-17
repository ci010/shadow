# Document maintenance: protected owner entry

This is the narrow production **code path**, not a deployment announcement,
acceptance result, real human approval, or evidence that real data was archived.
No real Project classification/prepare/apply/restore, service restart or release
was performed while implementing it. The epoch/history foundation and old HTTP
apply remain disabled. See [protocol and limitations](learning-maintenance-foundation.md).

## Entry and host authority

`createProjectRuntime` registers the importable `learning_maintenance` tool. It is
session-only, not a base tool, HTTP mutation API or general service dispatcher.
The handler additionally requires all of:

- A sole, direct, authenticated administrator **user** turn in a private Web
  conversation, in the same Project; not session/event input, nested script,
  reconstructed/recovering tool call, borrowed tool owner, task/call or Bot.
- Current persisted durable owner state (`isOwnerSession`), the exact current
  physical segment, no managed conversation, and an available **local** workdir.
  Remote and LayerFS are explicitly refused; a selected local Workspace does not
  change the Project owning the knowledge. Workspace-restricted memory access
  cannot invoke this capability.
- Fresh checks after every awaited human answer and before domain admission.
  Revocation, source drift, gate/receipt/policy changes require a new plan.

Human confirmation uses `YieldManager.askOwner` and the existing ownerOnly Ask UI,
not agent-facing `reply`, parent answers, a caller's decision ID, historical ask
text, an `approved:true` string or a default. The adapter parses the existing
YieldRequest/YieldAnswer contracts and checks the owner-only user recipient,
logical/physical origin, exact question/options, current request/reference,
explicit first-option user selection and valid answer time before its deadline.
Custom answers, denials, timeout/deferred outcomes, cancellation and missing
broker state grant no authority. The parent decision selecting this implementation
is **not** a production human classification or execution receipt.

## Read-only planning and separate content review

1. `inventory` lists the complete bounded representable classification domain:
   lowercase single-document Wiki pages in topics/concepts/tools and Project Skill
   packages. At most 1,000 paths; incomplete/unsafe inventories fail closed.
   Unsupported/resource-bearing/builtin/host-protected/unreadable paths are
   explicitly protected, not expanded into eligible packages. It does not scan
   credentials, identities, decisions, conventions, sessions or original logs.
   Those and all unlisted sources stay outside coverage and protected.
2. `inspect {paths}` obtains current native source revision, complete snapshot
   hash and raw text digest from formal Project sources. A Skill text digest is
   **not** its native package revision. Historical checklists supply no authority:
   stale digests require fresh inspection and content review.
3. `preview {documents}` supplies the **full eligible inventory** with exact
   hashes, a retain/protected/archive/seed classification, and complete UTF-8
   `replacementText` only for seeds. This creates only an ephemeral host plan.
   Missing/new/changed entries are unreviewed/protected, never a wildcard grant.
   Plans contain complete original snapshots and readable text, full replacement
   bodies, retained/protected selections, Project/action identity, all effects,
   complete inventory, durable receipt/policy/gate versions and recovery semantics.
   Complete plans over 16 MiB are rejected rather than truncated.
4. `read {revision}` returns that exact detached host plan. An authenticated,
   no-store GET at
   `/projects/<project>/api/knowledge/learning-maintenance/owner-plans/<revision>`
   exposes the same complete JSON for human inspection from the Ask prompt.
   Missing/unloaded/expired plans are explicitly unavailable. GET cannot confirm
   or execute anything; cross-Project registries and sources are never selected.
5. `review {revision}` asks the **human** to approve content/classification only.
   After rechecking actor, full inventory and versions, it CAS-publishes the exact
   Project policy and immutable audit under
   `state/learning/document-maintenance-v1/protection.json` and
   `protection-receipts/<sha256>.json`. This policy write is itself disclosed in
   the plan/prompt; it is not archive preparation or source mutation. The receipt
   binds every listed native/text/snapshot version, complete originals, full seed
   text, inventory, decision reference and prior policy revision. Previously
   human-protected/manual paths cannot be downgraded by ordinary content review.
   Hard protections cannot be lifted at all. Retain means retain in this plan;
   protected additionally establishes monotonic known protection. Classification
   is human content selection, **not** proof of authorship or automatic provenance.
   Provenance stays unknown. No valid policy means no execution. Final policy
   publication takes an exact-version formal writer admission on the same gate;
   a delayed approved review cannot publish after maintenance reserved the gate.
   No writer admission is held while waiting for the human.

## Execution and explicit recovery

`execute {revision}` accepts only an exact host-registered revision. An archive
plan must already have its separate live human content/classification result and
matching current durable policy. It then asks the human **again**, for execution
of that complete exact plan. The prompt shows file/disposition counts, links the
complete plan, explains temporary invisibility/fencing and unfinished-batch
blocking, and states history:none and epoch:unchanged. Approval is consumed even
if the result is denied, cancelled or uncertain; that action is not auto-replayed.
After approval the adapter rechecks all versions/authority, then calls the existing
DocumentMaintenanceOperation prepare/resume protocol. Optional exact gate revision
arguments are checked inside the gate's CAS admission, not only before it, including
same-operation restoration preparation retries. Preparation passes the exact gate
revision published by **its own cleanup CAS** to the next resume admission; it does
not reread/adopt a later competitor's state as if the human approved it.

`status` is read-only and available without recovering anything. Plans and tokens
are process-local: after a restart an old revision cannot execute or import a
historical content approval as a new token. `recovery_preview {direction}` produces
a new host plan from the exact complete current receipts, source versions and gate:

- `resume` or `rollback` explicitly continues an unfinished original archive;
  each needs a new human execute confirmation. Pre-commit rollback is not
  post-archive restore. For incomplete preparation only, genuinely not-yet-captured
  snapshots may be displayed from formal sources if **all three original hashes**
  still match; the plan labels source-only versus verified durable preimages.
  Preparation happens only after the new approval. Already-receipted missing or
  corrupt snapshots are never repaired/replaced by this fallback.
- `restore` uses DocumentMaintenanceRestoration's distinct plan, independent token
  and receipt. It retains the original operation and immutable snapshots, binds
  exact current archived/seed versions and gate, and restores original full seeds
  by native CAS. It never deletes a gate or reuses archive approval.
- `resume-restore` needs a fresh receipt-bound confirmation after interruption;
  it cannot become a new archive or overwrite third-party source versions.

Unfinished learning batches still block; no batch acknowledgement, history rewind,
epoch activation, global context reset or automatic startup retry is added.
Callback cleanup semantics are unchanged: only one's own reservation cleanup is
retried with fresh CAS, bounded at 32 attempts; source actions are never replayed,
and original results/errors plus cleanup failures remain observable.

## Verification boundaries

Synthetic adapter tests cover owner/source/mode restrictions, real ownerOnly user
settlement and HTTP owner authorization with JSONL **and** SQLite journals,
independent content/execution/restore prompts, refusal cases, full-list policy
CAS/protection, version drift, unknown results, restart recovery including partial
snapshot capture, archive → restore and existing consumer visibility. They are
not real human authorization. Existing service cleanup/restoration/document/gate
tests remain applicable.

The supported lifecycle remains one original archive plus its separate restoration.
Resource packages, hostile external filesystem writers, power-loss transactions,
retraction of already-delivered session context and optional epoch/history isolation
remain out of scope. An old binary lacking this registration must report unavailable;
do not bypass it by writing real state through exec. Old
`POST /api/knowledge/learning-maintenance/apply` still returns 503; service tests or
one successful preview never establish deployment or user acceptance.
