# Unified Workflows

Workflow is the durable execution unit; a **run is not a model session**. Signal Sources admit observations into a bounded typed node plan. Schedule is one Signal Source. The former Automation preset is a time-signal → fresh-Agent workflow; an existing-session schedule delivers into an already authorized conversation. Integration describes a purpose, not another execution engine.

## Product surface

Open **Project → Workflows** (`/projects/:projectId/workflows`). Workflow and Settings are closable Project documents: their open set and component lifetime belong to the Project workspace, not a session or draft. Opening the latest automation conversation, navigating its history, or switching ordinary sessions activates Conversation without closing the Workflow document. Returning to the document retains its workflow/run/BOT inspection and canvas state. Explicit close (including Ctrl+W) destroys the document until it is explicitly reopened; Projects keep separate document sets. This is in-memory workspace state, not persistence across a page reload. One shared Vue Flow canvas groups workflows into three horizontal columns (Cron, Automation, BOT), stacking each category vertically. Schedule delivery to a fixed session (reuse context) appears under Cron; schedule delivery to a stable automation job (fresh context each run), including ordinary fresh cron, Learning and Work Dispatch, appears under Automation. Learning/Work Dispatch are execution strategies, not destination node types. Other runtime workflows also appear under Automation; BOT projections always appear under BOT. Classification uses the shared validated delivery projection of saved job metadata, never names or IDs. Column spacing accounts for the widest graph in each category; narrow windows retain the columns through canvas pan/zoom.

The canvas groups all workflows, with properties and run history in a resizable right inspector rather than a nested flow list. Each graph connects Source → optional observation deduplication → action nodes, with current or historical run configuration, node/run status, latest 30 retained runs, sanitized errors and recovery guidance. Definition revision numbers remain internal concurrency/snapshot data, not routine UI labels. Source availability, persisted collector error and next reserved collection check are separate from run status. A baseline or idle deterministic check may create no run. A run exposes a conversation link only when the executor returned a real `output.sessionId`; the history keeps links beside their respective run identities and reports missing receipts explicitly. Fixed session destinations also have target links on the node and in its details, without implying that a run occurred. Links use the existing Project chat route and do not inspect or pan the canvas. Work mapping returns a separate `output.workKey`.

Time signals use exact natural-language units in English and Chinese (for example, `every 1800000ms` becomes every 30 minutes); daily cron times such as `0 3 * * *` display as 03:00. Unsupported expressions remain verbatim, raw configuration preserves the expression, and unrecorded timezones are never inferred. Dedicated fresh-run conversation headings use the persisted automation name, including historical names, rather than the task prompt or today's catalog. Ordinary/fixed-delivery sessions keep normal titles; older records without a dedicated-run association fall back without guessing from IDs.

Configuration is edited through chat, not fields or drag handles. The page retains pause/resume/retry/cancel operational controls; blocked retry requires explicit confirmation after inspecting effects. It does not create schedules, subscribe sources, register accounts or send messages by merely opening the page. Automation conversation pages and sidebar are read-only session-history projections with Workflow links; model/interval/enable configuration controls have been removed from these pages. Existing domain host configuration APIs (learning, organizer and Work dispatcher) remain host-authorized capabilities, not a second Workflow executor. Generic schedule configuration is chat-authored.

The initial viewport remains at readable 100% scale (roughly three workflows on a
typical desktop pane); Fit diagram is an explicit overview action. Drag empty
canvas with the left or middle mouse button to pan; click a node or workflow title
to inspect it. There are no selection/hand modes. Focus the canvas for wheel pan,
Ctrl/Cmd-wheel zoom, Shift+1 fit-all, Shift+2 fit-selection and Escape. The canvas
and empty state reveal the same theme-aware body dot grid as chat, stationary
under viewport pan/zoom rather than adding another graph background layer.
These controls never edit or execute nodes. Paused flows use dashed boundaries
and edges with explicit text; only real running state animates edges, respecting
reduced motion. Nodes show saved schedules, session policies, targets and task
summaries; unavailable timezone/target metadata is marked unrecorded.

