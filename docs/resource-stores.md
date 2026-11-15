# Resource stores and synchronization

The first-party Vue app uses app-scoped Pinia modules over a shared resource engine.
This is a direct refactor, not a feature-flag rollout. There is no legacy/new owner
switch and no production shadow reader. HTTP/domain protocols remain specialized.
A store does not authorize requests or make an endpoint support delta automatically.

## Ownership

```text
HTTP/domain adapter -> Resource engine -> readonly reactive view -> Pinia module -> consumers
LiveClient -> invalidation/readiness -> same resource engine
Command API -> confirmed result / scoped invalidation -> resource
```

- `app/src/resources/engine.ts` is framework independent: scheduling, generations,
  timeout, coalescing, candidate validation, publication and registry leases.
- `app/src/resources/vue-resource.ts` bridges engine publications to readonly Vue
  refs. It does not keep a second mutable authoritative data copy.
- `app/src/stores/` owns app-scoped module instances. `createResourceApp()` installs
  a fresh Pinia for each root, including mobile, Child, authentication and recovery.
- Pinia disposal releases the transport, active reads, subscriptions and caches.
  Browser authentication and mobile connection changes unmount the previous root.
  Current module keys use auth generation 0 **within that root**; they must never be
  moved into a cross-login singleton. The engine key API also supports explicit
  auth generations for independently managed scopes.
- An explicitly provided `liveTransportKey` can substitute a transport for an
  embedded root/test. Its provider owns disposal. This is dependency injection,
  not another server-state cache. Default app transport is owned by Pinia.

## Scope and commit

`canonicalResourceKey()` includes host, auth generation, Project, resource,
projection, optional entity and canonical query. Object keys are sorted; business
array order is preserved. Never put credentials or token values in a key.

A resource has local `revision` (value identity changes), `readRevision` (read
attempts), `generation` (cancellation boundary) and optional wire `version`.
A LiveClient replay cursor and a command concurrency revision are separate.

Each read:

1. Captures generation and AbortSignal; only one flight owns this resource.
2. Uses its domain adapter to decode/validate snapshot, delta or conditional data.
3. Builds/reconciles the candidate and validates it before publication.
4. Publishes value and optional adapter version in one frozen state object.
5. Ignores replies after abort, reset, disposal or generation changes.

`ResourceOptions.version` supplies an already validated adapter version. Work
publishes snapshot-v1 version this way. Adapters keep private wire bases; those
are not an independently visible store. Unversioned endpoints may have no wire
version and still use the same ownership/commit path.

`ResetRequired`/`ResourceValidationError` can trigger one recovery read when an
explicit recovery callback is provided. Arbitrary network errors are not base
errors. 401/403 clear the visible protected value and version. Reads never replay
commands. Existing HTTP adapters propagate status so the engine can distinguish
protected failures from transient errors.

A confirmed command can `commit()` a projection through its active view lease.
This publishes the confirmed result, cancels reads captured before the command,
and reconciles in a new generation without replaying the command. Knowledge uses
this path to remove a confirmed-deleted entry and its outgoing edges from every
catalog consumer. Incoming references remain explicit, and a failed reconciliation
cannot resurrect the deleted detail. Released leases cannot commit.

`read()` joins an existing flight. Explicit `refresh()` and `invalidate()` record
new information during a flight and schedule at most one follow-up; they never
start an overlapping read. This matters when a folder revision or a user refresh
arrives after an older response was captured. The `createSnapshot()` compatibility
bridge uses the same refresh-as-invalidation contract and has no independent scheduler.

Snapshot-v1 empty deltas reuse the previously validated result without cloning or
parsing the entire body again. Workflow preserves domain structural sharing.
Do not deep-clone/tokenize all chat images just to fit a generic store.

## Leases, visibility and budgets

`resourceViews.acquire(key, load, options, activate)` returns readonly state and
read/refresh/invalidate/release operations. `activate` runs once for the first
consumer and returns subscription cleanup. Consumer release is idempotent; only
last release pauses/disposes the shared resource. Consumers cannot call a shared
resource's pause directly and cancel another consumer's flight.

Inactive registry retention defaults to 30 seconds, at most 32 entries and 16 MiB
serialized UTF-8. Module views normally retain zero inactive entries; Workflow
and immutable revision-scoped Knowledge details each retain at most 16. Knowledge
reuses successful detail projections when returning to a page; failed details
retry on reacquisition. Catalogs still have no inactive retention. Byte measurement occurs only when an entry is actually retained,
not on each active update; it is not a measurement of JS heap. Active demand is not
evicted by inactive limits. Registry disposal clears all owned engine state.

Chat uses specialized bounded wire caches instead: 8 MiB each for direct and
read-only history, at most two inactive host/Project/auth scopes (32 MiB inactive
combined). Active flights use a zero-retention registry. Cache budgets are not a
claim about peak decode memory, and active scopes can require additional memory.

