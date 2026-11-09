# Work storage contract

Work is an optional shared notebook. Conversations and execution do not require
Work records. Current mutations go through the `work` tool and `WorkAlignment`;
SQL projections are read-only. Note completion, execution activity and human
acceptance remain separate facts.

## Storage

`InitiativeStore` is an internal implementation name. It owns one Project Home's
`state/initiatives.sqlite`, independently of JSONL/SQLite session storage. This
filename and the `src/initiatives/` directory still hold current Work data and
must not be deleted merely because of their names.

Version 6 stores complete records in `work_contracts`, audit events in
`work_contract_events`, effect references in `work_effects`, execution focus in
`work_focus`, and historical conversation associations in `work_session_links`.
Presentation observations and snapshots remain in `work_observations` and
`project_focus_summary`. Existing current record keys are immutable, including
keys whose persisted prefix is `initiative:`, `item:` or `topic:`.

New databases create only current Work tables. Current version-6 files may
contain unused historical tables; they are not read, imported or deleted.
Version-5 and other unsupported databases fail explicitly before schema changes
or WAL configuration. The runtime does not migrate, replace or remove their
records. Preserve the file and resolve the storage choice explicitly.

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