## BOT topology (read-only first stage)

The existing Project Workflow tab and shared canvas also show the live BOT topology:
**connection → conversation binding/listener → published BOT/Agent → existing Session**.
These are inspection entries, **not saved Workflow definitions or Workflow runs**.
`GET /api/workflows` adds an optional `bots` DTO under the same authenticated,
Project-scoped route. `botWorkflowProjection` reads `BotInstanceStore` IDs,
`ChannelManager.botStatus`, pure `DirectoryBots.inspect` verification and its
canonical `botInputListeners` projection. There is no new binding database or
persisted topology cache. Connections are one inventory object referenced by all
bindings; one QQ account can serve different groups with different deployed BOTs
and deterministic published Agent identities.

The inspector keeps transport health/connection enablement, binding enablement,
subscription selection, projected listener presence and package validity separate.
A valid package is lazy-validated data, not a running process or successful message.
Routing is not probed and processing success is unknown; overlapping subscribers,
current admission checks or broken sibling storage can still prevent delivery.
Disabled and unsubscribed bindings, unbound connections and quarantined/unavailable
packages remain visible. Missing or bounded inventories show a warning (up to 1000
connection IDs, 1024 deployment directory entries and 5000 binding rows).

Only IDs already present in SessionManager receive conversation links. QQ/Feishu
and exact Discord channel bindings use the host channel-session identity helper,
including legacy connection identities. Discord DM/observation/descendant-thread
sessions are not guessed. Personal BOTs show the host-owner ingress and selected
ordinary Agent, using host Session listeners; private owner topics are omitted.
No existing-session link prepares, restores or sends to a session. The BOT inspector
selection is retained with the Project's existing Workflow document tab.

An isolated BOT connection group's ellipsis opens the existing **Project settings → Connections** form at `/projects/:projectId/settings/connections?connectionId=:connectionId`. The authorized Project connection list resolves that exact ID after loading, including on refresh; unavailable/deleted IDs show a notice and never fall back to another connection. Navigation only reads status: it does not save credentials, connect, enable or reconnect. Published BOT/deployment groups do not use this connector shortcut, and complete binding chains retain their existing conversation links.

The DTO is an explicit allowlist: no credentials/config, prompts, tools, grants,
allowlists, parameters, source paths, exception bodies or message content. URL-bearing
labels are redacted. BOT entries have no pause/resume/retry/deploy controls; ordinary
Workflow controls cannot address them. InputRouter, SessionManager, platform security,
precise publication confirmation and all message execution remain unchanged. Reading
never imports BOT tool modules, deploys, repairs quarantine state, replays messages,
restarts adapters or writes runtime configuration. Execution migration is deferred.

## Chat authoring

Discover `workflow` through `v:tools`; `v:workflows/authoring` provides examples and contracts. `read` returns standard JSON; the VFS exposes `definitions/<encoded-id>.json`, `runs/<run-id>.json`, `records/<encoded-flow>.json`, and `mappings/<encoded-flow>.json`.

The `workflow` tool supports:

- `read` (optional flow/run `id`), `validate`, `create`, `update`, `remove`.
- `create`/`validate`: `definition` below. `update` requires `expectedRevision`; remove requires `id` and `expectedRevision` and retires an external identity, cancelling pending runs but retaining history/materializations/Work.
- `source`, with `input` containing the Signal Provider tool's typed arguments: publish/reload, create authorized instance, browser discovery/rebinding, subscribe/unsubscribe, pause/resume and manual rate-limited collection. This reuses the capability broker, exact browser identity and credential-reference checks; it is not arbitrary tool dispatch.
- `schedule-create`, `schedule-update`, `schedule-remove`, with `input`: create accepts `{schedule, task, session:"fresh"|"existing", name?, agentType?, targetSessionId?, once?, urgency?, debounce_ms?}`. Update additionally requires the schedule **job** `id` and Workflow `expectedRevision`; remove takes only those two. Target selection reuses `SessionManager.assertCanScheduleSession`. Host-owned programs cannot be authored through this interface.
- `pause`/`resume`: flow ID. `retry`/`cancel`: non-active run ID, plus `acknowledgeReplay:true` for a blocked retry. Confirmation does not bypass source authorization or Work field ownership.

