> Historical implementation notes: automatic title/goal observation has been removed. Only independent organization and explicit session metadata remain active; observer references below describe retired behavior, not supported configuration or entrypoints.

# Fresh automation state/archive — original plan and audit inventory

Status: the future-only implementation is now present in the worktree for review. See [current persistence behavior](../fresh-automation-state.md) for the implemented APIs, storage layout, conservative settlement behavior and learning exclusion. The original proposal and caller inventory below are retained as design history, not a claim that every proposed mechanism was implemented verbatim. No production automation states have been converted, deleted or archived during development. Startup snapshot reuse and bounded JSON reads remain separate optimizations.

## User requirement and boundaries

- Future fresh-context automation executions use one stable state JSON per job, not one per execution. Existing historical state files remain untouched (human decision: `先实现后续每个 cron 一个 state，已有历史 state 暂不清理`).
- Every execution still receives a unique logical session/execution/run ID and distinct physical log history. A stable persistence slot is NOT a reusable Session, prompt, or conversation ID.
- Preserve context isolation, overlap handling, completion callbacks, deduplication, recovery, historical reads and statistics. Do not change startup timeouts or production runtime data during development.
- Do not aggregate every historical full state into an ever-growing JSON envelope. That reduces file count but preserves the startup parse/hydration problem.

## Source-backed mechanisms

- `src/cron/service.ts`: timer/manual admission enters `runOwned`; the service maintains pending/running execution and abort ownership. Keep its existing overlap rules.
- `src/cron/dispatch.ts`: `existing` mode emits into a durable target; `fresh` constructs `cron:<uuid>`, fresh automation metadata, and calls normal `SessionManager.startSession(mode: 'task', waitForCompletion: true)`. Post-completion status lookup currently assumes live memory.
- `src/runtime/main/project-runtime.ts`: observer uses `work-observer:<timestamp>` and organizer uses `work-organizer:<uuid>` through `startSession`, not CronDispatcher. Both carry `systemAutomationRef(..., contextMode: 'fresh')`. Organizer persists outcome in a `finally` AFTER execution completion. Observer consumes the execution receipt AFTER completion. These paths need explicit finalization barriers.
- `src/cron/contracts.ts`: automation metadata identifies the semantic fresh run and job; legacy inference is deliberately narrow. Do not use agent names or titles as a new persistence policy.
- There is no independent complete run-state ledger to reuse. `automation-usage.ts` delegates to persisted physical-log usage scanning; selecting those logs currently requires hydrated session states. Work/learning stores contain domain outcomes, not sufficient session identity/lifecycle/locality records.

## Proposed model and explicit eligibility

Add a versioned future-only state persistence policy, e.g. `statePersistence: { version: 1, kind: 'fresh-automation', jobId }` (final name to be reviewed). Apply at new session creation only when:

1. execution mode is `task`;
2. validated explicit automation metadata has `contextMode: 'fresh'` and a nonempty job ID;
3. the caller supplies the new policy through a supported lifecycle/finalization adapter.

No startup migration or heuristic retroactive tagging. `resolveAutomationSession()` legacy classifications must NOT opt old records into the new policy. Ordinary durable sessions, existing-session cron, calls and arbitrary tasks remain unchanged. Fresh user cron, supported learning cron, observer and organizer can share the policy once each consumer is archive-aware; do not imply all cron use it.

- JSONL selected store: one hashed/encoded, versioned per-job JSON document under the project sessions directory, containing active/unsettled runs keyed by unique session ID and at most one latest summary. Namespace must not collide with existing loose state files; validate that document's project/job identity.
- Finalized full run-state metadata: indexed project-local SQLite archive, one row per session ID, with project/job/run IDs, physical segment metadata, execution key, parent/child links, finalization revision and original full validated state. Index job+startedAt, sessionId, executionKey and parentSessionId. Existing JSONL/SQLite logs stay where they are.
- SQLite selected store: equivalent active/unsettled versus archive selection, ideally transactionally within its existing DB. A single file alone is not sufficient: startup must not select all completed archived rows.
- Default startup `listAllStates` (or a new explicitly named startup API) includes old loose rows plus new active/unsettled rows, never all new archived completed rows. Old historical files still impose their preexisting cost by explicit requirement.

