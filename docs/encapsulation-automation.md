# Encapsulation automation: candidate and acceptance boundaries

The encapsulator selects unconsumed completed reflector logs plus retained
Project Wiki/log candidates. Discovery scans direct Markdown files in
`memory/topics`, `concepts`, `tools`, `decisions` and direct JSONL files in
`memory/events`. Session/identity/convention/internal data, symlinks, nested
folders and files larger than 256 KiB are not scanned. Malformed JSON or genuine
read errors are surfaced, not silently reported as no-change. Large/nested
knowledge still needs an explicit reflector log/reference. Content is evidence,
not execution authority.

Wiki candidates use content revisions as IDs; log IDs are preserved (legacy
records without IDs use a path/content hash). Reservations and consumption are
journaled by the existing ledger, never separate source watermarks. Existing
reflector effects cannot enter through external discovery while their owning
batch is unfinished. Completed receipt logs win deduplication. At most eight
encapsulator candidates are assigned per batch; pending/fresh fairness and retry
limits continue to apply. Unchanged no-change Wiki revisions are not reprocessed;
there is no automatic expiration/revalidation of already-consumed candidates.

The prompt permits narrow experimental skills from useful challenges without
requiring cross-log successful outcomes. A diagnostic procedure can be useful
while the incident remains unresolved, but must label unknowns and verification
limits. Noise and duplicate avoidance remain required. `learned_skill` continues
to revision-check and verify real shared-store discovery; no executable packages,
admin capabilities or bundled overrides are admitted. Host receipt/effect audit
still determines acknowledgement, not natural-language completion.

Script candidates use `invoke_tool` → `agent_tool_test`, now explicitly included
in encapsulator trusted limits and builtin role. Nested invocations remain subject
to the same allowlist. Tests are synthetic and grant no real resource access.
Executable publication is deliberately NOT automatic; exact source/schema/cases
and test evidence can be retained as a lesson/handoff. See the concrete
[experimental tool draft](encapsulation-tool-handoff.md). An installed lesson with
a tool draft is not an installed tool; only-script drafts report draft_only.

## Recovery from rejected physical-history typos

A read error specifically saying `Physical history does not belong to this
Project session` can be matched to an unambiguous exact assigned log reference
with the same logical-session prefix, segment and overview/full view. The bad
resource failure is then audited against the corrected reference. **Subsequent
complete page coverage is still required**; gaps, truncation, different logical
sessions/segments/views, ambiguous references, generic permission/I/O errors and
unresolved writes remain blockers. This does not erase attempts or ledger errors,
modify historical content, or mark the pending batch complete. Existing retries
must execute and submit a newly verified receipt; paused batches need manual
`/learn` through the existing runtime.

## Verification and rollout

Focused tests cover revision consumption, log/Wiki deduplication, unfinished
reflector isolation, real shared skill-store acceptance and typo recovery. These
are synthetic fixture executions, not a production LLM experiment. Source changes
require the normal build/restart/deploy path; no application restart is performed
by this work. Do not compare pre-deployment no-change rates as if they ran this
prompt/input discovery. The task worker cannot create durable cron jobs; its
parent must create finite +6h/+24h/+48h read-only checks through existing cron.

Each check should record deployment/build boundary and window first, then inspect
actual skill files/discovery, any tested script source and publication state,
strongest no-change reasons, unresolved read/write failures and cross-attempt
recovery, retry pauses, token/iteration consumption. A completed run alone is not
a useful artifact. No new code deployment means report baseline only; do not
restart, force retries, publish tools or mutate the ledger from monitoring.

## Second-pass bounded maintenance and observed recovery (2026-11-07)

The automatic `learned_skill` limit is **8000 UTF-16 code units after trim** for
complete SKILL.md, including frontmatter. This is the learning tool's Zod limit,
not the shared `SkillEditStore` package limit (8 MiB across the complete package).
Raising the package limit or using `skill_save` as an automatic bypass would not
repair the learning workflow. No limit was increased.

