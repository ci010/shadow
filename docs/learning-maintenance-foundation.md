# Learning maintenance foundation (epoch/HTTP apply disabled)

The narrow document-only production owner adapter is now source-wired; see
[protected owner entry and confirmation sequence](learning-maintenance-owner-entry.md).
That separate path does not activate this epoch foundation or the old HTTP apply,
and was exercised only with disposable synthetic data, not real approval/execution.

This is a preparatory implementation of the archive/epoch protocol described in
[self-reflection learning](self-reflection-learning.md). It is **not** a supported
live reset, an archive execution result, or evidence of improved learning quality.
The runtime now registers authorized **read-only planning** routes described below;
there is no prepare/apply activation route, VFS/tool mutation registration, or
automatic startup preparation/recovery.
`LearningMaintenanceFoundation.apply()` always throws, including after preparation.
The foundation and HTTP previews do not mutate sources or consumption. A separate
internal **document-only host protocol** below now implements fencing, snapshots,
seed CAS/rollback and retired-path visibility. It requires independently confirmed
host-held execution authority. The old HTTP apply remains disabled; the separate
session-only owner tool now supplies independently validated live human authority. No real
Project maintenance, execution confirmation or seed write was performed.

## Implemented interface

- `maintenance-contracts.ts`: strict versioned manifest, candidate and physical
  history cutoff contracts; canonical SHA-256 receipts; history prefix validation.
- `LearningMaintenanceFoundation.preview({ operationId, createdAt, fromEpoch })`:
  read-only plan from trusted injected sources. Returns `{ manifest, revision }`.
  The host supplies a UUID, explicit valid timestamp and current epoch; this
  foundation does not discover or advance the runtime epoch.
- `status()`: reads the durable receipt and reports `activation: 'unsupported'`.
  It is not a fresh source/snapshot integrity scan.
- `prepare(manifest, revision)`: reserves an operation using journal CAS, checks
  the exact selected candidates and full cutoff inventory again, captures complete
  immutable snapshots, and publishes `prepared`. This mutates **only foundation
  bookkeeping/snapshots**, never active content. Do not expose it directly to
  requests as an authorized live maintenance operation.
- `archive(path)`: explicit historical snapshot read, with checksum validation,
  `archived: true` and `instructionAuthority: false`. These labels mean historical
  evidence, not that the source has already exited active consumption. No default
  catalog or search entry is added.

All service results are detached values. Manifest revision includes Project,
operation, epochs, provenance, creation timestamp and every physical cutoff.
Timestamps validate metadata only; they do not decide which messages are old.

## Reviewed-content planning (partial, no execution authority)

Authorized `POST /api/knowledge/learning-maintenance/documents` accepts only
`{paths: [canonicalPath]}` and returns observations, not eligible retirement
candidates. Each observation independently binds native `sourceRevision`, complete
`snapshotRevision` and raw page/SKILL.md `sourceTextDigest`. Text-only Skill hashes
must not be used as SkillEditStore native package revisions.

The preview route also accepts a separate strict shape:
`{documents: [{path, sourceRevision, snapshotRevision, sourceTextDigest,
disposition: 'archive' | 'seed'}], historyEffect: 'none'}`. Sources are checked
twice. This produces a nonempty **document-only read-only plan**, retaining unknown
provenance, `contentReview: null`, `executionApproval: required-separately` and
`activation: disabled`. Its effects explicitly leave history, epoch, original logs
and unselected documents unchanged. `seed` is selection only, not a validated
replacement. It creates no journal, persistent operation or snapshot.

The host-only `ReviewedMaintenancePreview.preview(request, hostReview)` can bind
an independently established human content-review receipt containing Project,
`scopeHash` and `reviewTextDigest`. HTTP cannot submit this receipt or any approval.
This low-level preview adapter is not a human-decision validator. The separate
owner tool now validates live human broker outcomes and persists exact Project
classification/protection receipts; preview routes cannot submit those receipts.
A content receipt is not an execution token. Eventual execution must
independently bind a host-held complete plan, operation ID and revision. No real
Project review receipt was installed by this implementation.

