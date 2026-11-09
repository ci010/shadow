# Work storage contract

Work is an optional shared notebook. Conversations and execution do not require
Work records. Current reads use `v:works`; typed dynamic `work_create`, `work_update`,
`work_assign`, `work_review` and `work_link` mutations reuse `WorkAlignment`;
SQL projections are read-only. Note completion, execution activity and human
acceptance remain separate facts.

## Storage

`InitiativeStore` is an internal implementation name. It owns one Project Home's
`state/initiatives.sqlite`, independently of JSONL/SQLite session storage. This
filename and the `src/initiatives/` directory still hold current Work data and
must not be deleted merely because of their names.

Version 6 stores complete records in `work_contracts`, audit events in
`work_contract_events`, effect references in `work_effects`, temporary task/call bindings in
`work_execution_bindings` (legacy `work_focus` is read only for restored temporary lineage), and historical conversation associations in `work_session_links`.
Presentation observations and snapshots remain in `work_observations` and
`project_focus_summary`. Existing current record keys are immutable, including
keys whose persisted prefix is `initiative:`, `item:` or `topic:`.

New databases create only current Work tables. Current version-6 files may
contain unused historical tables; they are not read, imported or deleted.
Version-5 and other unsupported databases fail explicitly before schema changes
or WAL configuration. The runtime does not migrate, replace or remove their
records. Preserve the file and resolve the storage choice explicitly.

## Low-noise coordination delivery

- summary/plan/next/artifacts and ordinary in_progress updates are silent.
- Entering done or blocked routes one notice to the Work manager, not the session parent. A blocked transition plus attention in one write produces one manager fact.
- New unreviewed attention reports a material coordination issue. `awaitingResponse: true` means the executor is waiting; old omitted values are nonwaiting. Identical repeated unreviewed attention preserves its version/identity.
- `work_review` records a conclusion and optional `record | return_to_assignee` disposition. Waiting attention defaults to return; other reviews default to record. Review never changes blocked/status, assignment or authorization. Returned execution must read latest Work; no ack protocol exists.
- Goal changes notify affected active descendants for reassessment; release warns the previous executor without cancelling running operations. Reassessment reviews retire obsolete context notices.

An additive `work_notifications` delivery-fact table is written in the same transaction as Work, without rewriting legacy records or changing the v6 boundary. It is an internal delivery ledger, not another approval or task system. Delivery/settlement writes produce no Work events. Historical Work is not backfilled into wake events at upgrade.

SessionManager admits at most one Work wake marker per recipient. `next-step` uses the existing input queue and safe checkpoints rather than aborting current inference; consumption merges all currently pending facts. Before appending anything, it checks current assignment generations, manager/assignee, status episode, attention/review identity and ancestor basis. Ended/reassigned/reviewed/reopened episodes are discarded. done reopening and blocked clearing expire the old facts atomically, so subsequent completion/blocking is a new episode. Manager null, manager=assignee and mutation-source=self never invent a recipient or self-wake.

Facts remain pending if the responsible durable session is unavailable, retired, in explicit recovery or cannot admit input. Recovery is attempted on runtime startup, later Work changes and ordinary input admission; there is no polling or LLM retry loop. Temporary task/call executions are not reopened as coordinators. Issues remain visible in notes even without a usable coordinator; no human approval is synthesized.

A physical-log delivery stamp is saved before append. Settlement happens only after the combined notice is persisted. Recovery checks the stamped JSONL/SQLite physical logs (including older context segments) for the host notice receipt before redelivery; stopping a session clears only its in-memory marker reservation. This closes the append/settle crash window without replaying a completed handoff. Normal interrupted-turn recovery still applies: delivered history is not proof that the model completed its response. Delivery facts/receipts are retained; this change adds no garbage collector or cross-runtime distributed consumer lock.

## Retired Work execution channels

Current Work actions are `context/list/tree/create/update/assign/review/link`.
Versioned notebook update, assignment and impact review use their dedicated
methods; the legacy generic `execute` mutation routes are removed. Work-specific
adoption, checkpoint, proposal approval/application/recovery, and fresh/successor
context lifecycles no longer execute. Ordinary `ask` decisions, task review,
conversation realignment and context clearing remain independent capabilities.

The current strict record schema/type has no `adoption`, `checkpoint`,
`transition`, `answerReview`, `handoffFrom`, `successors` or `proposals`.
`parseStoredWorkRecord` omits exactly these top-level keys at database read
boundaries, then validates all current fields strictly. Arbitrary unknown keys
and corrupt current fields still fail. Current writes reject retired keys.
Historical audit payloads omit the same top-level keys but preserve other audit
details; they are partial historical facts, not current Work records. Effect and
persisted decision stamps omit only retired `adoptionId`; current stamp writes
remain strict. Existing stored JSON is not rewritten by this compatibility read.

A decision containing `workProposal` fails closed, including old pending or
settled records. It cannot be answered, applied, recovered, or silently converted
to an ordinary approval. Reading a decision-history segment containing such a
record explicitly errors rather than presenting a misleading ordinary question;
other segments remain separate. No startup proposal application or successor
creation remains. Resolving a goal change now requires a new ordinary decision
in its current context and an independently authorized notebook update.