Example external definition:

```json
{
  "id": "issue-triage",
  "name": "Issue triage",
  "source": { "kind": "external", "id": "authorized-issues-instance" },
  "binding": { "demand": { "repository": "owner/repository" } },
  "gate": { "kind": "revision-dedupe", "first": "baseline" },
  "enabled": true,
  "nodes": [{
    "kind": "work-map",
    "objective": "Triage this issue; review before assignment",
    "titleField": "title",
    "revisionField": "updatedAt",
    "ownership": "exclusive-until-local-edit"
  }]
}
```

`gate` is optional. It is an explicit **fixed leading** revision-deduplication
stage, not an action that can be placed arbitrarily in the node sequence. Omit it
only when repeat observation admissions should create independent runs. The
absence of a gate is not an implicit `emit` dedupe policy. Source shortcuts that
request `first` continue to create an explicit gate.

When a gate is present, `first:"baseline"` silently records the first successful batch, even empty. `emit` admits its unseen revisions. This is explicit per-Workflow business state, never inferred from a shared collector checkpoint. Source instance/demand, gate presence and first-batch policy are immutable identities: changing them requires a new ID and explicit first policy, rather than quietly replaying or skipping another feed. Mutable names, enabled state and plans use optimistic definition revisions. Admitted runs retain their own immutable definition snapshot. A work-map configuration becomes immutable once a mapping run is admitted, so a new template cannot silently take ownership of already mapped Work.

## Typed actions and Work ownership

Runtime Zod contracts reject unknown fields, host-action injection and invalid inbox ordering. Plans have 1–8 nodes; this is not an arbitrary DAG, script/tool engine or visual editor.

- `record`, optionally `revisionField`: materializes one observation per item (or revision ID when no item). **Without revisionField, arrival order wins**, not provider revision order. With an explicit ISO timestamp field, older/equal observations are ignored and reported as `output.stale`; equal-time ties are first accepted wins. Opaque revision IDs are never lexically ordered.
- `transform` with restricted no-IO `code`, followed by `inbox`: 0–16 text drafts, delivered only to the definition owner through the existing inbox route. No host tools or arbitrary session target are exposed to the transform.
- `work-map`: requires a stable observation `item`, ISO timestamp `revisionField`, bounded string `titleField`, optional bounded string `summaryField`, and a **constant authored objective**. It creates unassigned pending Work through normal `WorkAlignment` using the durable owner as a session actor, not impersonated human authority. The external source may update only title and optional summary. It cannot change goals, evidence, assignment, status, review, acceptance or execute external instructions.
- Schedule and internal `host-action` nodes can only be installed by trusted adapters. They preserve SessionManager, WorkDispatcher, Bot wake and learning boundaries, including deterministic preflight and ordinary-worker classification.

Mappings are Project + Workflow + item scoped. Workflow persists the initial creation request before calling Work. Work's existing transactional idempotency key recovers a committed creation even if linkage/publication fails. Retries use that original request; future revisions update the same key. Both mapping state and latest source timestamp survive restart. Local changes to source-owned fields block with `mapping_conflict` unless the field already equals the intended value (recovery of an applied update). Manager transfer is rechecked even on a data-equal replay. Unowned notes, assignment and completion remain untouched. Identical values cannot distinguish a local edit from replay; this is value-based conflict detection, not an edit-origin history claim.

## Execution convergence and specialist boundaries