Observations reject decisions and host-configured protected/known-manual paths;
identity/convention/log/session/builtin paths are outside the allowlist. Other
observations remain unknown, including mixed manual/automatic content. The HTTP observation path
supplies no review-list-specific approval: observation never proves that any human
checklist permits retirement. The separate owner entry now persists a live-human
Project classification/protection policy; no historical checklist is auto-imported. Resource-bearing Skill packages remain
unsupported. A double source read is not a writer fence or atomic filesystem
snapshot. Later changes require refreshed observations/review. The preview itself
changes no consumers or batches. The independently confirmed internal document
protocol below is distinct. No epoch/history side effect is implicitly authorized
by document selection.

## Trust boundary and conservative protection

`MaintenanceSources` is a **trusted host adapter**, not a client request shape.
`candidates()` must return the explicitly selected, provenance-attested candidates,
not every file found by a directory scan. `ProjectMaintenanceSources` provides a
conservative production assessment adapter for the planning integration below.
Existing artifact receipts do not prove exclusive ownership; the adapter preserves
them and currently emits no retirement candidates.
A client saying `kind: automatic-learning` is not proof and must never be accepted
as one. Candidate attestation covers the exact complete snapshot revision and must
establish that no protected/manual content is included. When evidence cannot do
that, omit/preserve the item; never guess from its filename or frontmatter.

Only lowercase slug Wiki pages under `topics`, `concepts`, `tools`, `decisions`,
and Project `skills/<slug>/SKILL.md` packages are representable. Identity pages,
conventions, event logs, session records, SOUL, configuration, builtin skills,
manual and unknown provenance are rejected. Each manifest candidate binds two
separate revisions:

- `sourceRevision`: the current source revision in the existing automatic artifact
  receipt's hash domain (for example a Wiki body hash). It must equal the unchanged
  `provenance.artifactRevision`. Never mint/rewrite a learning receipt to make it
  equal a new snapshot hash. The trusted adapter verifies the source against that
  real receipt, using the source's native revision algorithm.
- `snapshotRevision`: SHA-256 of the canonical complete snapshot envelope, checked
  by `snapshotFor` independently of source provenance. Persistent snapshot receipts
  and filenames use this hash, not the source revision.

The manifest checksum binds both values. They normally differ; neither substitutes
for the other. The adapter must bind the full package to the attested source and
exclude unproven manual resources; a single SKILL.md receipt alone is insufficient.
Duplicate paths and foreign Projects are rejected. No source file is removed or
rewritten by this automatic-ownership foundation. Reviewed-content seed writes
use the separate document protocol, not forged automatic provenance.

Wiki envelopes contain exactly `page.md`; Skill envelopes contain the complete
package (`SKILL.md`, resources including binary bytes, and empty dirs).
Files use canonical base64; package members are bounded, relative, non-hidden,
non-colliding paths. Unsupported packages remain protected. The source adapter
must reject symlinks, incomplete scans and unproven manual resources. Existing
ledger receipts for only SKILL.md do not by themselves attest an entire package.

## Physical history adapter

`MaintenanceHistory.inventory()` must enumerate **all persisted sessions** and all
physical segments, including unloaded sessions and empty physical segments. It
attests `complete: true`, a Project ID and inventory revision. Production integration
must use persisted history enumeration (for example `listHistorySessions`), not
only the loaded `listSessions` or current segment. Segments must be contiguous
from index zero, and physical IDs must be unique. Missing/read failures throw;
no exception is converted into an empty history. Invalid metadata times also fail.

`messages(sessionId, physicalId)` returns all persisted messages in storage order,
without overview rendering, time sorting or pagination truncation. The adapter
must provide JSON values consistently for both session stores. Inventory is checked
again after enumeration. Preparation recaptures and compares the complete inventory
and message boundaries, so an append **before prepare** requires a fresh preview.
After capture, `verifyCutoffs` validates each exact message prefix; append-only new
messages remain outside the boundary, even if they carry old timestamps. Rewriting
or truncating a prefix fails. There is no MAX_SAFE_INTEGER sentinel cursor.

