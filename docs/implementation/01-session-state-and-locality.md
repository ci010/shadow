> **WIP design/workstream reference, not product readiness evidence.**
> Some persistence/locality slices are implemented; goals and acceptance
> criteria below are not a claim that all remote workflows are complete.
> See the [status/index](README.md) and [current architecture](../architecture.md).

# S1: Session State and Locality

> Owner: runtime core
>
> Depends on: S0
>
> Blocks: S2, S3 integration, S6 integration

## Goal

Make session persistence correct, then replace independently derived cwd values
with one node-aware locality model. Complete this locally before adding networking.

## Owned Modules

- `src/sessions/session-store.ts`
- `src/sessions/session-store-jsonl.ts`
- `src/sessions/session-store-sqlite.ts`
- `src/sessions/session-manager.ts`
- `src/sessions/base-session.ts`
- `src/utils/paths.ts`
- `src/agent/context/workspace.ts`
- `src/sessions/routes.ts`

Changes to `src/channels/web.ts` media paths require coordination with S7.
Changes to `src/tools/load-tool.ts` require coordination with S2.

## Deliverables

### 1. SessionState v2 persistence

- Round-trip every `SessionState` field in JSONL and SQLite.
- Add a schema version and runtime validation.
- Preserve unknown forward-compatible metadata where practical.
- Repair the current SQLite loss of parent, children, workspace ownership,
  report target, agent type, project, description, and preload tools.
- Add migration from existing SQLite `prototype` data.

Prefer one versioned metadata JSON field for low-frequency structural state over a
new SQLite column for every optional property. Keep indexed/listed fields as normal
columns.

### 2. Separate session data and workdir

Introduce resolved locations:

```ts
interface ResolvedSessionLocations {
  home: string
  sessionDataDir: string
  workdir: WorkdirRefV1
}
```

- `sessionDataDir` owns uploads and session-private artifacts.
- `workdir` selects the node capability used by project-facing tools.
- A local compatibility capability maps old managed session folders into the new
  model.
- Subagents inherit `WorkdirRef` unless explicitly assigned another capability.

### 3. One resolver

All of these must consume the same resolved result:

- execution context;
- workspace prompt;
- session file list/preview/static routes;
- uploads/media resolution;
- MCP startup locality;
- subagent creation;
- future executor dispatch.

Do not let route handlers reconstruct a directory from `sessionId`.

### 4. Explicit unavailable state

Resolution returns a typed unavailable result when node/capability is missing,
offline, revoked, or incompatible. It never silently maps to Home or another node.

### 5. API contract

Add read/update APIs for session workdir metadata with revision checking. The API
returns capability identity, display information, availability, and reason; it
does not disclose unrelated Child paths.

## Compatibility

- Existing sessions without `workdir` receive a deterministic local managed
  capability during migration/read normalization.
- Keep `workspaceRoot` readable during migration, but stop treating it as a path.
- Rename only after all readers use the new resolver; avoid a repository-wide
  rename in the first migration commit.

## Tests

1. JSONL and SQLite round-trip identical complete states.
2. Restart preserves parent/child/report/preload/workdir metadata.
3. Main session and nested subagents resolve the intended inherited workdir.
4. Prompt, shell context, file API, and media helpers report the same locations.
5. Uploads remain in session data when workdir points at a project.
6. Missing/revoked capability fails explicitly.
7. Legacy states normalize without changing their existing managed folder.
8. Concurrent stale workdir update returns conflict.

## Exit Criteria

- Local execution behavior is unchanged for migrated users.
- No production path except the central resolver derives session cwd directly.
- S2 can dispatch using only `WorkdirRef`, without reading SessionManager internals.