## Archive eligibility and finalization ordering

Terminal executionStatus alone is NOT sufficient. All of the following must hold:

- New persistence policy present; immutable project/job/run/session identity validated.
- Execution has reached completed/failed/cancelled, with final receipt/log writes durably settled and no active Session, inference, tool, owned execution, pending write, or startup-recovery operation.
- No pending completion delivery: absent reportTo, or persisted completionReported acknowledgement. Preserve the current distinction between report emission and acknowledgement; do not mark delivery complete just to permit archiving.
- Caller-specific finalization is durably recorded: CronDispatcher has consumed status; organizer has saved outcome/problem; observer has consumed receipt; learning batch/proposal bookkeeping has settled. Recoverable interrupted finalization stays active, not discarded.
- No unresolved child/callback/decision/report requires live state lookup. Either settle it or first convert that dependency to archive-aware historical lookup. Pending reports are bounded by unsettled work, not necessarily by running concurrency; never force a cap that loses delivery.

Use a per-job serialized update / revision-CAS so finishing an older overlapping run removes ONLY that run, never a newer run's state. Maintain independent run IDs. Archive-first, remove-pointer-second: commit indexed archive row, then atomically replace JSON pointer. On a crash between those actions, the run exists in both; reconcile idempotently by immutable identity+revision, with live/unsettled state winning until finalization is proven. On archive failure retain live state. Never replay the provider execution to repair metadata. A stale completion write must not recreate an active entry or overwrite another run; reject/update the correct archive revision instead.

## APIs to introduce, not a synchronous fallback trap

Keep `getSessionState()` and live admission maps explicitly live-only. Do NOT use blocking filesystem reads in a Proxy and do NOT insert archived records into `sessionStates` when queried.

Proposed asynchronous APIs:

- `readSessionState(id, { includeArchived: true })` for read-only history/metadata, returning provenance/live/archive distinction.
- `querySessionHistoryStates({ projectId, jobId?, parentId?, window?, offset, limit })` and indexed counts/features, merging legacy live records with archive records without double counting.
- `findExecutionByKey(key)` across live and archive; `executeOnce` must await this before invoking operation.
- Explicit archival/finalization API with a durable phase marker; generic `saveState` is not enough to signal all caller side effects have finished.
- History/result/profile/evidence readers accept a resolved historical state (and exact physical identity) instead of consulting live-only maps internally.

Read authorization must validate the archived state's project and preserved locality/lineage. Archived existence must never grant message admission, tool access, execution continuation or cancellation as an active run. Ownership reservation currently scans both stores: add an indexed archive ownership/remote-workdir check or durable catalog claims without reading every archived full state. Do not silently drop ownership protection just because archived runs no longer appear in startup states.

## Caller audit and required adaptations

The exact non-test direct-call inventory is appended below. `await getSessionState()` in existing code does not make the method archive-aware; it is still a synchronous memory lookup. Store list methods in the inventory are async already and must preserve public semantics or split startup/history APIs explicitly.

### Historical read paths — must become archive-aware

- `sessions/routes.ts`: project-scoped existence middleware, metadata/details/history/segments, execution result, profile and session listings. Separate mutation/admission endpoints from historical reads; a blanket archive-exists check is unsafe.
- `vfs/mounts.ts`: session listing, brief/details/history/physical references and automation feature enumeration; `vfs/stats.ts`: feature discovery/statistics.
- `cron/routes.ts`: records/summaries/runs, pagination and totals; `cron/profile.ts`: feature IDs, date-window counts and usage, including deleted jobs with retained history.
- `sessions/profile.ts` and manager `getProfileUsage`/`getAutomationUsage`: include archive rows and child lineage without full startup hydration; preserve scan limits and unknown usage semantics.
- Manager `getFirstUserMessage`, `getExecutionResult`, logical/shallow `getHistory`, `getSessionDetails` and other metadata readers: resolve explicit historical state. Physical-log reads must remain project-fenced.
- `sessions/execution-scope.ts`, `tools/cancel.ts` and background-task HTTP existence checks: distinguish historical owned execution result/cancel receipt from live control. Completed archive lookup is valid; revival is not.

