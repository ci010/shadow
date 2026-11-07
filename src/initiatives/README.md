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
