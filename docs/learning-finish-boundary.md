# Bounded learning finish and retry recovery

Project learning uses the existing SessionManager loop, tool validation and journal;
this is not a second model loop. Trusted pipeline inference ceilings remain 6 for
reflection, 8 for encapsulation and 4 for Soul reflection. No unrestricted extra
iterations are added.

## Host finish boundary

For task-mode cron runs with learning automation provenance, a dedicated learning
agent and trusted execution limits, BaseSession reserves the last existing inference
for `learning_result`. It persists a finish instruction in the message history,
exposes only that tool, and denies other tools at execution too. This is separate
from ordinary cron, Discord learning and interactive sessions.

SessionTools also reserves one tool call and up to 8,000 argument bytes (at most a
quarter of the argument ceiling). Work calls cannot spend that capacity. Rejected
work calls do not consume the reserve. Receipt calls still respect the overall
ceilings; malformed or repeatedly rejected receipts can exhaust it.

A successful `learning_result` tool return ends this bounded session without another
model request. Tool errors and ordinary model replies are not receipts. Tool-result
persistence and the normal session-completion lifecycle still run. LearningRuntime
still verifies effects and commits the proposal only after successful execution;
recovery uses the same proposal/completed-session rules. A partial/blocked receipt
can complete the session execution while the learning automation remains unfinished
and reports that outcome, retaining effects and source reservations. It does not
advance source cursors or publish those logs downstream. No automatic no_change
receipt is synthesized. The model must report unread/unresolved scope honestly.

This does not add a proof that every assigned source line was read: existing read
failure/truncation recovery and effect checks remain, but successful read tools alone
do not establish exhaustive source coverage or semantic understanding. Completion,
read coverage and downstream learning usefulness are distinct. A model that omits
the receipt, misreports coverage or ignores the boundary is not repaired by inventing
success. Provider failures or invalid final receipts can still fail the run.

## Finite automatic retries

LearningLedger stops automatically selecting an unchanged batch after three recorded
deferrals. Existing older batches already above that threshold are also skipped.
Fresh eligible ranges/logs can still run; the capped batch stays unfinished and
reserved, so its hole is not acknowledged or silently skipped by the reviewed cursor.
Attempts, effects, outcomes and errors remain intact. Newly capped batches persist a
`retry.paused` explanation; older records need no journal migration. No evidence is
split, discarded or automatically marked reviewed.

Manual `/learn` bypasses the cap and cooldown using the existing selection policy;
it does not reset failure history, and a failed manual retry remains capped for
automatic selection. When multiple pending batches exist, manual selection is not a
new batch-specific retry UI. The cap is a ledger selection rule, not a new exposed
UI status. Controller scheduling and configured intervals are unchanged.

## Sources and verification

- `src/sessions/base-session.ts`: provenance-gated final inference and terminal receipt.
- `src/tools/registry.ts`: reserved tool/argument capacity and execution denial.
- `src/agent/learning/tools.ts`: validated, audited receipt proposal.
- `src/agent/learning/pipelines.ts`: trusted ceilings, completion verification/recovery.
- `src/agent/learning/ledger.ts`: durable batch deferral, selection and reviewed cursors.
- `src/sessions/execution-modes_test.ts`: JSONL/SQLite real receipt lifecycle, final
  inference success, honest partial/blocked outcomes and invalid-receipt failure.
- `src/tools/learning-finish_test.ts`: reserve enforcement and hidden-work denial.
- `src/agent/learning/batch-isolation_test.ts`: persisted cap, fresh work and manual recovery.

Deployment requires rebuilding/restarting the backend that owns learning. Editing
source does not update an already-running process. No restart, runtime configuration,
existing journal/memory modification or follow-up scheduling is part of this change.

## Unsaved Wiki candidate recovery

Reflector `learning_result` accepts optional `pendingCandidates` on unfinished
outcomes. Each contains a supported relative Wiki `path`, short `correction`,
next `action`, `conditions` (including uncertainty/revalidation), and exact
assigned `sessionId`/`physicalId` message `[offset,end)` evidence. Limits are four
unique paths, four references each, 1200 UTF-16 code units per note and 256 per
source ID. Full drafts and unknown fields are rejected. Notes are not artifacts,
logs, published facts, authority, or proof of source review.

The Project learning journal retains these with the partial proposal, across
completion, interruption, restart and rebinding. Omission (including an empty
array) does not erase existing candidates. Retry tasks explicitly prioritize
these pinned leads, rereading evidence and the current Wiki before merging a
supported correction. No draft is replayed automatically. Resumed candidate saves
require `read_wiki` in that attempt against the current revision; ordinary stale
revision protection and save/readback/provenance checks still apply.

Use `resolutions` with path, outcome (`published`, `duplicate`, `superseded`, or
`unsupported`) and reason to retire an earlier candidate after a fresh Wiki read.
Published needs a currently matching recorded artifact; other outcomes require
the read revision still to match. The journal keeps the latest structured
resolution; historical tool receipts preserve earlier reasons. The host checks
structure, scope and persistence, not whether the reason or correction is true.
Unresolved candidates prohibit `applied`/`no_change`. Resolving one does not bypass
full assigned-source coverage or permit acknowledging unread ranges. Failed saves
leave the candidate pending. A candidate remains pending through the existing
three-deferral automatic pause; manual retry policy and execution ceilings are
unchanged. Old prose-only partial receipts are not parsed or migrated into
candidates: this mechanism only helps newly structured receipts.

Deployment requires loading the updated backend. For a later bounded cron audit,
check an actual identified-but-unsaved correction yields a structured candidate,
then a retry includes the same physical refs and a fresh current-page read. It
must either persist a source-grounded correction with conditions and provenance,
explicitly explain a duplicate/superseded/unsupported disposition, or honestly
retain it pending/paused. Verify no duplicate logs, stale overwrite, invented
human authority, automatic draft publication or cursor advance over unread work.
Compare the resulting page to source, not merely receipt counts; semantic benefit
and live model compliance remain unverified by synthetic tests.