### Lifecycle consumers — explicit finalization and recovery adaptation

- `cron/dispatch.ts` post-run status; runtime observer/organizer callbacks; `agent/learning/pipelines.ts` completion recovery/proposal handling. Their current post-completion queries can race eager archiving.
- Manager `executeOnce` and `executionReceipt`: archived execution-key lookup prevents duplicate side effects after restart.
- Manager `start`, `reportCompletion`, `completionEvents`, execution end writes, unload/stop and restart cancellation: maintain durable pending finalization/report records until safe archival. `completionReported` must retain its existing acknowledgement semantics.
- Manager child lineage cleanup/deletion and historyConflict: do not prune valid archived child references or infer missing parents merely from absence in live memory. User deletion, if supported for archived records, is a separate explicit operation, not part of this migration.
- Runtime folder deletion/remote-workdir reservations: historical archives retain relevant references; use indexed checks instead of silently omitting those claims.

### Live-only by default — do not widen to archive admission

- `a2a/runtime.ts`, `tools/subagent.ts`, `tools/cron.ts`, `sessions/topics.ts`, channel delivery/integration policy resolution and Work alignment mutation paths require a live eligible owner/target. Preserve that restriction. Review any display/history branch separately.
- `channels/web.ts` mixes live messaging/mutation with history-facing details; review endpoint by endpoint. `channels/discord.ts`, `channels/feishu.ts` mainly resolve active channel identities; eligibility must not affect durable channel sessions.
- `projects/work-routes.ts` and runtime Work/topic listings: determine which historical presentation views promise completed execution evidence, and use history queries only there. Keep actual controllers and session creation bound to live durable owners.
- `slash-commands/handlers/status.ts`: command source is live; no reason to rehydrate archived executions.

The inventory below is exact for direct named calls at this handoff; indirect callbacks (`state`, `getState`, `listStates`, YieldRecords, alignment, learning and background-task adapters) and manager's direct `sessionStates[...]` reads must also be reviewed in the implementation pass. It is NOT a proof that a search/replace of the listed calls completes the change.

## Required implementation tests / acceptance gates

Both persistence formats, synthetic project-local fixtures only:

1. Several sequential eligible runs: one stable job state JSON; distinct session/run/execution/physical IDs; no previous run user/system prompt context. Ordinary existing cron and ordinary sessions unchanged.
2. Overlapping runs: independent active entries and logs; out-of-order completion and stale writes cannot replace newer run state. Existing service overlap admission unchanged.
3. Final receipt/report failure, cancellation, restart, organizer post-run outcome and learning recovery: unsettled entries survive; no lost callback, no duplicate provider run. Archive crash points before/after commit and before/after pointer replacement recover idempotently.
4. Archived session read by ID, physical/logical segments, virtual refs, routes, profile/statistics, child usage, deleted-job summaries and pagination match old behavior; query never inserts archived state in live maps.
5. Same executionKey after restart returns archived receipt, never reruns; archived ID cannot be messaged/resumed as live.
6. Old loose JSON and old SQLite state remain byte-preserved/readable; no migration/delete on startup. Corrupt/foreign/version-invalid archive records fail closed.
7. Ownership and remote-workdir checks cover archive references without replaying logs or selecting all state blobs on boot.
8. Increase settled run count by orders of magnitude: startup reads/state hydration bounded by jobs+active/unsettled runs, not completed new run count. Archive queries may scale with requested history, not startup.

## First two changes validation at handoff

`startup-state-snapshot.ts` scopes immutable copies to initial boot; host consumes each project snapshot once, retries rescan; store mutations permanently end reuse; agent-start completion/failure releases the cache. JSONL metadata reads use an eight-worker pool and apply I/O/validation errors in original directory order. Logs are not scanned by these changes.

