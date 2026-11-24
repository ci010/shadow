# Work storage contract

Work is an optional shared notebook. Conversations and execution do not require
Work records. Current reads use `v:works`; typed dynamic `work_create`, `work_update`,
`work_assign`, `work_review`, `work_link` and `work_note_create` mutations reuse `WorkAlignment`;
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
`project_focus_summary`. Persisted Work identity is its immutable `work:<uuid>`
key. Session topics and presentation observations are separate; they never
confer Work authority. Obsolete Work identifiers and subject fields are rejected.

New databases create only current Work tables. Current version-6 files may
contain unused historical tables; they are not read, imported or deleted.
Version-5 and other unsupported databases fail explicitly before schema changes
or WAL configuration. The runtime does not migrate, replace or remove their
records. Preserve the file and resolve the storage choice explicitly.

## Interaction routing

The system prompt, `message`/typed Work tool descriptions and the `peer-sessions`
and `work-coordination` Skills share one selection rule:

- **Observe:** inspect relevant session history/tool results and existing Work.
  Looking at a peer's work does not imply contacting or waking it. Missing/stale
  evidence is reported as uncertainty, not repaired with routine status pings.
- **Discuss:** use free-form Message for questions, discussion or one-off
  coordination that needs participation. Routine acknowledgements are unnecessary.
- **Maintain shared facts:** prefer existing Work when an exchange develops a
  durable commitment, deliverable dependency, blocker or recovery need. A first
  conversation does not require Work, and longevity alone is not the criterion.
  Discussion can continue in Message; agreed state belongs in Work, not both.

This is prompt/tool guidance, not a semantic classifier that blocks Message calls
or guarantees model tool selection. Work and messages grant no new permissions.

## Low-noise coordination delivery

State persistence, recipient/transition matching and action notification are
separate host responsibilities, not three calls required from an agent.
`InitiativeStore` persists state and notification facts transactionally;
`workNotifications` selects meaningful responsibility/context transitions,
`currentWorkNotification` expires obsolete ones, and SessionManager admits the
remaining targeted updates. A change is necessary but not sufficient for a wake.
This is the existing manager/assignee/ancestor routing, not arbitrary peer
subscriptions: `work_link` associations and dependency edges do not themselves
subscribe sessions. A necessary recipient outside supported routing can receive
one direct actionable message referencing the Work, without duplicating an
already-routed notification. No new subscription API is introduced here.

- Routine summary/artifact and in_progress updates are silent. Entering done or blocked can notify the Work manager, not the session parent. Trusted automatic host blockers use publisher-help instead of a duplicate ordinary blocker notice.
- Goal changes notify affected active descendants for reassessment; release warns the previous executor without cancelling running operations. `work_review` takes the current version and a conclusion, refreshes a stale ancestor basis, and retires obsolete context notices. It is not a reply and does not change status, assignment or authorization.
- `work_note_create` appends a Markdown comment (`WorkNote {id, workKey, author, createdAt, body, replyTo?}`). The host stamps the canonical durable Project session and UTC time. Only the current assignee posts originals; only the current manager replies to an original on the same Work. Replies are new rows, not edits. Comments don't change the Work or confer permission, settle a question, or unblock anything.
- Originals are silent unless `notifyManager: true`, which targets only the manager at commit. A reply targets the original author, even after reassignment. If the recipient is missing, ineligible or the author, the comment still saves with `not_queued`. Manager-directed pending notices expire when the manager changes; they neither follow the manager role nor revive if an old manager returns. Replies remain historical and are not retargeted.

`work_notes` and the existing `work_notifications` delivery ledger are separate Project SQLite tables. Comment and queued notice commit together. Notes are retained with their Work, without TTL, silent eviction, or a comment-count cap. Pre-existing attention is not imported; legacy attention and return notices stop being pending while existing history is retained. A notice links to the exact comment; it does not carry its Markdown body. `queued` is not delivered, read, accepted, or approved.

Read `v:works/keys/<encoded-key>/comments` for the latest ten by append order, follow `next` for older pages, or use `/comments/id/<id>` for an exact read. Comments are visible to Project Work readers, not private messages; broad discovery and Work overviews do not include their bodies. This slice has no Web comment composer.