`learned_skill read` now returns `contentLength` and `limits` (including a 7200
recommended target). The tool contract and dispatched task expose these limits
before saving. `action: "check"`, with name/read revision/complete content,
returns `withinLimit`, `overBy` and `saved: false`, even for oversized content.
It checks size and revision only, not package validity, authorization for execution
or usefulness. It never writes, registers an artifact, or clears a failed save.
The normal save still validates the standalone lesson restrictions, revision,
shared edit store and immediate discovery. Concurrent changes require a reread.

Maintenance is replacement, not append-only growth: merge overlapping steps,
remove duplicate examples, shorten repeated explanation and regroup guidance.
Keep applicability, safety constraints, counterexamples, source/date evidence,
unknowns and revalidation triggers. Aim below 7200 to leave headroom. Check before
the first save; if oversized, make one focused consolidation and check again.
Do not silently truncate or discard valuable conditions, split duplicate skills,
or keep retrying oversized writes. If it cannot fit within the remaining budget,
report partial and identify the unsaved scope. Reserve capacity for the receipt;
this change does not alter the host finish/budget enforcement.

A successful same-name save resolves earlier failed saves in cross-attempt tool
history; a size check or a successful save under a different name does not. This
is tested separately from actual shared-store persistence and verified receipt.
Synthetic real-store tests demonstrate a near-limit existing lesson, oversized
increment, non-writing preflight and consolidated replacement with retained
conditions; they are not proof that the production LLM will consolidate well.

### Read-only findings, not a recovery execution

A read-only inspection of the default Project ledger on 2026-11-07 found:

- `7ba14e0b-b8c7-4965-ad13-bd586e94eeba`: pending, ten attempt IDs and ten
  deferrals, no `retry.paused` text. Its retained blocked proposal describes the
  malformed `f838aca7a` history ID versus assigned `f83865aca7a`, with subsequent
  complete correct pages. The error field also retains an iteration-limit error.
- `6838ed78-7d5c-4fec-887b-bf3b29b6dea3`: pending, three deferrals, explicit
  automatic-retry-limit pause and a partial proposal reporting two oversized
  learned_skill saves, no saved revision/artifacts in that batch.

Absence of the old batch's human-readable `paused` field is **not** eligibility:
`LearningLedger.pending(pipeline, true)` excludes retry attempts >=3 even when
that field is absent. `recover()` only reconciles running batches; it does not
reset pending retry counters, rerun parked work, clear errors or acknowledge a
blocked/partial proposal. Thus deployment alone cannot produce an eleventh
attempt for the parked old batch. Its retained proposal is evidence of an older
attempt, not proof that the current correction ran and failed. The exact build
loaded for each historical attempt remains unverified. A disposable legacy
fixture reproduces ten deferrals with no paused text, restart/recover, no
automatic dispatch and preserved manual eligibility.

Safe runtime path, **not performed here**:

1. Establish the loaded backend build includes typo recovery and the size/check
   contract, plus the revised encapsulator instructions. A source diff or an App
   restart claim is not sufficient. No restart/deployment was performed here.
2. In an authorized durable owner session inspect status and the pending batch
   IDs again. With explicit human intent, use the existing `/learn encapsulator`
   once; it is pipeline-level, **not a batch-ID selector**. Manual selection
   bypasses cooldown/parking, but pending/fresh fairness may choose another
   batch. Check the actually admitted session/batch; do not loop commands trying
   to drain all failures. Stop if it selects a different batch or fails again.
3. For the typo batch, use exact assigned refs and complete later page coverage;
   host audit, not a human-edited ledger, must accept recovery. For the oversized
   update, read the current skill (it may have changed), consolidate/check/save
   with its revision and report unsaved scope honestly. Preserve previous effects.
4. Verify the new receipt, skill discovery and stored revision, remaining errors
   and batch state. A blocked/partial result stays pending and retains evidence;
   do not reset counters or mark done by hand. Repeated manual retry is not a
   fix. If wrong-batch selection prevents the intended run, stop and report that
   targeting limitation rather than silently adding a ledger mutation path.

`v:skills/.raw/<name>` remains durable-session-only. This temporary worker's two
raw production skill reads were denied by that boundary; no alternative raw
filesystem access or production skill writes were attempted. The parent durable
session must inspect the current `cache-preserving-transport-probe` and
`legacy-metadata-removal-audit` before any authorized real maintenance experiment.

### Tool candidate threshold