Focused synthetic count result: host reservation + selected project ownership + manager load require one underlying list per format instead of three selected-format scans. Pool fixture reached exactly eight active readers and drained all workers before returning/errors. These are operation-count/concurrency measurements, not a production startup latency claim. No host restart or benchmark against production state was performed.

## Direct-call inventory (source line numbers at handoff)

```text
src/a2a/runtime.ts:20:      if (!sessions.getSessionState(record.sessionId)) {
src/a2a/runtime.ts:25:      const state = sessions.getSessionState(record.sessionId)
src/a2a/runtime.ts:98:      if (!sessions.getSessionState(call.owner)) throw new Error('The owning A2A session no longer exists.')
src/a2a/runtime.ts:108:    const state = sessions.getSessionState(context.sessionId)
src/agent/learning/pipelines.ts:70:      if (batch.sources.some(source => !isLearningSourceEligible(this.sessions.getSessionState(source.sessionId),
src/agent/learning/pipelines.ts:71:        id => this.sessions.getSessionState(id), id => this.sessions.isManagedConversation(id), this.projectId))) {
src/agent/learning/pipelines.ts:77:      if (this.sessions.getSessionState(sessionId)?.executionStatus === 'completed' && batch.proposal) {
src/agent/learning/pipelines.ts:95:    for (const row of this.sessions.listSessions()) {
src/agent/learning/pipelines.ts:97:      const state = this.sessions.getSessionState(row.sessionId)
src/agent/learning/pipelines.ts:98:      if (!state || !isLearningSourceEligible(state, id => this.sessions.getSessionState(id),
src/agent/learning/pipelines.ts:128:      const state = this.sessions.getSessionState(sessionId)
src/agent/learning/pipelines.ts:237:      if (batch.sources.some(source => !isLearningSourceEligible(this.sessions.getSessionState(source.sessionId),
src/agent/learning/pipelines.ts:238:        id => this.sessions.getSessionState(id), id => this.sessions.isManagedConversation(id), this.projectId))) {
src/channels/discord.ts:984:      const state = await this.sessionManager?.getSessionState(sessionId)
src/channels/feishu.ts:613:    const state = this.sessionManager?.getSessionState(this.logicalSessionId(rootId))
src/channels/feishu.ts:628:    const state = this.sessionManager?.getSessionState(sessionId)
src/channels/integration-routes.ts:56:              sessions: options.sessions.listSessions().flatMap(row => {
src/channels/integration-routes.ts:57:                const scope = options.sessions.getSessionState(row.sessionId)?.channelBoundary
src/channels/integration.ts:52:      ...this.sessions?.listSessions().flatMap(row => {
src/channels/integration.ts:53:        const scope = this.sessions?.getSessionState(row.sessionId)?.channelBoundary
src/channels/integration.ts:89:    const state = this.sessions?.getSessionState(sessionId)
src/channels/integration.ts:91:      const owner = this.sessions?.getSessionState(state.channelBoundary.ownerSessionId)
src/channels/integration.ts:107:    return !!this.sessions?.getSessionState(sessionId)?.channelBoundary || !!this.address(sessionId) || sessionId.startsWith('discord:') ||
src/channels/integration.ts:130:    let location = this.locations.get(sessionId) ?? this.sessions?.getSessionState(sessionId)?.channelBoundary?.location
src/channels/integration.ts:270:    return this.sessions?.listSessions().flatMap(row => {
src/channels/integration.ts:271:      const state = this.sessions?.getSessionState(row.sessionId)
src/channels/integration.ts:293:      if (this.sessions?.getSessionState(sessionId)?.channelBoundary?.epoch !== scope.epoch ||
src/channels/integration.ts:297:      if (this.sessions?.getSessionState(sessionId)?.channelBoundary?.learningInputId !== scope.learningInputId ||
src/channels/integration.ts:298:        this.sessions?.getSessionState(sessionId)?.executionStatus === 'running') {
src/channels/integration.ts:650:      const access = this.access(this.resolve(sessionId)!, sessionId, this.sessions?.getSessionState(sessionId) ?? undefined)
src/channels/integration.ts:664:    const state = this.sessions?.getSessionState(sessionId)
src/channels/integration.ts:688:      if (this.sessions?.getSessionState(stamp.access.sessionId)?.channelBoundary?.epoch !== stamp.access.epoch ||
src/channels/web.ts:190:        const state = this.sessionManager?.getSessionState(sessionId)
src/channels/web.ts:196:          ? this.sessionManager?.getSessionState(parentSessionId)
src/channels/web.ts:254:      const state = sessionId ? this.sessionManager?.getSessionState(sessionId) : null
src/channels/web.ts:394:      const state = await this.sessionManager?.getSessionState(sessionId)
src/channels/web.ts:459:        const decisionRecords = this.sessionManager!.getSessionState(sessionId)
src/channels/web.ts:480:      const existingState = this.sessionManager?.getSessionState(sessionId)
src/cron/dispatch.ts:24:    if (job.originSessionId && !this.sessions.getSessionState(job.originSessionId)) {
src/cron/dispatch.ts:48:      const status = this.sessions.getSessionState(started)?.executionStatus
src/cron/profile.ts:13:    for (const row of this.sessions.listSessions()) {
src/cron/profile.ts:14:      const state = this.sessions.getSessionState(row.sessionId)
src/cron/profile.ts:22:    const records = this.sessions.listSessions().flatMap(row => {
src/cron/profile.ts:23:      const state = this.sessions.getSessionState(row.sessionId)
src/cron/routes.ts:20:  const records = () => sessions.listSessions().flatMap(row => {
src/cron/routes.ts:21:    const state = sessions.getSessionState(row.sessionId)
src/projects/work-routes.ts:39:  const states = sessions.listSessions().filter(state => state.agentType !== 'work-organizer' && state.agentType !== 'work-observer')
src/projects/work-routes.ts:65:      const full = sessions.getSessionState(state.sessionId)
src/projects/work-routes.ts:135:      const state = sessionId ? sessions.getSessionState(sessionId) : null
src/runtime/main/project-runtime.ts:319:    return sessions.listSessions().some(session => {
src/runtime/main/project-runtime.ts:320:      const workdir = sessions.getSessionState(session.sessionId)?.workdir
src/runtime/main/project-runtime.ts:494:    const state = sessions.getSessionState(id)
src/runtime/main/project-runtime.ts:575:    const state = sessions.getSessionState(sessionId)
src/runtime/main/project-runtime.ts:676:    sessionExists: id => sessions.getSessionState(id) !== null,
src/runtime/main/project-runtime.ts:679:        if (!sessions.getSessionState(fact.sessionId)) cancel(fact.sessionId)
src/runtime/main/project-runtime.ts:689:      const state = sessions.getSessionState(sessionId)
src/runtime/main/project-runtime.ts:698:    isSessionKnown: id => sessions.getSessionState(id) !== null,
src/runtime/main/project-runtime.ts:700:      if (sessions.getSessionState(id)?.recovery) return false
src/runtime/main/project-runtime.ts:713:    listStates: async () => (await sessions.listSessions())
src/runtime/main/project-runtime.ts:714:      .flatMap(entry => { const state = sessions.getSessionState(entry.sessionId); return state ? [state] : [] }),
src/runtime/main/project-runtime.ts:722:    state: id => sessions.getSessionState(id),
src/runtime/main/project-runtime.ts:732:      const source = sessions.getSessionState(id)
src/runtime/main/project-runtime.ts:739:        const existing = sessions.getSessionState(successorId)
src/runtime/main/project-runtime.ts:773:    activity:id=>sessions.getSessionState(id)?.lastActivityAt??'', physical:id=>{const state=sessions.getSessionState(id);return state?physicalSessionId(state):undefined}, changed:()=>realtime.invalidateSessions()})
src/runtime/main/project-runtime.ts:792:    bus, scope, state: id => sessions.getSessionState(id),
src/runtime/main/project-runtime.ts:816:      const state = sessions.getSessionState(id)
src/runtime/main/project-runtime.ts:857:    (sid) => sessions.getSessionState(sid)?.initiativeId ?? undefined,
src/runtime/main/project-runtime.ts:976:      conversations: sessions.listSessions().map(session => ({
src/runtime/main/project-runtime.ts:978:        inferenceOverrides: inferenceSettings(sessions.getSessionState(session.sessionId)?.config),
src/runtime/main/project-runtime.ts:1010:    const state = sessions.getSessionState(id)
src/runtime/main/project-runtime.ts:1107:      (parentId) => sessions.getSessionState(parentId)?.children,
src/runtime/main/project-runtime.ts:1209:    const state = sessions.getSessionState(sessionId)
src/runtime/main/project-runtime.ts:1210:    return (!isLearningSourceEligible(state, id => sessions.getSessionState(id),
src/runtime/main/project-runtime.ts:1257:      const existing = sessions.getSessionState(sessionId)
src/runtime/main/project-runtime.ts:1303:      getState: id => sessions.getSessionState(id),
src/runtime/main/project-runtime.ts:1315:    backgroundTasksPlugin(backgroundTasks, id => !!sessions.getSessionState(id)),
src/sessions/bounded-session.ts:46:  async listSessions() { return structuredClone([...this.states.values()]) }
src/sessions/execution-scope.ts:11:  const owner = sessions.getSessionState(context.sessionId)
src/sessions/execution-scope.ts:20:  const state = sessions.getSessionState(executionId)
src/sessions/profile.ts:15:    const state = this.sessions.getSessionState(sessionId)
src/sessions/profile.ts:24:    const ids = this.sessions.listSessions().filter(row => this.sessions.getSessionState(row.sessionId)?.projectId === this.projectId).map(row => row.sessionId)
src/sessions/routes.ts:134:  const state = sessions.getSessionState(key)
src/sessions/routes.ts:146:    const ancestorState = sessions.getSessionState(ancestor)
src/sessions/routes.ts:202:      if (sessions?.projectId && !sessions.getSessionState(c.req.param('key') ?? '')) {
src/sessions/routes.ts:238:      const list = (await sessions.listSessions()).filter(session => session.agentType !== 'work-observer')
src/sessions/routes.ts:246:      const list = (await sessions.listSessions()).filter(session => session.agentType !== 'work-observer')
src/sessions/routes.ts:266:        const state = sessions.getSessionState(session.sessionId)
src/sessions/routes.ts:356:      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
src/sessions/routes.ts:377:      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
src/sessions/routes.ts:400:      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
src/sessions/routes.ts:407:      if (!sessions.getSessionState(id)) return c.json({ error: 'session_not_found' }, 404)
src/sessions/routes.ts:415:      if (!sessions.getSessionState(id)) return c.json({ error: 'session_not_found' }, 404)
src/sessions/routes.ts:541:      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
src/sessions/routes.ts:549:        const state = sessions.getSessionState(key)!
src/sessions/routes.ts:609:      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
src/sessions/routes.ts:631:      const state = await sessions.getSessionState(key)
src/sessions/routes.ts:668:          if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
src/sessions/routes.ts:898:      const list = await sessions.listSessions()
src/sessions/routes.ts:928:      const state = await sessions.getSessionState(key)
src/sessions/routes.ts:940:      const state = sessions.getSessionState(key)
src/sessions/routes.ts:968:      const chain = await sessions.listSessions()
src/sessions/routes.ts:977:        const state = sessions.getSessionState(key)
src/sessions/routes.ts:1011:          const state = sessions.getSessionState(item.sessionId)
src/sessions/session-store-jsonl.ts:88:  async listSessions(): Promise<
src/sessions/session-store-sqlite.ts:418:  async listSessions(): Promise<
src/sessions/session-store.ts:225:  listSessions(): Promise<
src/sessions/topics.ts:90:    const state = this.options.sessions.getSessionState(sessionId)
src/sessions/topics.ts:102:      const existing = this.options.sessions.getSessionState(ORCHESTRATOR_SESSION_ID)
src/sessions/topics.ts:166:        if (this.options.sessions.getSessionState(sessionId)) {
src/sessions/topics.ts:213:    const state = this.options.sessions.getSessionState(sessionId)
src/sessions/topics.ts:236:    const state = this.options.sessions.getSessionState(sessionId)
src/sessions/topics.ts:242:    const state = this.options.sessions.getSessionState(sessionId)
src/slash-commands/handlers/status.ts:13:      const state = await sessions.getSessionState(ctx.sessionId)
src/tools/cancel.ts:51:    const status = this.sessions.getSessionState(executionId)?.executionStatus
src/tools/cron.ts:77:    const origin = mode === 'fresh' ? this.sessions?.getSessionState(context.sessionId) : undefined
src/tools/cron.ts:90:      const source = this.sessions.getSessionState(context.sessionId)
src/tools/subagent.ts:96:    const parentState = this.sessions.getSessionState(ctx.sessionId)
src/vfs/mounts.ts:96:      const allList = await sessions.listSessions()
src/vfs/mounts.ts:105:        const state = await sessions.getSessionState(s.sessionId)
src/vfs/mounts.ts:139:      : (await sessions.getSessionState(sessionKey))
src/vfs/mounts.ts:154:      const sessionState = await sessions.getSessionState(sessionKey)
src/vfs/mounts.ts:215:    const all = await sessions.listSessions()
src/vfs/mounts.ts:250:      const state = await sessions.getSessionState(s.sessionId)
src/vfs/mounts.ts:304:    for (const state of sessions.listSessions()) {
src/vfs/stats.ts:15:    const rows = sessions.listSessions().filter(row => sessions.getSessionState(row.sessionId)?.projectId === profiles.projectId)
src/vfs/stats.ts:17:    for (const row of rows) { const state = sessions.getSessionState(row.sessionId); const automation = state && resolveAutomationSession(state); if (automation) ids.add(automation.jobId) }
```