The foundation tests use an injected synthetic history adapter. Separate
`maintenance-history_test.ts` tests exercise `SessionStoreMaintenanceHistory`
against real JSONL and SQLite stores in disposable synthetic Projects, including
ordinary conversation archives and finalized fresh automation archives. No helper
here changes old journal cursors or acknowledges old work. These are raw persisted
record cutoffs, not presentation/model-history offsets; a future epoch integration
must explicitly bridge the source coordinate domains rather than reuse them blindly.

## Storage, phases and failure

Storage is Project-local and independent of all memory/Skill active scan roots:

- `state/learning/maintenance-foundation-v1/state.json`
- `state/learning/maintenance-foundation-v1/snapshots/<sha256>.json`

A single current operation is supported; replacement, cancellation, garbage
collection and implicit unblocking are deliberately absent. Operation ID plus
manifest revision identify resumptions. The existing journal supplies exclusive
save locking and optimistic CAS; a monotonic generation also distinguishes repeated
saves. Another operation cannot replace the receipt. Stale writers fail closed and
must reconstruct the service; they do not write a competing `blocked` state over
the winner. This is not a multi-file transaction or a global learning/write lock.

Produced transitions:

1. absent → `preparing`: reserve before calling any asynchronous snapshot adapter;
2. `preparing` → `preparing`: publish each verified content-addressed snapshot;
3. `preparing` → `prepared`: all snapshot receipts present;
4. preparation or verification failure → `blocked`, retaining evidence and receipts.

`committing` / `committed` are reserved schema phases only. This implementation
cannot enter them or resume them as activation. A restart can explicitly resume
`preparing` for the same exact operation, after source revalidation. A completed
`prepared` retry only verifies stored snapshots and returns the same receipt.
A corrupt prepared snapshot blocks an explicit prepare retry. A `blocked` operation
requires operator review; there is no force overwrite or automatic restart retry.
Merely constructing the service or reading status never runs preparation/recovery.

Snapshots are created exclusively, fsynced and never overwritten by the service.
Existing bytes must match exactly. Partial/corrupt snapshot files fail rather than
being repaired or deleted. Source changes are not overwritten. These are service-
immutable content-addressed files, not OS-enforced immutable storage: the owner can
alter files outside the service, which subsequent verified reads detect. Journal
atomic publication is reused; power-loss durability across files/directories and
hostile external filesystem races are not claimed. A crash may leave an orphan
snapshot, an ambiguous journal lock, or `preparing`; none activates an epoch.

## Activation boundary

The epoch foundation above remains unsupported for activation. The document-only
protocol below is separate and does not advance that epoch or impose old-history
cutoffs. The separate owner tool now supplies a durable local owner/Project
human-decision adapter and document-only execution entrypoint, never an HTTP
approved flag. The internal host functions still assume the caller independently
established that authority; they are not themselves a human-decision validator.

Resource-bearing Skills remain unsupported by reviewed-content production sources.
The existing history adapter's unprovable SQLite zero-row live segment remains a
conservative rejection; document-only planning does not pretend to capture it.
Any optional epoch/log/session-history consumption boundary must be separately
shown and approved. Document selection does not authorize wholesale history
retirement, log deletion, cursor acknowledgement or dropping old pending batches.

## Production planning integration (partial; apply disabled)

`ProjectMaintenanceSources`, `SessionStoreMaintenanceHistory`, and
`LearningMaintenancePreview` are composed in the Project runtime. Construction
performs no scan, prepare, recovery, source write, or epoch switch. The following
routes reuse the existing Project knowledge authorization middleware; unauthorized
requests return 401 before service access. No credential/session fabrication is
needed or supported. All results are `no-store`.

