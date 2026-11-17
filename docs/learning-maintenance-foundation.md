# Learning maintenance foundation (internal, activation disabled)

This is a preparatory implementation of the archive/epoch protocol described in
[self-reflection learning](self-reflection-learning.md). It is **not** a supported
live reset, an archive execution result, or evidence of improved learning quality.
There is no HTTP/VFS/tool registration and no automatic startup invocation.
`LearningMaintenanceFoundation.apply()` always throws, including after preparation.
No code in this slice modifies learning state, input admission, active knowledge,
Skill discovery, source files, pending batches, attempts, effects or outcomes.

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

## Trust boundary and conservative protection

`MaintenanceSources` is a **trusted host adapter**, not a client request shape.
`candidates()` must return the explicitly selected, provenance-attested candidates,
not every file found by a directory scan. The foundation has no production adapter.
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
rewritten; seed writes/promotions are not implemented.

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

The foundation tests use an injected synthetic history adapter, not production
JSONL/SQLite stores. Real store adapters and their parity tests remain required.
No helper here changes the old journal cursors or acknowledges old work.

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

## Next slice: required activation integration

Keep preview manifest/cutoff/snapshot identities stable. Before exposing any real
apply, the host must add all of the following together:

- Project authorization and a host-held preview revision, trustworthy automatic
  provenance adapters, complete JSONL/SQLite history adapters and parity tests;
- durable runtime admission fencing, in-flight rejection and competing Wiki/Skill
  writer coordination; this foundation's `preparing` receipt is **not that fence**;
- epoch-aware ledger selection, manual retry, recovery and queueCorrection rejection
  for old work, without fabricating done receipts;
- physical log line/stable-ID prefix integrity and old log isolation (not implemented
  here), path-retirement and seed-revision baselines;
- consistent filtering of ledger inputs/logs, keyword/eager memory, Skill initial
  load/watcher/edit activation, knowledge catalog and VFS discovery/search;
- immutable seed preimages plus supported CAS seed writes, or a separately supported
  seed-maintenance protocol; this slice accepts no replacement seed content;
- verified view refresh, recoverable `committing` → `committed` activation, exact
  source evidence reads and explicit archive-only navigation.

The current API must not be enabled merely because foundation unit tests pass.
No real Project cleanup, rollout, model quality or user benefit is established.