SessionManager admits at most one Work wake marker per recipient. `next-step` uses safe input boundaries rather than aborting inference. Consumption revalidates pending facts against current routing and assignment/status/ancestor episodes, or exact comment relationships as applicable. Ordinary notice admission does not bypass the automatic kickoff inbox.

Facts remain pending if the responsible durable session is unavailable, retired, in explicit recovery or cannot admit input. Recovery is attempted on runtime startup, later Work changes and ordinary input admission; there is no polling or LLM retry loop. Temporary task/call executions are not reopened as coordinators. Issues remain visible in notes even without a usable coordinator; no human approval is synthesized.

A physical-log delivery stamp is saved before append. Settlement happens only after the combined notice is persisted. Recovery checks the stamped JSONL/SQLite physical logs (including older context segments) for the host notice receipt before redelivery; stopping a session clears only its in-memory marker reservation. This closes the append/settle crash window without replaying a completed handoff. Normal interrupted-turn recovery still applies: delivered history is not proof that the model completed its response. Delivery facts/receipts are retained; this change adds no garbage collector or cross-runtime distributed consumer lock.

## Retired Work execution channels

Current Work actions are `context/list/tree/create/update/assign/review/link`.
Versioned notebook update, assignment and ancestor reassessment use their dedicated
methods; the legacy generic `execute` mutation routes are removed. Work-specific
adoption, checkpoint, proposal approval/application/recovery, and fresh/successor
context lifecycles no longer execute. Ordinary `ask` decisions, task review,
conversation realignment and context clearing remain independent capabilities.

The current strict record schema/type has no `adoption`, `checkpoint`,
`transition`, `answerReview`, `handoffFrom`, `successors`, `proposals` or
`attention`. The existing storage adapter omits only the older execution keys
at database read boundaries, then validates current fields strictly. There is
no new compatibility adapter for `attention`: a current Work row carrying that
field is unsupported and fails validation without rewriting the row. Current
writes reject retired keys. Historical audit data remains historical, including
attention if it was recorded there. Effect and
persisted decision stamps omit only retired `adoptionId`; current stamp writes
remain strict. Existing stored JSON is not rewritten by this compatibility read.

A decision containing `workProposal` fails closed, including old pending or
settled records. It cannot be answered, applied, recovered, or silently converted
to an ordinary approval. Reading a decision-history segment containing such a
record explicitly errors rather than presenting a misleading ordinary question;
other segments remain separate. No startup proposal application or successor
creation remains. Resolving a goal change now requires a new ordinary decision
in its current context and an independently authorized notebook update.

Work `definition` is one non-empty Markdown string (at most 8,000 characters
once line endings and outer whitespace are normalized). Its prose may describe
an outcome, acceptance, boundaries and known source evidence; no headings are
required or interpreted programmatically. Prior structured Work definitions and
retired record fields are not supported or migrated. Attribution remains in
`origin`, `changedBy` and `changedAt`. Work fields are flat: `title`, `kind`,
`definition`, `summary`, `artifacts`, ancestry and dependency keys, `status`,
`blockedReason`, manager/assignee and assignment revision.
`basis` and the reassessment conclusion are maintained by the host. There is no `workflow` or `notes`
wrapper. A title-only edit advances the sequence, not the semantic revision.
Bot intake, automatic execution receipts and presentation observations remain
independent structured records. Completion/read receipts remain separate.
Overview wire data no longer exposes adoption/proposal/reinterpretation flags or
applied-proposal influence links; ordinary decision context/reference history is
retained. Work details display the Markdown definition as one document, separate from progress notes.

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

Writes use transactions and expected record sequences. A normalized definition
change advances the semantic revision; a routine report edit does not. Only the
human may semantically revise human-authored Work. A completion summary reports
an outcome through non-empty `summary`; Work does not generate a separate
result or evidence record from the definition. Work identities cannot
change during replacement. Parent/completion cycles and missing references are
rejected. Audit entries and assignment admission receipts persist with the Work. A keyed
creation stores its normalized-request fingerprint and Work key in a separate
Project SQLite receipt, in the same transaction as creation. There is no backfill.
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
Pending, in_progress and blocked all occupy the slot.
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
