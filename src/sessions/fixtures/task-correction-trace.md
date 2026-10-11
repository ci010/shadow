# Task-correction trace regression

This is a **trace-derived deterministic runtime eval**, not a replay of the
historical model's complete request. The fixture contains only the failing tool
call and provenance; it does not copy the full conversation, credentials, source
files, provider state, or system prompt.

## Source

- Project: `default`
- Session: `web:chat-82deb2f7-237b-4730-8e7d-cc6d10cb416c`
- Inspect trace: `e9b81804b60c3b30c5f5d5086791de30`
- Parent inference span: `6cd66e5ed7e4b2a9`
- Failed `message` span: `1d396c935ce91a6d`
- Child in-flight inference span: `d04d4dd508007fcb`
- Tool call: `call_ZDBziaB8yfArnppCcxzrOg4I`
- Tool started: `2026-10-10T14:49:10.172Z`

The JSON fixture's arguments and observed error were checked against both the
source session log (records 59–60, owner/running evidence at 63) and the inspect
OTEL tool span. At failure, the child inference was still running
(`14:49:08.827Z`–`14:49:36.410Z`) and the sender was its actual parent. The original
`silent:false` mapping produced `queue`; no correction was admitted. The child
subsequently completed its original task.

## Repeat the eval

From the repository root:

```sh
pnpm exec node --import tsx --test --test-name-pattern="inspect trace" src/sessions/input-scheduling_test.ts
pnpm exec node --import tsx --test src/tools/message_test.ts
pnpm exec node --import tsx --test --test-name-pattern="parent correction during|message context handoff" src/sessions/input-scheduling_test.ts
pnpm exec tsc --noEmit
```

No original workspace, OTEL database, network access, configured model, or user
credentials are required for these repeat runs. Every run uses disposable local
session stores; no Minecraft/source-repository operations from the original task
are replayed.

The trace eval uses the exact captured arguments through the real
`Tools.execute -> MessageTool -> SessionManager -> EphemeralSession` chain.
Only the provider is controlled: it pauses an in-flight inference so admission,
application and completion can be asserted separately. Across JSONL and SQLite,
it checks:

- The captured legacy `silent:false` request resolves to `next-step` and is admitted.
- The in-flight provider is not aborted; admission is not claimed as application.
- The next provider input includes the correction; `pending -> applied` records
  have the same input ID as the receipt.
- An obsolete final draft does not finish the task; an obsolete tool does not run.
- The corrected task completes once and cannot be restarted by another message.
- Explicit `queue` and `silent` are not converted to steering for a running task.
- A non-owner is rejected; a terminal execution is rejected.
- Rejected inputs produce no sent projection or additional assignment.

The message unit tests separately cover the single advertised `delivery` control,
legacy aliases, explicit-delivery/attention combinations, invalid mixed arguments,
routine archival, stale work and authority guards. Existing handoff tests now use
explicit `delivery:"queue"` when they intend subsequent work.

## Recorded validation (2026-10-10)

An isolated source copy restored only `message.ts`, `session-manager.ts` and
`tools-guideline.ts` to their pre-fix Git versions while keeping the same tests.
The four positive trace cases reproduced the original rejection before the fix
and passed afterward. All six trace cases pass after the fix; the two additional
cases also assert the new, specific rejection diagnostics.

- Message unit tests: **12/12 pass**.
- Trace + existing correction/handoff tests: **12/12 pass** (six trace cases).
- Backend TypeScript check: **pass**.
- Broader six-file suite: **176/200 pass, 24 fail**; isolated pre-fix comparison:
  **168/200 pass, 32 fail**. All 24 remaining failure names also occur in the
  baseline. These include previously stale prompt snapshots/assertions, HTTP
  cancellation fixtures, reporting and Project fixtures; this is not an all-suite
  green result. No unrelated snapshot refresh or repair was bundled into this fix.

Local run logs are under `.test-artifacts/message-steering/` (not required by CI).

## Limits

The historical `agent.chat` span has no `prompt.capture.request_id`; the persisted
session log has no system message. Existing prompt capture is opt-in/in-memory and
does not capture a full provider wire request. We cannot reconstruct or claim an
exact historical model continuation from this trace. This eval establishes the
runtime correction contract, not the probability that a live model chooses the
new arguments or the quality of its workspace analysis.

The detailed delivery mismatch is visible through `message`. Non-owner/closed
codes are tested at the manager boundary; the tool's earlier boolean authority
checks can still return a general refusal. This patch does not unify all admission
diagnostics or change completion/status inspection UX. It also does not install,
restart or update an already packaged backend.