A concrete costly/error-prone bounded mechanical step can justify a small
experimental script draft before high frequency is proven. Require explicit
input/output, a falsifiable positive/negative test and usefulness hypothesis;
no quota. Pure no-grant transforms remain the default safe synthetic test scope,
not a claim that only pure transforms could ever be useful tools. Resource-backed
ideas must identify missing authorization/evidence, not bypass it. Existing draft
source and `agent_tool_test` results are still draft/synthetic evidence, never
installation, grants, live delivery or publication. No new tool was fabricated or
published in this second pass.

### Local verification of this second pass

Final focused command: `pnpm exec node --import tsx --test
src/agent/learning/pipelines_test.ts src/agent/learning/batch-isolation_test.ts
src/agent/learning/read-coverage_test.ts src/tools/skill-edit_test.ts` — 44 passed,
0 failed. Includes empty/8000/8002 UTF-16 preflight boundaries, real-store
replacement/discovery/receipt, cross-attempt failed-save recovery, and legacy
parking without a paused string. `git diff --check` on the four edited source
files passed. Earlier fixture failures (oversized initial test data and counting
an untrimmed trailing space) were corrected; they were not product-limit changes.

`pnpm typecheck` passed twice during development (backend, A2A bridge, desktop,
Vue). The **last** run after the final test addition failed in concurrent work
outside this change: `src/cron/work-dispatch.ts(34,39)`, TS2339,
`getActiveSession` absent from its `Pick<SessionManager, ...>` type. It stopped
at the backend stage, so that last invocation did not reach later packages.
No fix was made to that separately owned code. Do not report the final worktree
as typecheck-clean based on the earlier passes. No production learning write,
retry, restart, commit, push or tool publication was performed.

## Third pass: save before the receipt boundary (2026-11-07)

This section supersedes the second-pass **mandatory check-before-save** advice.
The reported deployed second version (2026-11-07 13:25) checked a 5139-code-unit
replacement in batch `ba4891d7-4282-4983-a6e0-26ec0e9aa481`, but reached the host
finish boundary before save: partial with no artifact. A passing check was not a
save. The reported 48-hour baseline (46 batches: 30 done/no_change, 10 done/applied,
6 pending) includes older versions and is not an acceptance test of this change.

No new capability or budget increase is needed: existing `learned_skill save`
already performs size/schema, standalone-package and revision checks, shared
edit-store save and immediate discovery verification in one call. `check` remains
optional non-writing size feedback for genuinely uncertain drafts. It is not a
prerequisite. Prompt/tool guidance now prefers direct save of a bounded draft and
prompt persistence of the first independently supported candidate before optional
investigation/script experiments. Consolidation still preserves safety conditions
and evidence; failed/oversized/stale writes do not count as effects.

Host ceilings are unchanged: encapsulator has eight inference requests, 24 tool
calls and 192000 argument bytes. The eighth request is receipt-only, so a save must
be issued by the seventh; reserve a work call and draft argument capacity as well
as the existing reserved receipt call/bytes. Work calls cannot spend the reserved
receipt capacity. No save is admitted after finish, no automatic receipt or ledger
rewrite is introduced. These instructions improve model planning, not enforce a
successful candidate/save by request seven: an uncooperative model, missing evidence,
conflict, invalid draft or provider error can still leave partial/blocked work.

Real disposable edit-store tests cover oversized/stale rejection without effects,
a valid direct replacement on the last available work tool call, discovery and
receipt after work capacity is exhausted. JSONL and SQLite session-loop tests drive
six evidence inferences, a real save on inference seven and receipt-only inference
eight, verifying stored content, artifact, done outcome and no ninth request.
Synthetic provider responses prove admission/lifecycle behavior, not autonomous
production model planning or real-world lesson usefulness. Existing tests retain
non-writing check, failed-save recovery, and legacy parked-batch boundaries.

Script thresholds/publication rules above are unchanged; there is no script quota.
The concrete `encapsulation-tool-handoff.md` candidate remains a synthetic draft,
not installed executable code. A lack of installed tools does not justify inventing
one. Reassess a particular candidate against its actual loaded prompt/version and
pain point; do not aggregate pre-deployment windows as a current rejection test.
Old parked batches remain parked: no manual retry, ledger modification or production
learning write was performed. Use the bounded authorized manual recovery path above,
not repeated attempts. Source edits require normal deployment; no restart, commit,
push or executable publication was performed. Finite follow-up scheduling belongs
to the durable parent and must distinguish baseline from deployed third-pass runs.