- `GET /api/knowledge/learning-maintenance/status`: reports `integration: partial`,
  `activation: disabled`, explicit missing activation components and any pre-existing
  foundation receipt and current `documentGate` evidence. Status does not resume a
  receipt, release a writer/runner, verify all sources, or create state.
- `GET /api/knowledge/learning-maintenance/candidates`: current eligible
  `{path, sourceRevision, snapshotRevision}` selections plus `protectedSources`.
  Production currently returns **no eligible candidates**: a matching persisted
  LearningLedger artifact proves a last automatic write, not exclusive ownership.
  Matching sources are listed as protected with a machine-readable reason.
- `POST /api/knowledge/learning-maintenance/preview`: strict body
  `{candidates: [selection], seeds: [selection]}`. Both arrays are explicit; duplicates,
  overlap, unknown paths, stale revisions, epochs and caller provenance are rejected.
  This is the legacy automatic-provenance foundation request, distinct from the
  reviewed-content request described above. At that level the candidate set is
  the retirement set; seeds are retained
  **unchanged** baselines. Nonempty production selections currently reject because
  the exclusive-ownership attestation producer is not yet implemented.
  The response binds the full foundation manifest plus seed receipts into
  `manifestRevision`; `foundationRevision` identifies only the foundation manifest.
  The preview is read-only and not a durable reservation. Repeating preview creates
  a fresh operation. Selections are bounded to 1000 per array and 512 KiB per request.
- `POST /api/knowledge/learning-maintenance/apply`: accepts only the strict shape
  `{operationId, manifestRevision}` and **always returns 503 disabled**, without
  preparing, persisting a preview, modifying source files or changing learning state.
  Extra fields, including claimed provenance, return 400. Other bodies retain the
  existing 4 KiB limit. No route exposes foundation `prepare()`.

### Conservative source attestation