Retained fields include definition/acceptance/boundaries/evidence, attribution
(`origin`, `requestSource`, `changedBy/At`, `change`, `reason`), `paused` (automatic
execution preflight), workflow status/blocked metadata/results, parent/dependency
relations, manager/assignee and assignment generations, notes/attention/basis,
record revision/sequence, creation idempotency, Bot intake, automatic execution
receipts and presentation observation. They still serve current notebook,
authority, scheduling, reporting or compatibility behavior; a historical-sounding
name alone is not grounds for deletion. Completion/read receipts remain separate.
Overview wire data no longer exposes adoption/proposal/reinterpretation flags or
applied-proposal influence links; ordinary decision context/reference history is
retained. No current visual design or layout is changed.

## Identity and input

The public optional `workRoot` parameter accepts a canonical Work key, selecting
that note and its descendants as context. Actual membership is validated in the
owning Project. It neither assigns responsibility nor changes permissions.
`work: {key}` on session creation has distinct assignment/link semantics;
`message.work` is an explicit assignment kickoff with an assignment revision.

Session persistence retains the internal `initiativeId` field for current Work
keys. Both JSONL and SQLite reject old slug values, `projectName`,
`initiativeName` and old planning-tool preloads instead of silently converting
or discarding them. Cron uses the same validation. Old public selector aliases
are unsupported. A failure leaves stored records and conversation history intact.

## Integrity and authority

Writes use transactions and expected record sequences. Work identities cannot
change during replacement. Parent/completion cycles and missing references are
rejected. Audit entries and assignment admission receipts persist with the Work.
Only current Work tables are allowed by the SQLite engine authorizer; file
attachment, arbitrary schema changes, external databases and extension loading
are denied. This database boundary is not an OS sandbox.

Actual authorization, assignment and acceptance checks remain in WorkAlignment
and the owning execution services. Idle, stopped or missing sessions do not
release assignments or authorize replay of uncertain effects.

## Focused verification

`pnpm exec node --import tsx --test src/initiatives/store_test.ts
src/sessions/initiative-metadata_test.ts src/sessions/initiative-store-migration_test.ts
src/cron/initiative-migration_test.ts src/sessions/work-items_test.ts`

These tests use disposable local fixtures, never production Project databases.

## Completion awareness

The Work board and overview show active work by default, without a permanent
Done column. **View completed** opens a searchable/filterable history grouped by
completion date. **Newly completed: N** narrows it to unread results. Result
summaries and artifact links use existing recorded data; missing completion
timestamps are explicitly unavailable, not inferred from `changedAt`.

Opening the board or completion list does not acknowledge results. A successfully
loaded, visible Work detail acknowledges only a completion occurrence no newer
than the displayed record sequence. **Mark all as read** sends the exact observed
unread occurrences, independently of search filters. Read means human awareness,
not acceptance: it never changes Work status, audit history, assignment, or agent
execution, and has no age-based expiry.

Version 6 gains additive `work_completions` and `work_completion_reads` tables.
A transition into `done` writes a UUID, host completion time and record sequence
atomically with the Work record. Notes do not create a new occurrence; reopening
and completing again does. Historical occurrences remain stored. Existing done
records get a stable `legacy:<work-key>` occurrence on initialization, initially
unread. Only a contiguous recorded completion transition supplies a legacy time;
missing/ambiguous history leaves it null. Existing Work records/events and session
JSONL/SQLite are not rewritten.

`GET /api/work/completions` returns current done occurrences with `key`,
`completionId`, `sequence`, nullable `completedAt`, and `unread`.
`POST /api/work/completions` accepts `{items:[{key,completionId}]}` and returns the
updated list. Stale/unknown references cannot acknowledge a newer completion.
Both endpoints require the existing Project authorization, return `no-store`,
and never accept client-selected identities. The current gateway has one human
principal (`web:web-user`) shared by its authorized browser/desktop/device
surfaces, not separate human accounts. Receipts are principal- and Project-scoped;
they are fetched separately from shared live Work snapshots. Other open clients
see receipt changes on the next refresh; no new receipt-only realtime stream is
introduced.

Completion checks: `pnpm exec node --import tsx --test
src/initiatives/work-completions_test.ts src/projects/work-completions_test.ts
app/src/project-work_test.ts app/src/work-completions-rendered_test.ts`.
The rendered fixture uses a disposable Electron user-data directory, synthetic
Work data and mocked unrelated integrations, never a copied user profile.

## Single unfinished assignment

Each durable session may be assignee of at most one unfinished Work in this Project.
Pending, in_progress and blocked all occupy the slot, including paused Work.
Done/cancelled keep their historical assignee without occupying the slot. Managers
and historical links may cover many Work records and never supply a default scope.
`saveWork` checks new admissions, reassignment, reopening and automatic claims inside
its SQLite BEGIN IMMEDIATE transaction. Conflicts name the existing Work; nothing
is silently released. Legacy duplicates remain readable and editable/completable or
releasable; they cannot gain another assignment. Ambiguous legacy assignments have
no inferred current Work: questions must provide an explicit key until convergence.
Current scope is derived from the unique unfinished assignment; legacy persisted
selection is ignored for durable sessions; restored task/call lineage can still read its legacy binding. Temporary task/call bindings are separate context references,
not assignments, and remain stable across parent progress and assignment changes.
