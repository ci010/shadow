# Project conventions, decisions and memory

Each fact has one current owner:

| Fact | Owner |
| --- | --- |
| Stable personal preferences | The identified user's profile under Project memory; remember sources, distinguish observations from explicit statements, and correct superseded preferences |
| Project-wide practices | `project_conventions`, exposed through the `sql` tool |
| Temporary conversation presentation instructions | Session context and its continuation summary, not a separate convention store |
| Task goals, acceptance criteria, boundaries, assignment and progress | Work items, changed through `work` actions |
| Why a consequential choice was made and who answered | The persistent `ask` decision record; its result updates the appropriate owner above |

A decision is an interaction and an audit record, not another scope of
convention. Personal preferences do not override Project practices, task
requirements or permission boundaries. Project conventions are prompt context,
not an OS sandbox or permission grants. Resolve consequential conflicts
explicitly rather than silently selecting whichever instruction is newest.

## SQL tool

`sql({})` returns the current schema and mutation-source instructions. The
runtime supplies the Project and actor; neither can be selected through SQL
arguments. Data stays in Project Home even with a remote workdir.

| Table | Access |
| --- | --- |
| `project_conventions` | Query; guarded insert, update and delete |
| `convention_history` | Read-only append-only audit, including deleted records and source evidence |
| `work_items` | Read-only current Work projection, including parent, assignment, objective, acceptance and boundaries |
| `work_dependencies` | Read-only current Work dependency edges |

Work projections are temporary snapshots rebuilt from `InitiativeStore` for
each query, not another persistent task database. Convention records and audit
history live in `conventions.sqlite` inside the owning Project Home. Successful
tool mutations invalidate durable Session prompts for their next inference;
idle sessions do not need an artificial wakeup.

The initial dialect deliberately reuses the closed Initiative SQL parser:
single-table projections, literal comparisons joined by `AND`, sorting and
limits. It does **not** accept joins, aggregates, expressions, subqueries,
arbitrary SQLite statements, DDL, PRAGMA or filesystem database paths.
Input SQL is parsed and regenerated with validated identifiers and bound values,
never passed directly to SQLite.

```sql
SELECT id, text, revision FROM project_conventions ORDER BY id;
SELECT key, status, assignee FROM work_items WHERE status='blocked' LIMIT 20;
SELECT * FROM work_dependencies WHERE work_key='work:...';
SELECT * FROM convention_history WHERE convention_id='package-manager' ORDER BY id;
```

Queries default to 20 rows; use explicit limits up to 200 and ordered key/id
predicates to page. Each atomic batch is limited to 20 statements, 65536 SQL
bytes, 200 output rows and 262144 output bytes. Current conventions are limited
to 50 records and 16000 total text characters; each text is at most 1000
characters. Exceeding limits fails and rolls back, rather than silently omitting
rules from the prompt. Audit history has a 5000-record limit.

## Attributable changes

Read access follows the session's tool policy. Mutations additionally require a
direct Project-admin human turn in a durable session; delegated tasks, events
and inbound A2A agents cannot turn their observations into Project rules.
This is a tool boundary, not a universal filesystem sandbox.

For an explicit current instruction, copy its genuine source reference from
`ask({action:"context"})`, with an exact excerpt. For example, given the human
instruction `Use pnpm for this Project`:

```json
{
  "query": "INSERT INTO project_conventions (id,text) VALUES ('package-manager','Use pnpm for this Project')",
  "source": {
    "kind": "user",
    "sessionId": "<current session>",
    "physicalId": "<source input's physical segment>",
    "id": "<current human input ID>",
    "quote": "Use pnpm for this Project"
  }
}
```

The source must match the current recorded human input; compaction does not move
that input's original segment. Insert/update text must
equal the quote, not an agent paraphrase. This verifies authorship and prevents
invented rules, but does not mechanically prove that an arbitrary quote is
intended as a Project-wide policy. The agent must distinguish personal
preferences, temporary requests and project instructions. Clear instructions
need no second confirmation.

When a consequential choice is unresolved, use `ask(kind=decision)` with an
exact mutation option:

- `Add Project convention <id>: <text>`
- `Update Project convention <id> at revision <n>: <text>`
- `Remove Project convention <id> at revision <n>: <old text>`

Then supply `source: {kind:"decision", sessionId, physicalId, requestId}` from
the answer receipt. Only the exact human-selected option is accepted;
parent/timeout/custom answers, unclosed pending requests and invalidated
decisions cannot authorize it. Custom text is not approval of the offered
mutation. Do not reuse an answer for a different rule or revision.

Updates and deletes require `WHERE id='...' AND revision=n`. A conflict fails
the whole batch; reload before reconsidering the change. Delete preserves a
tombstone and audit record, and IDs cannot be recycled. Direct deletion also
requires the current human instruction; determining that it requests removal
remains an agent responsibility. Evidence is not a semantic authorization
oracle. Invalidating a historical decision does not automatically roll back an
already applied convention; resolve its current applicability explicitly.

## Legacy records and personal memory

`update_convention` is removed. The old
`memory/agent.conventions.md`, `memory/sessions/*.conventions.md` and
`memory/projects/*/conventions.md` files remain unchanged and readable through
memory discovery. They are no longer automatically injected as active rules,
nor automatically converted to Project conventions or user preferences:
their provenance and intended scope may be unknown.

Read relevant historical records when needed and revalidate before promoting a
rule. Newly confirmed Project conventions are shared by every session in that
Project. Switching Work or reassigning it does not create a second set of
session/initiative conventions.

Stable personal preferences use the existing identity/profile and learning
mechanisms, not a second preference table. Runtime profile guidance and
reflector instructions retain attribution, uncertainty and corrections.
Automatic extraction remains model-driven, and learning may be disabled; this
does not guarantee every preference has already been captured.
