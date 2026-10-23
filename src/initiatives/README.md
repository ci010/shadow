# Initiative storage contract

> **Current runtime: unified work (database version 6).** `work` is the public
> mutation interface for definitions, assignment, progress and dependencies.
> `work_contracts` stores complete work items; `work tree` derives Initiative
> views from a root and descendants. New databases initialize directly at the
> current schema. Historical imports and schema upgrades are no longer run at
> startup. Existing keys, journals and archive tables remain readable; no new
> Topic contracts are created. The SQL API described below is retained for
> archive reads and historical fixtures, not as a second live authority.

Version 5 remains supported for direct historical Initiative API callers and SQL
contract fixtures; it is not upgraded or imported at startup. New Project runtimes
initialize version 6, whose Initiative SQL tables are read-only archives. Earlier
schema versions are rejected instead of silently upgraded.

The public `sql` tool separately exposes read-only current `work_items` and
`work_dependencies` projections plus guarded Project conventions. It does not
reactivate this legacy SQL mutation API. See
[Project conventions](../../docs/project-conventions.md) for its schema and
authority boundaries.

An `InitiativeStore` owns **one Project Home's** `initiatives.sqlite`. It is not a
shared runtime database. Construct one per Project runtime, pass its actual
session-liveness callback, and call `close()` during runtime disposal. Never pass
an actor supplied by model arguments: `query(sql, actorSessionId, signal?)` requires
the calling session ID from the execution context.

The synchronous API returns `{ results: [{ rows, changes }], changes }`, with one
result per statement. SQLite changes exclude automatically generated audit rows.
All statements in a call commit together or roll back together. A guarded claim
that no longer matches returns zero changes. `getSummary(id, sessionId?)` returns
bounded Markdown or `null`. `getSessionSummary(actorSessionId)` includes at most
five active initiatives (32 KiB output) explicitly owned or created by that actor,
or containing items assigned to it; unrelated visible initiatives are never
included. No related active initiatives returns `null`.
`INITIATIVE_SCHEMA_PROMPT` describes the model-facing
schema, access rules, and supported SQL grammar.

## Deliberately constrained SQL

This is **not** a general SQLite executor. A tokenizer and closed parser accept
single-table projections, literal comparisons joined by `AND`, ordering, limits,
and single-row `INSERT` / filtered `UPDATE` / dependency-edge `DELETE`. The store
generates parameterized SQL from validated identifiers and values. User SQL is
never submitted to SQLite. No expressions, joins, recursive queries, comments,
DDL, PRAGMA, attached databases, or SQL extensions are accepted.

An additional `node:sqlite` engine authorizer denies other operations, databases,
tables, and functions. `setAuthorizer` was added in Node 24.10, before the project's
24.15 minimum; it was also verified on Node 24.18. Initialization fails closed if
it is unavailable. No dependency, extension, regex-only SQL filter, or compatibility
runtime is used.

Limits: 64 KiB query and normal text fields, 4,096 tokens, 20 statements,
200 affected and 200 returned rows per query, 256 KiB returned JSON, 5,000 records
per base table, and 16 MiB total serialized record content. Generated audit entries
have a larger field ceiling to retain before/after records. Reads default to a
200-row limit; callers narrow their predicates when retrieving more data. There
is no unbounded join/recursive/expression execution path. SQLite lock wait is
bounded to one second. Abort is checked before acquisition, between statements,
and before commit; synchronous SQLite work cannot react to a newly dispatched
JavaScript event midway through a statement. Use the closed grammar/storage
bounds, not abort alone, as the execution-work bound.

## Ownership and lifecycle

Creator and initial owner are always the real actor. Audit author and entry
author cannot be supplied or updated through SQL. Entries are append-only;
initiatives/items are cancelled rather than deleted. IDs, parent references,
timestamps, and revisions are system-managed after creation.

Owners manage initiative structure and unassigned work. Assignees manage their
own execution state. Existing active **or unknown** assignments cannot be stolen,
including by the initiative owner. A change of owner/assignee requires an equality
guard on its previous value (or revision). Known inactive assignments permit an
explicit claim, not automatic completion or reassignment.

`isSessionActive(id)` must return `false` only for a known inactive session;
`undefined` means unknown and fails closed. `initiative_handoffs` and summaries
surface an active initiative whose owner is known inactive or absent. Reads do
not mutate lifecycle state. Runtime code owns that callback and session lifecycle;
this storage package neither polls sessions nor invents session status.

Supply `isSessionKnown(id)` to validate that new owner/assignee targets belong to
this Project runtime. Initial initiative ownership, delegated assignments, claims,
and handoffs reject unknown targets when that callback is present. Existing stored
owners/assignees are not revalidated against membership on reads: deleted sessions
retain history and can surface inactive handoffs. Null/unassigned targets are unaffected. Omitting this optional callback preserves standalone use;
runtime integrations should supply it in addition to `isSessionActive`.

`initiative_item_activity` is read-only and exposes the item fields plus
`assignee_activity` (`active`, `inactive`, `unknown`, or `unassigned`) and
`needs_handoff` (1 for a nonterminal item assigned to a known inactive session).
Both summary methods display these indicators. A coordinator's session summary
also lists stopped assignments even when the coordinator itself remains active.
No activity read changes item status, assignee, revision, or audit history.

Completion requires every item to be `done` or `cancelled`. Every dependency of
a done item must itself be done; a cancelled prerequisite does not satisfy
completed work. Cancelled items impose no dependency requirement. These checks
cover transaction commit and database reopen, so invalid completed records fail
explicitly instead of being silently repaired.

## Verification

Historical Markdown imports and Work unification have been retired after migration
of existing applications. Runtime startup does not scan or modify old folders.
Previously imported Markdown entries, audit records and Work journals remain
readable in the database; this cleanup does not delete user archives.

Run focused verification:

```powershell
pnpm exec node --import tsx --test src\initiatives\store_test.ts src\sessions\work-items_test.ts
```