`useCatalogVisibility()` combines active prop, document visibility and KeepAlive
activation. KeepAlive is not evidence that a reader is still needed. Healthy live
connections have no generic polling; disconnected fallback is active-only.
Workflow has no corresponding invalidation topic and retains an explicitly shared,
active-only 30-second reconciliation timer. This is a declared protocol exception,
not an additional component reader.

## Module and consumer inventory

| Resource/projection | Current owner | Consumers / domain behavior |
| --- | --- | --- |
| Project catalog; session navigation/full summary, activity, Work overview | `stores/project.ts` + `project-live-state.ts` | Existing `useProjectLiveState()` callers share owner; summary/stages gates, sparse directory joins and typed-event overlays remain domain-specific |
| Full session graph | `stores/graph.ts` | On-demand facade for `session-graph-snapshot.ts`; no current first-party component loads this old graph endpoint. It is not prefetched and does not replace navigation summary |
| Live transport | `stores/live.ts` | `useLiveClientPool()` is an accessor/dependency-injection bridge, not a pool factory per component |
| Automation catalog | `stores/catalog.ts` | `useAutomationCatalog()`, AutomationDetail, WorkflowManager; revision exposed to old consumers is a read/reconciliation hint, not the data version |
| Folder and sidebar node catalogs | `stores/catalog.ts` | FoldersSidebar; independent resource topics and leases, no reads on session-array changes |
| Work completion reads | `stores/catalog.ts` | `useWorkCompletions()`; acknowledgement remains explicit POST, followed by refresh |
| Usage summary and daily pages | `stores/catalog.ts` | ProjectUsage; page number/Project are part of key; daily pages load only on demand |
| Knowledge catalog and revision-scoped entry | `stores/knowledge.ts` | KnowledgeView; explicit activation/refresh (no knowledge live topic), independent detail leases; wrong returned revision rejected |
| Maintenance summary and immutable report | `stores/maintenance.ts` | KnowledgeMaintenance; collapsed report does not prefetch findings, scan/repair remain command client calls |
| Workflow sync projection | `stores/workflow.ts` | WorkflowManager; existing full/delta/noop adapter, ordering and graph/inspector references retained |
| BOT public catalog, runtime status, observed groups | `stores/bots.ts` | ProjectGroup and useServiceGroups; settings drafts and secrets never enter this owner; observed group parsing in `service-group-contract.ts` |
| Direct/read-only chat history, context, physical segments | `stores/chat.ts` | ChatTab uses one app owner for active flights and protocol bases; independent mutable presentation bodies for multiple panes |

## Specialized paths retained intentionally

These are not a second shared resource implementation:

- `createSnapshot()` and `createLiveRefresh()` are compatibility/callback bridges
  to **the same engine**. Neither contains a parallel scheduling loop.
- `automation-catalog.ts` is a non-component compatibility facade over
  `resourceViews`; its previous independent map/scheduler has been removed. The
  actual first-party component catalog owner is Pinia, not that factory.
- Automation run-history pagination, session-work terminal-404 recovery and
  logs/spans/process output use domain/view-specific callbacks through the shared
  engine bridges. They are not flattened into a universal entity collection.
  Their pane-specific pagination/selection is not a global complete dataset.
- `chat-history-snapshot.ts` and `readonly-history-snapshot.ts` retain only protocol
  factories; old pool-keyed global accessor caches were removed. Chat stream
  presentation, tool pairing and segment order remain domain-owned.
- Settings/edit forms, model/provider choices, BOT credentials, capture/private
  credential requests and file capabilities retain explicit view/permission
  lifecycles. They must not be blindly cached in a public catalog module.
- File tree/search, raw media/download/upload, workdir execution/Git and device
  administration/placement have their own capabilities, pagination or command
  lifecycles. Sidebar node *catalog* caching does not grant those capabilities.
- POST/PATCH/DELETE, chat send, replay/control, repair/apply and registration/clone
  commands are never automatically retried because a resource read reconnects.

No new persistence format, JSONL/SQLite migration, offline cache or service restart
is introduced by this client refactor.

## Adding a resource

1. Define a small read projection and runtime parser. Split summary/detail; give
   entities stable IDs. Do not fetch internal evidence/configuration unnecessarily.
2. Choose a module and canonical key including all query/projection boundaries.
3. Acquire a resource view; load through the domain client with the engine signal.
4. Activate existing LiveClient invalidation/readiness, or document a bounded
   active-only fallback when the backend has no suitable topic.
5. Return selectors/lease actions. Release from component scope/visibility cleanup.
6. Keep mutation commands explicit and invalidate only affected resources.
7. Test shared reads, last release, scope/abort races, no-op/delta/delete/resync,
   authorization failures, memory budgets and required protocol invariants.