Third-pass final local verification:
- `pipelines_test.ts`, `batch-isolation_test.ts`, `read-coverage_test.ts`,
  `skill-edit_test.ts`, `learning-finish_test.ts`: 46 passed, 0 failed.
- `execution-modes_test.ts` filtered by `bounded learning|invalid final learning|last learning work`:
  10 passed, 0 failed, covering JSONL and SQLite. A prior unfiltered combined run
  had 157/160 pass: one new fixture lacked opt-in role/attempt setup (fixed and
  rerun); the other two were existing native-admission replay assertions at line
  727 (`2 !== 1`) outside this change, not repaired here. Do not call the full
  execution-mode suite clean on the strength of the filtered pass.
- Final `pnpm typecheck`: passed backend, A2A bridge, desktop and Vue.
- Scoped `git diff --check`: passed. Existing concurrent edits were preserved.


## Fourth pass: exact corrections and named unresolved failures (2026-11-09)

`learned_skill patch` accepts `name`, the current read `revision`, a nonempty
unique exact `match`, and `replacement` (empty means deletion). It updates only
that span, then follows the same complete-lesson trim/8000 UTF-16 limit,
standalone lesson/schema/name restrictions, shared-store revision-checked save,
immediate discovery and artifact recording as `save`. Missing/ambiguous matches,
concurrent changes, oversized results and executable/admin packages are rejected;
there is no fuzzy/global match, automatic truncation or larger budget. A stale
revision requires reread/merge, not overwrite. This is a small non-executable
maintenance operation, not a bypass through general `skill_save`.

Correct guidance superseded by later authoritative human design first; optional
new diagnostic sections should not crowd that correction out. A minimal patch
can avoid retransmitting and regrowing the entire lesson. If it cannot fit or
needs structural changes, save a complete consolidation preserving evidence,
safety constraints and applicability, and report deferred extensions separately.
Neither route guarantees semantic quality or a production model choosing to save.
No duplicate skill should be created just to evade the limit.

The initial suspicion that batch `cc71d395-04ef-4a6c-8803-1e75581b201b`
incorrectly retained a repaired error was **not supported by the actual calls**:
- `v:sessions/~1fec58e561491e3e/c/24.1` and `/c/27.1` failed oversized
  `mixed-version-execution-gate-audit` saves; `/c/21.1`, `/c/21.2` and
  `/c/24.2` successfully saved three *different* skill names.
- `v:sessions/~e57a9d2aa335fac3/c/17.1`, `/c/19.1` and `/c/21.1` again
  failed saves of `mixed-version-execution-gate-audit`, with intact name/action
  arguments and Zod `too_big` errors.
- The final attempt's baseline reads and other decision artifact did not save
  that failed target. Its rejected applied receipt at
  `v:sessions/~2bf659120c2bfade/c/18.1` therefore correctly retained a blocker.

No production ledger/history/skill was changed or parked batch retried. Recovery
still requires a later successful **same-name write**, not a read/check or another
skill's success. Patch is now tracked as such a write: a failed patch retains the
blocker and a successful same-name patch resolves it. Failure receipts now include
the target key obtained from the paired call arguments, so a bare `too_big` result
does not hide which lesson still needs correction. They do not infer a target
from error text or clear unresolved errors on discovery alone. Read-coverage
requirements are unchanged.

Disposable focused tests cover real-store correction/deletion, unchanged safety
and evidence, ambiguous/missing/empty match, oversized/invalid/admin result,
stale revision and a real intervening peer save with reread/merge. Cross-attempt
audit fixtures use an actual learning-tool Zod `too_big` result and cover read,
check, different-name save, same-name save, failed patch and successful patch.
All five focused files (`pipelines`, `batch-isolation`, `read-coverage`,
`skill-edit`, `learning-finish`) pass: 50 tests, zero failures. Initial fixture
mistakes (no skill runtime, a supposedly ambiguous string occurring only once,
and expected trailing whitespace despite normal save trim) were corrected.

