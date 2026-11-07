# Reflection quality audit and targeted revision (2026-11-06)

Goal: accurate, useful retention and consolidation, not event counts or cost.
Read-only audit of Default Project ledger
`/Users/honx/.shadow/projects/default/state/learning/state.v1.json`, selected
assigned parent evidence and persisted knowledge/events. No memory writes or live
model evaluation were performed. This is a bounded sample, not a population score.

## Findings and exact evidence

All parent references below resolve to physical session
`web_chat-07538d4b-d384-4dc5-b837-2d7e4a1b168e-v2-3965928567d5678c4a942605e5e6b4cac884736825b2e0573f91fb990fbc02e3-0`.
The short alias is `v:sessions/~1f094d13b220b2ab`.
Ledger proposals are the reflector's retained receipts, not proof of semantic quality.

- Positive requirement / overconservative consolidation: batch
  `4153d32b-fed7-43de-b294-27b7cb7c8cd5`, attempt
  `cron:4ca65c09-b660-4e27-96da-3eae6849273a`, parent overview
  1346–1482 and exact `c/377.1`. The ask result directly records the human's
  selection: optimize only new images; preserve historical sending representations.
  Event `ffcae1953e25ba593f405523c5760ce87f4b4c2feffc6c8cd2881c4624c3d832`
  exists at `v:memory/events/2026-11-05.jsonl:12` and preserves this accurately.
  Receipt rejects Wiki because implementation is change-prone/unimplemented.
  That rationale conflates a stable scoped requirement with implementation maturity.
  It is not a reason to require a second page: **current**
  `v:memory/decisions/cache-preserving-request-compression.md` already incorporates
  this constraint, attribution, exceptions and revalidation. Therefore the audit
  finds an earlier routing weakness, not a currently missing requirement. Current
  accurate consolidation is the negative/control case: do not duplicate or backfill.
- Appropriate event-only control: batch
  `273eebf3-1d22-43e0-b2da-af4df7b01382`, attempt
  `cron:23e4c274-7c3c-46c1-a64c-2d522b1a259f`, parent overview
  1115–1239, especially #324, #329–335. Human reports restart and continued 408;
  failing-request encoding remains unknown. Persisted event
  `9541befca733d808d227d52863995acf63b87307109232c6aa48ab8b7c718bbd`
  (`2026-11-05.jsonl:10`) appropriately separates reported publication/tests,
  directly visible tsc exit, and uncertainty. Audit did not independently inspect
  the screenshot; it does not upgrade the receipt's visual assertion.
- New evidence / correction control: batch
  `9ece0eff-525e-4369-8655-1f0558243b4c`, attempt
  `cron:4a271cf1-c664-424c-a72f-5d1677b7382e`, parent overview
  1240–1345 (#337–338). Assistant reports screenshot gzip
  8,605,107 -> 6,393,457 bytes yet ~61s/408. Event
  `17d9d5c1fa8e44a8e2d5ce36a05e5a28336347862ff0568c4e41d189162a7c79`
  (`2026-11-05.jsonl:11`) correctly retains reported attribution, not an independently
  inspected screenshot or proven image causation. Earlier unknown encoding is
  superseded only for this reported request, not every request. Current decision
  also retains this qualification. No personal preference or verified fix follows.
- Valuable omission / execution bottleneck: batch
  `fd024a4a-9a56-47c0-8968-7872944a2413`, attempt
  `cron:2999e26d-0475-4d87-9ee8-207bedb38f1e`, parent [276,312),
  overview 992–1114. Exact `c/306.1` shows isolated patch application;
  `c/310.1` shows 309 passes / one agnes suite failure. Receipt recognizes a
  significant publication/validation obstacle but reports no event saved before
  finish. Ledger has zero effects and partial: truthful, but useful retention was
  lost at that boundary. This does not justify loosening receipt verification.
  Later publication event does not erase the omission at the earlier boundary.

Five event-only applied reflector receipts and two partials in the supplied
17:47–23:47 window are not themselves a quality score. The four focused cases above
support a narrow fix; no claim that every omitted Wiki page was valuable, or that
all event-only results were failures. Downstream consolidation demonstrably exists;
observed use to improve a later user-facing decision is still unknown.

## Change

`src/agent/types/builtin/reflector/AGENT.md` and the reflector-specific generated
instructions in `src/agent/learning/pipelines.ts` now explicitly:

1. Separate stability of an attributable human constraint from maturity of its
   implementation; preserve requirements as requirements, not verified behavior.
2. Inspect/merge applicable existing knowledge or decisions, correcting obsolete
   claims rather than forcing new pages. Accurate existing coverage warrants omit.
3. Persist an independently supported candidate after its evidence/destination
   checks, before optional investigation of other candidates. Required source
   review continues; remaining gaps still require partial/blocked.

No new runtime loop, critic call, quota, budget, schedule, ledger semantics or
finish-boundary change. Prompt guidance cannot guarantee semantic compliance or
prevent every future unpersisted candidate.

## Evaluation and next 24 hours

`src/agent/learning/quality-evaluation-fixtures.ts` provides five source-grounded
input/rubric cases: retain a pending human constraint, omit an accurate duplicate,
retain an unresolved failure event, correct unknown status with attributed evidence,
and report a useful unsaved candidate as partial. Fixtures specify prior-knowledge
conditions explicitly; they are not claims about the current store at every date.
`quality-evaluation_test.ts` exercises acceptance and adversarial omission,
attribution, invented-cause, duplication and false-applied annotations. These are
**deterministic rubric tests, not actual model-quality evaluation**. The scorer
checks structured reviewer annotations; it cannot judge free-form prose truth.

For a real evaluation, present each fixture's evidence and stated prior-knowledge
condition to the reflector in a non-writing evaluation environment; independently
map output to action/destination/attribution/rationale/claims/refs, then apply the
rubric. Compare old/new instructions with the same model/settings and inputs.
Do not treat matching a label as proving complete or useful prose. No such model
comparison was run here, and no automatic evaluator or live schedule was installed.

During the next 24h, parent/operator can sample completed and partial receipts with
assigned raw evidence and actual effects (include no_change/duplicate controls):

- Factual fidelity: attributable claims, exact source scope, no reports upgraded to
  verification, no invented causes or deployment/acceptance.
- Valuable omissions: stable explicit constraints or meaningful unresolved events
  discarded merely because implementation is pending; unsaved candidates at finish.
- Destination: requirement consolidation vs event vs conditional decision vs skill;
  no defect-to-personality inference or forced rule/skill counts.
- Actionable lessons: trigger, actual action/result, supported explanation,
  next-time adjustment, exceptions; unknown causes remain unknown.
- Dedup/correction: applicable existing item inspected and merged when needed;
  accurate prior content not duplicated; supersession scoped to evidence.
- Usefulness: count observed later reuse/correction only when assigned evidence
  shows it. Otherwise mark unknown, not successful simply because saved.

Report each dimension with source-linked examples and denominator/unread scope,
not a combined event-count success rate. Compare against these audited controls.
Finish-boundary partials remain failures to retain when valuable effects were not
saved, even if the truthful receipt is operationally correct.