`src/workflows/runtime.ts` owns durable definitions, baseline/revision state, admissions, node progress, retries, history, records and Work mappings. `src/signals/providers/runtime.ts` owns authorized collection, normalization, protocol checkpoint and rate reservations. **Workflow.binding.demand is the only business subscription fact.** Sources do not persist subscriptions or fall back to old demand. `subscribe` is create-only shorthand for the same `WorkflowRuntime.author` boundary, using `external:<id>` and an explicit binding. Existing or retired IDs cannot be overwritten. `unsubscribe` requires `expectedRevision` and calls the same `retire` boundary as Workflow remove. Generic and shorthand authoring share ownership, first-policy, demand, materialized mapping and tombstone checks. VFS subscription paths use encoded full Workflow IDs, avoiding collisions between `id` and `external:id`.

`src/cron/service.ts` is the Schedule Source and lifecycle adapter: parsing, timers, reservations, managed jobs, cancellation and overlap checks. Its constructor requires the Project Workflow runtime; there is no direct action-handler fallback. Test composition injects a real disposable Workflow runtime. The `cron_add`/`cron_remove` tools use the same serialized `scheduleAuthoring` adapter as `workflow schedule-*`; removal requires the Workflow revision. Source inventory is a domain timer configuration, not another business outbox. Definitions appear before the first tick and are revised as configuration changes. Removed IDs cannot be reused; removed sources retain inspectable paused definitions/history, and recovered old actions cannot execute changed or removed live configuration. Non-agent maintenance timers retain their cleanup/collection duties; they cannot dispatch schedule actions outside Workflow.

The event-driven organizer keeps deterministic delta selection, debounce and display-specific evidence/patch validation. Its admitted agent executions now enter a trusted internal Workflow node and uncertain outcomes block rather than auto-spawn another organizer. Its display evidence store is not an alternate general workflow engine.

GitHub resource observation is a typed **`github-resource` Signal Source → revision gate → `github-notify`** Workflow, not an internal host-action black box. Each immutable subscription authorization snapshot has a separate lane; the graph shows resource URL/ID, target session and Work key; assignment revision remains in the raw technical snapshot. The domain service retains repository grants, Work links, source snapshots, event selection and target authorization. Snapshot comparison is deterministic and calls no model. It admits transition observations to Workflow **before** saving the resource checkpoint; replay of a failed checkpoint write has the same transition ID. Workflow alone persists new notification admission, progress, retry and uncertain-effect state. The former GitHub pending/sending/sent notification queue receives no new notifications and is never automatically drained. Historical pending/unknown receipts remain available for explicit resolution; an explicit retry transfers one receipt into Workflow using its original ID.

At the notification effect boundary, repository read permission, exact enabled subscription, resource–Work link, durable target, assignee/manager membership and assignmentRevision are all rechecked. Notifications go through EventService only to the bound Session, not a user broadcast. Inbox acceptance is not user visibility, session completion or Work acceptance. Uncertain delivery blocks in Workflow for inspect-first confirmation; it is not silently retried by a second queue. A queue-mode notification may later wake the authorized session's normal Agent; acquisition/notification itself is not an LLM processor.

GitHub manual Issue import and preview/execute/reconcile write APIs are **domain capabilities, not legacy execution engines**. Work agreement review, exact source hashes, branch fingerprints, approved text, write receipts and unknown-write reconciliation remain mandatory and separate from notification execution. They are not replaced by descriptive work-map or exposed as arbitrary authored host actions. Old notification receipts and external-write receipts are explicitly different records.

## Persistence and recovery

One host is the supported writer per Project. Private atomic Workflow JSON snapshots carry the Project ID. When a gate is present, dedupe + run admission commit together; collector checkpoint commits only **after** admission. A source write failure can recollect, and the explicit gate prevents duplicate revision admission. Without a gate, each admission has a new run ID, including repeated observation IDs; recollection after a checkpoint failure can therefore create another run. The opt-in 4096-revision window is bounded; very old unmapped revisions can repeat. Each materialized flow is bounded to 4096 records/mappings, all state to 16 MiB; pending runs are never evicted to make room for history. Completed history retains a bounded tail independently of dedupe.

