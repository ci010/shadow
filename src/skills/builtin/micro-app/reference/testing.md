# Exact-version runtime testing

After exact-version owner approval, Shadow asks the local owner whether you
should continue runtime testing (60-second default: continue). This is not
approval for another revision or additional device access. On the
`microapp.testing.ready` event, read `get` and current Work, then use `test` with
that exact revision for an isolated browser handle. Exercise the real UI/SDK;
stop and reopen to check persistence, and check failure/cancel recovery.
Save `report` with startup/state/recovery/reopen results, host observation IDs
from `get.acceptance`, and genuine recorded tool excerpts. Cover every
`get.acceptance.work` criterion in `report.requirements` using
`workKey`, `workRevision`, zero-based `criterion`, and the same result/basis/summary/
observations/evidence fields. Mark unavailable checks blocked/not_tested, not passed.
Before reporting, call `evidence` with this app's `id`, exact `revision`, and
`sources:[{id:"recorded tool call ID",quote:"exact result excerpt"}]` (1-12 entries).
Copy its returned `evidence` references into the relevant checks. The host finds
the real author segment; do not guess `physicalId` or derive it from a session
UUID. Unknown/ambiguous calls and inexact quotes are rejected, not repaired.
Existing complete references remain valid and still undergo verification.
`basis` and `result` are independent: **every `runtime` item needs nonempty
observations, including blocked/failed items**. A partly exercised feature may
be blocked with runtime evidence; a wholly untested feature uses `not_tested`.
Schema rejections locate the affected check/requirement field. Correct that
field without deleting unrelated citations or changing results to evade validation.
For runtime passes, startup needs both `started` and `sdk_connected`.
Cite both ends of the other host observation pairs: `state_saved`
then a later same-version `state_read` on another run for state; `stopped` then
a later `sdk_connected` on another run for reopen; a model/backend failure or
cancellation followed by completion of that same kind for recovery. A `started`
or `state_read` entry does not replace `sdk_connected`. This reopen check does
not require a full Shadow restart; report that broader check separately if tested.
Citation rejections list every affected item, the rule and candidate IDs from
this exact testing request. Inspect their relevance and fix the citations;
retain supported results and tool excerpts for unrelated checks. Candidates do
not prove behavior or authorize more testing. If no matching observations are
retained, exercise the missing check within permission or mark only that item
blocked/not_tested. Separate runtime, fixture and untested results; label real
devices/translation quality unverified
unless actually exercised. Do not extract browser access tokens. Stop the app
and close its browser when done. A reported/stale event is not a new test request;
fixed code needs republication and another owner review.
While awaiting owner review, do not declare the entire delivery done. If using
shared notes, record what is waiting there once. A testing event is not permission
to repeat uncertain effects; inspect them through the owning operation's controls.

## Acceptance

Provide useful controls, visible busy/error/cancel states, and repeat runs.
Check the real result, not only registration or a successful HTTP response.
Reopen after closing, then restart Shadow and reopen without the author session.
Separate prerequisites, inference, playback and OS-device routing. Installing
drivers/changing devices needs its own authorization. The reusable app is the
deliverable; setup scripts alone are not.