These are code/fixture guarantees, not evidence that the production LLM will
prioritize the correction, consolidate well, use the patch or produce a useful
script. Existing synthetic script-test/publication boundaries remain unchanged;
no tool was invented or published. Source changes have not been built/deployed or
restarted by this work, and pre-third-build observations must not be attributed
to the third or fourth version. The parent owns finite read-only follow-up after
establishing the actually loaded build and admitted run window.

Final fourth-pass `pnpm typecheck` passed backend/scripts, A2A bridge, desktop and
Vue; scoped `git diff --check` passed. Existing concurrent edits were preserved.
No commit, push, restart, production knowledge write or ledger mutation occurred.

## Fifth pass: actionable host size feedback before another rewrite (2026-11-11)

The reported production `event-provider-boundary-audit` attempt at
`v:sessions/~23df2f84966aad3e/c/17.1` eventually patched and completed its
receipt after three oversized whole saves. This is parent-supplied evidence that
patch recovery works, not evidence that the model chooses it early. The reported
12:15 baseline was 63 batches (31 no_change, 22 applied, 10 pending); this local
change has not run in that production window.

The minimal change is host feedback, not a new stateful write prohibition:
- `learned_skill read` now supplies `maintenance.headroom` (8000 minus trimmed
  current length), `preferredAction` (`patch` at >=7200, otherwise
  `save_or_patch`) and correction-first guidance. This recommendation does not
  reject a legitimate complete replacement, including one above the 7200 target.
- An oversized save, including a patch whose resulting complete lesson is too
  large, retains a Zod `too_big` failure but now reports exact trimmed
  `contentLength`, `maxLength` and `overBy` in UTF-16 code units. The first
  rejection explicitly directs the next maintenance write to an exact correction
  patch or one genuinely shortened complete consolidation, deferring optional
  expansion. It identifies unsaved scope/partial as the honest stop path.
- Read/check still cannot clear a failed write; only a verified same-name write
  can recover it. The failure occurs before edit-store save/artifact recording.
  The existing paired-call audit and receipt validation remain authoritative.

This deliberately avoids a per-name retry ban, forcing patch-only maintenance,
raising limits, automatic deletion or inventing a required output. **The host
ensures accurate feedback and rejects oversize content; choosing the advised
next action remains model behavior.** It does not stop generation of repeated
bad arguments or guarantee saving before the receipt boundary. Existing hard
work/receipt budgets remain the backstop. Evaluate actual post-deployment calls,
not prompt presence, before claiming fewer wasted rewrites.

Local verification: five focused files (`pipelines`, `batch-isolation`,
`read-coverage`, `skill-edit`, `learning-finish`) passed 53/53; `pnpm typecheck`
passed backend/scripts, A2A bridge, desktop and Vue. Extended real edit-store
coverage checks near-limit headroom/action hints, first and repeated failed
writes, exact trim/emoji lengths, unchanged stored revision/no artifacts, then
an accepted shorter full replacement and receipt. Existing audit cases retain
read/check/different-name non-recovery and same-name save/patch recovery. The
first development run failed because a Zod-v4-style error callback was ignored
by this repository's Zod v3; replaced it with a typed `superRefine` issue and
reran both checks successfully. No dependency or limit was changed.

No production skill/memory read or write, `/learn`, ledger edit, recovery retry,
commit, push, restart or deployment was performed. In particular the reported
parked `7ba14e0b` (ten attempts), `6838ed78` (three), and `cc71d395` (three)
remain outside this local change's recovery scope. The obsolete independent
Grant guidance in `mixed-version-execution-gate-audit` has **not** been corrected
by this work. Do not equate feedback deployment with backlog recovery. Any
later authorized maintenance must reread the current revision, save the actual
correction and verify its receipt; the bounded manual path and targeting limits
above still apply.

After parent review, the durable parent owns finite +24h/+48h read-only checks:
record the loaded build and admitted window, same-name oversized attempts before
first correction, actual saved revision/discovery/receipt, unsaved corrections,
remaining parked batches and budget consumption. Without deployment report
baseline only; do not retry parked batches or mutate knowledge during monitoring.