Different flow lanes run concurrently; each flow is serial and blocked revisions cannot be overtaken. Nodes record start before an effect. Transform drafts and accepted inbox progress persist. Record effect and cursor share one snapshot. Work creation uses the existing transactional key; updates use Work sequence checks and value-based replay detection. None of this promises cross-store or external **exactly-once** execution.

Safe actions use bounded exponential retry. Started/failed or crash-interrupted unsafe schedule/internal host effects block with an inspect-first hint. Pausing prevents new execution, but gated external observations still advance the revision window; it is not rollback or buffered catch-up. Cancellation is cooperative: accepted effects may remain. Workflow/source errors are safe codes, never raw provider bodies or credentials. Source collection errors persist without advancing the failed batch checkpoint.

All mutations require direct user input and an eligible durable Project-owner session. Read/validate do not grant permission or execute effects. HTTP operational controls use the existing Project host authorization. Source/owner/Work authority is revalidated at execution. Browser transport must retain the exact explicitly authorized identity; no remote-to-Main or browser-to-native fallback exists.

Storage is Project-local `.workflows/state.json` and `.signals/sources-v4.json` through the standard data-path resolver. Old source-state formats are not imported, executed, modified or deleted. v3 instance identifiers alone are read to reserve identities; old code, credentials, subscriptions and checkpoints are not loaded into the runtime. Use new instance IDs and recreate intended bindings explicitly. Existing historical Workflow source references also reserve their instance IDs. Existing session JSONL/SQLite schemas and real user data are unchanged.

### Schedule compatibility and run identity

New fixed/fresh/program Schedule definitions contain no gate: a tick is not a
business revision. Synchronizing an existing Schedule removes its old gate from
only the current definition, increments the definition revision once, and clears
that active identity's obsolete seen window. Unchanged restarts do not repeatedly
increment the revision. Old admitted runs keep their gate/revision snapshots and
remain visible as recorded. Existing external gates and first-batch policies are
not changed or removed; omitting a gate in an update to such a flow is rejected.
Retirement tombstones remain independent of whether the retired flow used a gate.
A separate persistent `admitted` identity map commits atomically with the first
admission. It prevents default Schedule installation from reviving an identity
whose terminal runs have aged out; it never suppresses repeated observations.
Old retained runs and legacy Schedule emit-window receipts conservatively seed
that identity map, while unused definitions receive no receipt. These markers
are not evicted with run history or silently garbage-collected. They share the
16 MiB total-state ceiling; capacity/write failure rejects the atomic admission
without leaving a false receipt.

No-gate admissions use independent run IDs; a duplicate observation in a later
admission is allowed. Recovery always drains the same persisted run, preserving
cursor, start/accepted effects, retries and uncertainty blocks. Schedule pending
and overlapping-tick suppression remain in the source adapter; removing its
revision window does not enable catch-up bursts or replay a blocked effect.

The new reader accepts old snapshots. Deploy the matching frontend/backend;
older binaries that require a gate cannot read newly persisted no-gate definitions.
This is not a reversible runtime-data rollback or a migration of old Source stores.

## Validation scope and limits

Synthetic tests cover chat authoring → HTTP/VFS visualization payloads, source/Project/owner refusal, immutable in-flight revisions, collector → dedupe → Work create/update, failure after Work commit, repeat/restart, stale timestamps and local-field conflicts; Schedule fresh/existing sessions on both session stores; internal organizer/GitHub subscription execution; rendered read-only graph, responsive themes, deep links, errors and explicit retry confirmation. No live credentials, sources, schedules or external accounts are provisioned by these tests.

Not implemented: arbitrary DAG/branching, a manual editor, arbitrary host scripts/tools, automatic source rebinding, transactional external effects, distributed writers, unbounded retention or a real Azure provider. New subscribers on a shared delta cursor cannot recover observations already passed by that source. GitHub manual business protocols and automation session-history projections intentionally remain specialized adapters; they do not imply every external operation is configurable as a Workflow node.