For example (illustrative, not a copy-paste unvalidated wire contract):

```ts
const views = resourceViews()
function acquireSummary(scope: Scope) {
  const key = canonicalResourceKey({ ...scope, resource: 'example', projection: 'summary-v1' })
  return views.acquire(key, async signal => summarySchema.parse(await client.read(signal)))
}
```

A new backend API still needs projection/ETag/version/delta support appropriate to
its data. This refactor prevents duplicating client synchronization mechanics; it
does not turn a full JSON endpoint into a server delta feed without backend work.
See [snapshot transport](live-snapshot-transport.md) for the existing reusable
Work/Maintenance responder and wire protocol.

## Verification

The dedicated resource/adapter regression suite covers single flight, generations,
atomic version publication, validation/recovery, leases, last-release cleanup,
multiple Vue roots, UTF-8 retention limits, visibility, Project/auth isolation,
lazy details, graph partial/full recovery and chat ownership. Existing domain tests
remain relevant: a generic engine pass does not prove message/lineage semantics.

Run app typecheck and production build plus focused resource suites. Broader
frontend regressions must be compared with the same base commit and dependencies;
this repository has pre-existing fixture/source failures. Do not remove assertions
or call an unrun live application/production HAR validated. No production config,
credentials or user transcript bodies should be saved as test artifacts.

### Verification gap follow-up (2026-11-15, before session rebase)

- macOS: repository `pnpm typecheck` and `pnpm build:app` passed after the fixes.
  The expanded engine/module/domain regression command passed 170/170, including
  confirmed-command/read races, revision reuse/eviction and completion error recovery.
- The comparison used tracked-clean `0a3e07a6` source with the same installed
  dependencies, Node 24.22.0 and pnpm 12.3.1. The complete base frontend run had
  1,695 tests: 1,548 passed, 145 failed and 2 skipped. The later resource-branch run
  had 1,718 tests: 1,593 passed, 123 failed and 2 skipped. It is not a green suite.
  Earlier runs affected by concurrent source edits/Vite HMR were excluded from
  acceptance evidence. The two subsequent targeted fixes below were rerun separately.
- Comparing actual errors, assertions and protocol fixtures—not just failure
  names—exposed three refactor regressions: dropped Knowledge detail reuse;
  confirmed deletion disappearing on failed catalog reconciliation; and a failed
  completion acknowledgement remaining in error after successful explicit GET
  recovery. All have focused regression coverage. Completion recovery never
  replays POST and cannot hide a newer command failure.
- Historical fixture errors can mask later assertions. With only its Markdown
  directive stub corrected, the base Knowledge renderer passes 18/20. The fixed
  branch reaches the same two old FileWorkbench harness failures; its Knowledge,
  Maintenance, deletion and cancellation assertions pass without removal.
- Native Electron Knowledge smoke passed, including visible 503/manual recovery,
  sanitized links, deep links, keyboard/narrow-theme navigation, hiding/restoring
  and switching Project scopes. Workflow visualization/selection-admission, Usage
  layout and the full completion board/read-receipt smoke also passed independently.
  The latter checks 3,001 variable-height cards with a bounded mounted viewport.
  Shiki's real Vite lazy-import/reload test passed in both complete comparison runs.
- Native fixtures must install the same per-root stores as production. Explicit
  test-owner substitution replaces retired project/catalog injection keys; it is
  not a production alternate owner. Their browser dependencies include Pinia when
  prebundled. Synthetic API fallbacks must match backend route prefixes, not an
  arbitrary `/api/` substring that can intercept Vue devtools JavaScript modules.
- Knowledge's old unsafe-link assertion assumed the parser creates unsafe anchors.
  Actual markdown-exit output preserves those destinations as literal text. The
  updated smoke asserts the original text, absence of unsafe anchors/hrefs and raw
  HTML sanitization, and separately exercises malformed incoming URI fragments.
  Cancellation fixtures wait for an actual started flight before asserting abort.

Useful reproducible commands (the broad command deliberately preserves failures):

```sh
pnpm typecheck
pnpm build:app
pnpm exec node --import tsx --test --test-concurrency=2 'app/src/*_test.ts'
pnpm exec node --import tsx --test --test-concurrency=1 app/src/knowledge-browser_test.ts app/src/workflows-rendered_test.ts app/src/workflow-selection-sync-rendered_test.ts app/src/project-usage-browser_test.ts app/src/work-completions-rendered_test.ts
```

Known source-token, old full-root fixture and preview failures remain. For example,
correcting the persistence fixture's transport lifecycle and snapshot envelope on
both trees reaches the same unavailable-preview failure; it is not acceptance of
that uncompleted preview flow. No production application restart, production HAR,
or claim of exhaustive product correctness accompanies these isolated checks.