The adapter rereads the persisted Project ledger; foreign or invalid ledgers fail
rather than becoming an empty successful scan. Filename, frontmatter and HTTP
claims are not provenance. Missing/changed, unsupported or unsafe sources remain
protected. `protectedSources` reports matching native receipts (Wiki exact-byte
hashes and SkillEditStore's native package hash) with independent snapshot revisions;
it does not sign `manual:false`. Even a single-member Skill can have manual content.
Formal automatic Wiki/Skill updates may preserve existing manual text, so **all
legacy artifact-only ownership is unknown and preserved**. A real creation/preimage
lineage or independently audited supported ownership protocol is still required.
No API payload can submit that proof or override this conservative classification.
Multi-member Skill packages, builtin sources, identities, conventions, SOUL and logs
are outside this assessment set and remain protected too. No source is persistently
archived by the automatic-candidate adapter while ownership is unknown. Protocol tests use explicitly
trusted synthetic sources separately from the conservative production assessment.

The history adapter enumerates persisted ordinary, fresh automation and retired
conversation states, including unloaded sessions and all old physical segments.
It reads strict raw JSONL/SQLite records rather than overview/model history.
Malformed records, missing segments, foreign access, ambiguous ownership, incomplete
JSONL tails and enumeration failures reject. Inventory revisions include content
hashes, so an append without a metadata update still invalidates a concurrent
capture. Appends after an accepted cutoff remain new; altered prefixes fail.
SQLite has no independent live physical-segment existence table: a zero-row live
segment is indistinguishable from deletion and currently **blocks preview**.
JSONL empty files and archived zero-record segments are supported. This conservative
limitation must be resolved before claiming universal store parity. Complete scans
are intentionally expensive; no large-Project performance claim is made.

## Document safety chain (domain service; owner adapter required)

`DocumentMaintenanceOperation` is an explicit host-only implementation. Merely
constructing it, `status()`, plan construction, HTTP preview and snapshot reads
never prepare, resume or activate anything. Runtime now instantiates it only
behind the separately guarded owner tool, not an HTTP mutation route.
`LearningMaintenanceFoundation.apply()` and old HTTP apply remain disabled.

### Authority and full plan

- `plan(request, replacements, contentReview)` rechecks the reviewed unknown-
  provenance document selection and validates complete replacement envelopes.
  Wiki originals/replacements must round-trip lossless UTF-8. Skill documents
  pass the same native package/frontmatter validation and revision algorithm as
  `SkillEditStore.save`. Only existing single-member Project packages are supported;
  builtin Skills/overrides, admin Skills, linked paths and extra members are rejected.
- The full plan binds Project, operation ID, content review scope/text digest,
  native source/text/snapshot revisions, exact seed bytes and declared effects.
  Content review is still not execution approval. `confirmDocumentExecution`
  assumes a trusted host has independently obtained the exact execution decision;
  it retains a detached host-held full plan and mints an in-process, non-JSON
  token bound to that complete plan revision. A forged
  object, another operation, changed seed, foreign Project or reused token for a
  modified plan cannot prepare. The durable receipt retains the decision reference.
- Effects explicitly require zero unfinished learning batches (no acknowledgement
  or exclusion), temporarily make selected paths unavailable while fenced, retain
  archive source bytes in place, CAS the selected seeds, and exclude **explicit
  retired-document references only** from automatic learning inputs. Logs, sessions,
  summaries, `.files`, unselected documents and history/epoch stay unchanged.
  Existing eager historical log rendering remains available; this is not semantic
  isolation of every old mention or a license to retire all history.

### Admission, writers and storage

State is under `state/learning/document-maintenance-v1/`, outside active discovery:

- `gate.json`: CAS generation, admitted writers and their path/package reservations,
  operation identity/scope, exclusive runner/direction, abandoned runner evidence,
  retired paths, original-operation lineage and an independent `settled`
  write-admission bit;
- `operation.json`: exact full plan, independent execution decision reference,
  phase, immutable preimage receipts and verified seed effects;
- `snapshots/<sha256>.json`: exclusively created/fsynced, complete exact-byte
  preimage envelopes, never overwritten or silently repaired.

Supported official writers share durable admission: Wiki VFS/generic local writes,
Wiki reference repair, `WikiDocumentStore` CAS, Knowledge deletion, SkillEditStore
and legacy learned-Skill saving. Paths in the same Skill package share one lock;
ordinary competing writers cannot both pass the same Wiki revision and publish.
Nested supported calls retain path reservations until their owning async writer
finishes; detached continuations cannot reuse expired admissions. Reservation
cleanup is separate from the source callback: only fresh-CAS removal of the same
writer/runner ID is retried, at most 32 attempts, on typed Journal CAS conflict or
that Journal's busy lock. The callback is never replayed and other owners' state
is never replaced. Ordinary different-path competition therefore does not turn a
completed action into a fake crashed writer. Persistent storage failure or retry
exhaustion throws `MaintenanceCleanupError`, preserving whether the callback
returned, its result, the original action error and cleanup error. Both failures
remain in the AggregateError; immutable `cleanup-failures/<id>.json` evidence and
unresolved reservations remain. An owner-held `retryCleanup` capability can retry
only that metadata after storage repair, never the source action. If evidence
publication also fails, that additional failure is reported rather than claiming
a durable receipt. LearningLedger advances its committed in-memory snapshot
inside the successful ledger publication callback, before gate cleanup; a cleanup
error cannot roll disk counters back on a later unrelated save. Symbolic links,
ancestor links and hard-link aliases are rejected on Project knowledge paths;
case-insensitive aliases are checked against actual file identity. Distinct-case
files on sensitive volumes are not silently retired by string folding.

Whole learning runs (automatic/manual) and recovery hold admission. Ledger saves,
bind and queueCorrection cannot mutate through an active fence; rejected
unpublished mutations restore the last committed in-memory ledger snapshot.
A callback cleanup failure pauses scheduling with explicit diagnostics instead
of replaying the source action or spending another automation retry. Startup learning recovery leaves
fenced attempts/effects/outcomes untouched. Scheduled/manual learning checks the
fence without spending retry attempts. Preparation also rejects any persisted
unfinished batch, so it never invents done receipts to eliminate old work.

A crashed ordinary writer reservation is intentionally **blocked**, not expired or
cleared on startup. No automatic orphan-writer recovery is implemented. An explicit
operation resume may abandon a recorded same-host runner only when a PID probe
proves ESRCH; old generation/direction evidence is retained. Live/reused PIDs,
foreign hosts and ambiguous owners are not stolen. Concurrent resume/rollback
cannot both mutate: they require one durable exclusive runner. Terminal visibility
cannot be republished in another direction or merge incompatible retired sets.
Journal CAS conflicts retain the winner; no force overwrite or lock deletion is
used to make the operation appear successful.

### Mutation and recovery

1. Independently confirmed `prepare` reserves the exact operation/path scope, then
   captures and journals **all** selected originals before any source replacement.
   Snapshot or prepare failure retains gate and evidence. Exact explicit retry can
   resume interrupted preparation after source revalidation; corrupt existing
   snapshots block rather than being rewritten.
2. Explicit `resume` rechecks every preimage and requires unchanged archive sources.
   Seeds may be at only the exact original or exact planned postimage. Original →
   postimage uses the supported native Wiki/Skill CAS writer; a postimage found
   after a crash is reconciled instead of replayed. A third-party revision blocks
   both resume and rollback, preserving that version.
3. Before terminal publication all final source snapshots are revalidated and
   affected local Skill caches invalidated. One gate CAS publishes retired paths
   and switches selected-path visibility. Write/learning admission stays fenced
   until the terminal receipt and view refresh complete (`settled: true`). A crash
   after visibility or receipt publication therefore still retains the write fence.
   Active source bytes for archives are
   retained, not deleted. A crash between this gate publication and the operation
   receipt is explicitly reconciled in the **same direction** on resume.
4. Before terminal visibility, explicit `rollback` restores exact full original
   seed preimages using native postimage CAS, preserving immutable evidence.
   Terminal rollback releases the fence without retiring paths. The original
   archive operation still refuses an in-place direction reversal after commit.
   Post-archive reversal instead uses the independently planned/confirmed
   restoration protocol below. Garbage collection and unrelated new archive
   cycles are not implemented.

Fencing makes selected documents unavailable, not a secretly activated half-plan.
Keyword memory, Knowledge catalog/detail, VFS directory/list/glob/grep/exact reads,
Skill initial load/watcher/disclosure/resource resolution and learning discovery
consult the same persisted visibility. Async readers fail closed if the view
changes. A peer Skill manager rebuilds affected paths from durable operation scope,
including seeds its watcher dropped while fenced; stale watcher generations cannot
resurrect an old body. Retired packages cannot be recreated through formal edits.
Raw historical logs remain navigable at their stable existing locators.

Explicit `GET /api/knowledge/learning-maintenance/snapshots/:revision` reuses Project
knowledge authorization/no-store and verifies checksums. It returns historical
bytes with `instructionAuthority: false`, never default catalog/search entries.
Knowing a revision cannot select another Project's snapshot directory.

### Separately confirmed post-commit restoration

`DocumentMaintenanceRestoration` restores a completed archive without disguising
it as the original operation's pre-commit `rollback`. It is host-only, reached
through the separately confirmed owner tool; there is no HTTP mutation route
or implicit startup restore.

- `plan()` binds the original committed receipt/operation/revision, its complete
  document scope, the current **complete gate revision**, and every current native,
  text and complete-snapshot revision. It declares only the original archive paths
  becoming active and exact-CAS restoration of the original full seed preimages.
  History, epoch, unselected documents and all original receipts remain unchanged.
  Archive bytes must still equal the original snapshot; seed bytes must still
  equal the original planned postimage. Pre-plan third-party changes reject the
  plan, not become newly approved overwrite targets.
- `confirmDocumentRestoration` retains its own detached complete host-held plan and
  independently obtained execution-decision reference. An archive/content token
  cannot authorize this operation. Changes to current revisions, full gate state,
  original receipt, Project, scope or plan require a new explicit confirmation.
- `prepare` reserves a distinct restore operation, retains the original descriptor
  in `gate.operationHistory`, and leaves the original `operation.json` bytes and
  original snapshot files untouched. It captures all current preimages too.
  `restoration.json` and immutable `restoration-receipts/<sha256>.json` versions
  retain prepare/progress/failure/terminal evidence, including orphan receipts if
  a journal publication fails. No gate/lock/history file is deleted to revive paths.
- Explicit `resume` uses the same durable exclusive runner as archive commit.
  A seed can be only at the exact archived postimage or the exact intended original
  preimage; all other versions block without overwrite. Archive bytes are checked,
  never rewritten to conceal a modification. Each source and all immutable
  preimages are verified before visibility publication. Crashed seed effects are
  reconciled by native/snapshot revision, not replayed blindly.
- One gate CAS removes **only the original archive's exact retired set**. It cannot
  clear an unlisted tombstone or republish the old archive in another direction.
  Terminal restore receipts and Skill refresh complete before write/learning
  admission is settled. A fault after visibility or receipt publication still
  retains the fence; explicit same-plan restart reconciles that publication.
- Watcher-dropped paths are reconstructed from the restored operation scope, so
  Keyword memory, Knowledge/VFS discovery/exact reads, Skill initial/watcher/cache
  views and learning-document reference admission agree again. Raw log locators,
  historical snapshots and learning attempts/effects/outcomes are retained; no
  session/log cursor is rewound to replay history. A fully settled duplicate restore
  returns its historical receipt without touching later legitimate source edits.

The supported lifecycle is one original archive plus its separate restoration;
new unrelated archive cycles and restoration of arbitrary third-party versions
are not implemented. Legacy v1 descriptors without a duplicated published-path
field are bound from the confirmed original receipt and exact current retired
set, without changing the original receipt bytes.

### Verified limits and remaining integration

Synthetic tests cover bounded cleanup retries at deterministic real cross-process
release barriers, success/error result preservation, durable cleanup faults and
ledger counter consistency; post-commit restoration, eight restoration fault
stages, actual process exit/restart, third-party conflicts, duplicate/concurrent
restoration, original receipt retention and restored consumer visibility; plus
nonempty real-source observations, separate digest domains,
foreign/stale/forged scope rejection, both session stores' unchanged history,
full original Wiki/Skill bytes, native seed conflicts, eight injected failure stages,
explicit restart/resume/rollback, concurrent opposite-direction execution,
cross-process writer CAS exclusion, dead-runner evidence, orphan-writer blocking,
case/symbolic/hard-link aliases, watcher-during-fence peer recovery, retained log
locators, all listed consumer surfaces and unchanged attempts/effects/outcomes.
Source-readiness and existing learning/Knowledge/Skill tests are included.

These are service-cooperating local-filesystem guarantees, **not an OS sandbox**:
arbitrary external executors can mutate owner files, replace paths after a check,
corrupt receipts or bypass services. Journal publication is atomic but not a proven
multi-file power-loss transaction; directory fsync and hostile filesystem race
hardening are not claimed. A process killed during a Journal lock publication can
still leave ambiguous lock evidence requiring operator diagnosis, not automatic
cleanup. Resource-bearing Skill scripts/in-flight SDK processes are not covered by
the supported single-document domain. Existing session instructions/history are
append-only and are not rewritten to erase old knowledge.

The separate document-only durable-owner/human-decision adapter is now implemented
and source-wired as described in [owner entry](learning-maintenance-owner-entry.md).
Its exact Project classification receipt, content review and independent execution
confirmation do not grant any epoch/history policy. Those remain unapproved and
unimplemented. Historical log prose and old references to retained
seeds can still provide future learning evidence; no blanket semantic non-reuse
claim is made. Do not remove apply503 just because these document-chain tests pass.
No real archive/seed write, service restart, Windows sync, rollout, model-quality
benefit or user acceptance is established by this code delivery.