## Legacy cleanup ledger

Removed: Source-owned subscription storage/fallback; unversioned Source retirement; production Cron/GitHub execution without Workflow; GitHub's new-notification pending/sending/sent queue; the event_provider alias; Automation model/interval/enable configuration surfaces. Host namespaces (`schedule:`, `internal:`, `github:`) cannot be claimed by external chat authoring. Historical collisions fail before saving GitHub subscription authority. Default Schedule installation can recover an identical Workflow-before-jobs checkpoint, but not a removed/admitted/changed identity. Schedule startup and async updates cannot reinstall timers after stop/removal.

Retained deliberately:
- Source instance grants, browser identity, rate reservation and transport checkpoint are collection-domain state, not subscriptions or business retries.
- Cron parsing/timers, job inventory, managed defaults and maintenance cleanup are a time-source adapter. Workflow owns schedule action admission/progress/recovery.
- GitHub repository grants, resource snapshots, Work links and subscription authorization constrain the typed Signal Source. The initial linked snapshot emits no transition; the first later selected change enters an emit gate. Import and preview/execute/reconcile remain manual domain capabilities. Old notification records are historical reconciliation evidence, not a live queue.
- Work Organizer's session-metadata delta selection/debounce and evidence/patch validation remain a domain service around its internal Signal → Agent Workflow.
- Automation session history/usage projections and host-authorized learning/organizer/Work-dispatch configuration APIs remain; the old Automation pages no longer author configuration. These APIs are not separate executors, nor arbitrary Workflow host-node authoring.
- EventService/internal subscriptions still route directed session inputs. They are not the removed external provider subscription store.

Apart from the compatibility normalization described above, no automatic migration, execution, deletion or successful reconciliation of historical data is claimed. Unknown external effects still need explicit human inspection; inbox acceptance and model-session completion remain distinct from Work acceptance.

### Graph object categories

Node surface tints identify object type, not enabled state, connection health or
processing success. BOT projections carry explicit connection, conversation
binding, published deployment and session metadata. Ordinary Workflow nodes use
three stable categories: source, optional gate and action (all action kinds share
one tint). The `--c-graph-*-bg` tokens provide subdued light/dark category surfaces;
type labels remain visible. Paused nodes retain dashed edges and a muted tint;
execution status remains separate text on a neutral badge. BOT projection headers
use object icons and type badges rather than Workflow enabled/paused icons;
isolated inventory is not evidence that a Workflow is paused.

### Delivery contract and execution strategies

`src/cron/delivery.ts` is the renderer-safe shared contract used by the schedule
adapter, Workflow validation and frontend projection. New or materially revised
schedule nodes record `delivery: {kind:"session", sessionId, context:"reuse"}` or
`{kind:"automation", jobId, context:"fresh-per-run"}`. Timing remains the same
`schedule` source for both. External/internal sources retain their real source;
placing them in the Automation column does not invent a time signal.

The legacy `action: session|agent|program` remains a compatibility wire field;
it is not delivery evidence or a new execution permission. Readers derive absent
delivery from the saved job (`session` defaults to existing); conflicting explicit
delivery is rejected. Equivalent legacy definitions are not rewritten on startup
just to backfill delivery; saved run snapshots remain unchanged. Managed registration
`createdAt` differences are not configuration revisions. Existing gate migration
rules above still apply.

Stable automation identity is the job ID, not a physical session ID. Fresh runs
keep their existing `cron:UUID` / AutomationSessionRef behavior and latest-run
navigation through the catalog association; a scan without a session receipt does
not acquire a synthetic session link. No second destination database is introduced.
Learning evidence/ledger recovery, Work Dispatch dependency/capacity/write-ahead,
resume permissions and budgets, and Bot wake platform admission stay in their host
handlers. Delivery never converts a managed strategy into a generic prompt or
claims an idle scan ran a model. Completed Workflow execution is not itself proof
of a model session or a verified learning outcome.