## Validation commands and remaining failures

Successful focused command (21/21):

```sh
pnpm exec node --import tsx --test src/sessions/startup-state-snapshot_test.ts src/sessions/state-read-pool_test.ts src/projects/session-ownership_test.ts src/projects/ownership_test.ts src/sessions/session-store-sqlite_test.ts
pnpm typecheck
pnpm build
```

Expanded regression command (26/32; six failures):

```sh
pnpm exec node --import tsx --test src/sessions/startup-state-snapshot_test.ts src/sessions/state-read-pool_test.ts src/projects/session-ownership_test.ts src/projects/ownership_test.ts src/folders/remote-ownership_test.ts src/sessions/managed-remote-session_test.ts src/sessions/session-store-sqlite_test.ts
```

- `remote-ownership_test.ts:92`, both stores: `AssertionError: Missing expected exception`, expected `{ code: 'folder_access_revoked' }`.
- `remote-ownership_test.ts:264`, both stores: `AssertionError: Missing expected rejection`, expected `{ code: 'folder_owned_by_another_project' }`.
- Source-identified cause of those four: fixtures at lines 77 and 254 write `join(f.workspace, '.sessions')`; the already-existing reservation code resolves `projectStoragePath(home, '.sessions')`, which `utils/data-paths.ts` maps to `home/state/sessions`. Thus reservation returns on missing canonical directory instead of seeing those fixtures. This mismatch is present in the pre-task source, not introduced by snapshot reuse or parallel reads. No isolated baseline rerun was performed; no unrelated ownership repair was made.
- `managed-remote-session_test.ts`, both stores: `Error: WebSocket failed before opening` at `cluster/websocket-node-transport.ts:394`. Environment/baseline cause unconfirmed. These disposable transport fixtures were stopped by the tests; no production host was restarted or killed.

The snapshot only reuses `listAllStates` results. `getState` keeps its existing per-record key/validation behavior; it is deliberately not substituted from a bulk-read cache. This avoids treating distinct validation paths as interchangeable.
