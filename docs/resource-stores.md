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
retains at most 16. Byte measurement occurs only when an entry is actually retained,
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

### Refactor-branch verification record

- macOS: repository `pnpm typecheck` (backend, bridge, desktop and app) passed;
  `pnpm build:app` passed. Final app typecheck after integration also passed.
- Dedicated engine/module/domain suite: 158/158 passed, including transport,
  graph, chat, Maintenance, catalogs, callbacks and released-retained-lease tests.
- Browser/renderer: Workflow visualization and native observed-group smoke passed;
  all 17 Usage renderer cases passed after preserving queued refresh semantics.
- Broad frontend run: 1,507 tests, 1,450 passed and 57 failed. Same-dependency base
  archive: 1,471 tests, 1,404 passed and 67 failed. Comparing failing test names
  identified one new Shiki/Vite timeout in the concurrent run; its isolated rerun
  passed. A name comparison is not proof of identical failure causes.
- Knowledge browser and several older source/fixture suites remain failing;
  they are not reported as UI acceptance. Existing base also fails Knowledge
  browser/workflow-selection fixtures. No production application restart or new
  production HAR measurement was performed.

This records verification evidence, not a claim that the entire historical test
suite is green or that all server endpoints now have a common delta wire protocol.
