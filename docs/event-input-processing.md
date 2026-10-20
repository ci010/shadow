# Programmable input processing (Discord, opt-in)

## Why a small ingress layer is needed

The existing components are sufficient execution/delivery substrates, but **not an already-complete programmable raw-ingress pipeline**:

- `src/channels/discord.ts`, `MESSAGE_CREATE`: an ordinary guild message is not dropped at the mention gate; it becomes `silent` and goes through `handleIncoming`. Unauthorized senders remain excluded; bot messages are suppressed by default.
- `src/agent/app.ts`, `acceptInbound`: channel event publication happens after original input acceptance and explicitly excludes managed `channelAdmissionId` messages.
- `src/events/service.ts`, `publishChannelMessage` / `resolveDelivery`: publication excludes the original session, and legacy `silent` overrides subscription urgency. Existing debounce delivers the latest payload plus coalescing metadata, not a full content batch.
- `src/channels/integration.ts`, `authorize`: managed channels accept verified platform user inputs, not arbitrary events. Turning a script event into a user input would break this boundary.
- `src/script-runtime/bridge.ts`: interactive exec tool/infer bridges require bound session authorization; infer is explicitly restricted to local Node exec. Do not manufacture an exec identity for ambient events.
- `src/agent-authoring/tool-runtime.ts` already executes reviewed modules in disposable restricted children; reuse it with frozen bundled local modules and without host imports or capability grants.

The new generic `InputProcessor<T>` selects ignore / buffer / emit and owns bounded fixed windows, independently of EventService subscription delivery. The first integration is managed Discord's already-authorized ingress. No parallel event bus, scheduler service, arbitrary tool execution grant, or new authoring tool is introduced.

## Authoring and approval

Add optional `processor: {code, delayMs, includeBots?}` to a Discord binding through the existing `channel_config` / owner `bindings.save` proposal and **exact human review**. A proposal alone never executes code. Removing `processor` restores default behavior. No online binding is enabled by this implementation or its tests.

Example code (plain TypeScript module, no imports):

```ts
const rules = [
  (text: string) => /free crypto|buy followers/i.test(text) ? 'emit' : null,
  (text: string) => /^(thanks|ok)$/i.test(text.trim()) ? 'ignore' : null,
]
export function run({event}) {
  const text = String(event.data.content ?? '')
  return {action: rules.map(rule => rule(text)).find(Boolean) ?? 'buffer'}
}
```

Set `delayMs`, e.g. 10000. `event` is `{type:'discord.MESSAGE_CREATE', data:<raw gateway message>}`. All names, content and attachment metadata are untrusted external data. Returned schema is `{action:'ignore'|'buffer'|'emit',state?:JSON-object|null,semantic?:{type,data}}`; semantic is permitted only with emit. Scripts cannot rewrite platform identity/content, call tools, send messages, invoke inference, import host modules, or recursively emit events. Semantic data is untrusted and only the independently authorized observation host can admit it to a service context. Composable functions/arrays are ordinary TS, not a new rule DSL.

- No incoming message: no script execution and no model inference.
- Ignore: no model wake and no silent-history insertion.
- Buffer: retain the original raw message in the bounded inbox. A fixed window starts at the first buffered message, not a trailing debounce; an endless stream cannot postpone delivery forever.
- Emit: immediately enter the original verified user-input path, without flushing buffered questions early. This wakes the Agent; it does not itself post moderation actions or guarantee a hard real-time reply. Disposable-worker startup/classification is bounded by a 2-second timeout.

## Authority and compatibility

Processing occurs after `admit`, before mention/DM filtering, reactions, attachment downloads and session delivery. No processor means the original behavior remains unchanged. With a reviewed processor, emit/flush overrides mention-only triggering **once**; the raw input is not also sent via default handling.

Buffers are partitioned by conversation/session, sender ID and binding-policy revision. Different senders are never combined or assigned another sender's execution authority. On flush every original message is re-admitted, temporary admissions discarded, then the latest original message is admitted again through normal delivery. A revision change/removal drops the pending batch. Revocation or failed re-admission fails closed. Existing before-inference / before-output checks remain in force. Batch content contains each original message ID, author and content as untrusted JSON; it uses the original latest ID and sender, not a synthetic event impersonation. Attachments remain on the existing download path.

## Explicit boundaries and failure semantics

- Managed adapters with `processorStorageId` persist inbox rows and the last 2000 completed IDs under Project Home `state/events/processor-inbox-<hashed stable bot ID>.json`. Manager supplies the stable bot ID. Volatile processors (no storage ID) do not recover. Atomic private-file replacement is used; this is not an exactly-once or power-loss/fsync guarantee. A crash after downstream acceptance but before journal replacement can replay an identical message ID.
- Max 100 retained inbox rows, 256000 bytes per row, 4000000 bytes per journal, 10 active workers globally, one classifier lane per authority partition; publication lanes run independently of queued classifiers. Same-partition burst queues rather than dropping solely because busy. Overflow rejects before retention: the caller must retry; there is no Discord gateway-level redelivery guarantee. The two-second deadline starts when a worker begins, not at arrival. Retained work expires after ten minutes.
- Failures have at most three attempts, with one/two second retry delays. Successful or exhausted IDs enter the bounded dedupe cache. A publication failure can make the initial call reject even though the journal schedules retry. Invalid code/output, timeout, capacity errors, cancellation and delivery failure never fall back to a model wake. Error callbacks/logs are payload-free; there is no receipt/recovery UI or dead-letter inspector yet.
- Stop aborts active work, clears timers, retains unacknowledged durable rows and is idempotent (old instances cannot rewrite newer journals on repeated stop). Recovery obtains new host closures and re-admits every original item before delivery. Unapproved/stale revisions fail closed; removed permissions are never restored from the journal. Pending bytes remain until attempted delivery or expiry, not synchronous policy-update purge.
- Scripts run per incoming message. The bounded partition-local JSON state described below is available. The independently reviewed observation classifier described below is the only event-time small-model capability. There is no arbitrary infer or asynchronous custom emit API. Existing infer restrictions are unchanged.
- The generic processor is reusable, but this change does **not** wire generic EventService sources, legacy unmanaged Discord, QQ or Feishu into it. General subscriptions retain existing semantics. Cross-sender question batching requires an explicitly designed authority-intersection model; it is intentionally not implemented.
- Programmatic processing is downstream of real Discord visibility/intents and participant admission. Bot messages require explicit reviewed `includeBots:true` and still pass the same live participant admission. Self messages are always excluded (gateway identity and server-confirmed binding identity); each other bot has a hard 60-second per-conversation cooldown, capped at 1000 active cooldowns. This bounds inter-bot reply amplification but does not guarantee prevention of every slow multi-bot cycle; do not deploy auto-reply bot networks without their own suppression policies. Fixtures do not establish whether a deployed Bot has Discord Message Content intent enabled.

## Verification

Tests use synthetic tokens, local restricted workers and fixtures only. No real Discord connection, messages, moderation actions, app restart or enabled subscription is required.

- `src/channels/discord-processor_test.ts`: real adapter dispatch with managed admission fixture; idle, ordinary messages, full batch content, immediate suspected-ad path, ignore, dedupe, per-sender partitioning, revision change, admission revocation and unchanged default mention/DM behavior.
- `src/events/input-processor_test.ts`: denied host import, malformed output, infinite-script timeout, bounded queued burst, independent timed delivery, durable recovery/dedupe, bounded retry and shutdown cancellation.
- `src/channels/integration_test.ts`: real reviewed binding proposal/commit, processor returned only after commit, persisted binding snapshot, stale admission rejection and refusal of event impersonation. Managed adapter fixtures additionally exercise concurrent burst and durable restart with live re-admission.

## EventService persistence verification

The four previously failing persistence fixtures have been corrected to use the canonical `workspacePath` storage layout rather than the legacy `.events` location. The focused EventService suite now passes all 25 tests in this worktree. This is a test path correction, not evidence of a pristine baseline or a change to EventService production behavior.

## Preparation cancellation

Processed Discord delivery abort-races session lookup, live admission, attachment preparation and channel-name lookup. It propagates the deadline/stop signal to network preparation and checks it immediately before final `handleIncoming`. Aborted or failed preparation discards the retained admission; a late admission result is also discarded. Ignoring cancellation cannot retain the processor operation indefinitely or resume a late model delivery. Late dependency rejection remains observed. Abort cannot forcibly terminate arbitrary host promises or undo an input already accepted by `handleIncoming`; an uncooperative preparation dependency may finish its own work later, without continuing the delivery chain.

## File-first owner workflow

In an authenticated local owner Web conversation, discover `channel_config` and call
`{action:"schema"}`. Its `processorAuthoring` section points to this document,
`src/events/input-processor-sdk.ts`, and portable resources. Fetch `processor_resource` names
`documentation`, `types`, `example`, `fixtures` (or the observation files below); repository access is unnecessary. Work in the
session's local cwd; absolute paths and realpath escapes (including symlinks) are rejected.
This workflow is owner-only, not an additional grant to managed Discord participants.

1. Write a normal `.ts` file. Optional types: `import type { Processor } from '@shadow/input-processor'`.
   Export `const run: Processor = ({event}) => ({action:'ignore'})` or a function.
   This single type-only SDK import is compiler-provided; it is erased before execution.
   Explicit relative `.ts` imports and re-exports are allowed and bundled. Host/package imports, dynamic imports and triple-slash directives are rejected. Every dependency must stay within cwd; symlink modules are rejected.
2. `channel_config({action:"processor_check",path:"examples/input-processor/processor.ts"})`
   returns strict TS diagnostics, sorted dependency snapshots with source hashes, graph SHA-256, bundled JS and its `codeSha256`. Limits: 32 files, 64000 UTF-8 bytes/file, 128000 total bytes, 64000 bundled characters. No execution.
3. `channel_config({action:"processor_test",path:"examples/input-processor/processor.ts",fixturePath:"examples/input-processor/fixtures.json"})`
   runs the same restricted worker and actual InputProcessor window engine. The JSON
   fixture file contains data, never embedded source: `{delayMs,steps,expected?}`.
   Steps are `{kind:'input',key,id,event}` or `{kind:'advance',ms}`. `expected` is
   `[{at,ids}]`. Input IDs stand for retained original items. Timers use virtual
   milliseconds; worker execution/deadlines still use wall time. No real delivery.
   Results include `ok`, outputs, ordered input/advance/publish/error trace and
   mismatch diagnostics. Check/fixture/path failures throw normal tool errors.
4. Read `channel_config({action:"list"})` for binding IDs and revision, then
   `channel_config({action:"processor_propose",path:"examples/input-processor/processor.ts",bindingId:"<existing UUID>",baseRevision:42,delayMs:1000})`.
   Optional `includeBots` remains false by default. This copies the existing binding
   and changes only processor; it does not create or enable a binding. Show the
   returned reviewUrl to the owner. The existing exact human bindings.save review
   remains mandatory. Proposal stores the entire exact dependency snapshot, graph hash, compiled JS and code hash;
   later edits/deletion of the file cannot replace the reviewed program. No path
   is consulted at execution. Legacy inline `{code,delayMs}` remains compatible.

Scope: frozen project-local multi-file graph; fixture time controls window scheduling,
not Date.now inside code or worker timeout. Partition-local state, host time and semantic event output are supported; ordinary processors have no inference capability. Independent observation scopes, not caller-selected keys, authorize cross-channel operation.
This is not an ambient exec/infer session and confers no host/network capabilities.

### Portable schema resources and strict contract

`channel_config({action:"schema"})` returns a resource manifest. Fetch complete self-contained
strings separately using `channel_config({action:"processor_resource",resourceName:"example"})`
(and `documentation`, `types`, `fixtures`). Separate bounded tool results avoid the session's
12000-character tool-result truncation; the schema itself stays below that limit.
Repository paths are optional source references, not required access paths.
In any private session cwd, write the `example` result to `processor.ts` and
the `fixtures` result to `fixtures.json`, then use the same check/test/propose
calls with those relative names. No repository checkout is needed.

Check additionally requires `run` assignable to the SDK `Processor` function
contract, rejecting non-callables, incompatible inputs and invalid output types.
Use `const run: Processor = ...` or `return {action:'ignore' as const}` to avoid
TypeScript widening an unannotated return literal to arbitrary string.
Triple-slash path/types/lib directives are forbidden. Compiler filesystem reads
are allowlisted to trusted TypeScript standard-library files; entry, SDK and
contract-check module are virtual, and arbitrary type-reference resolution is
disabled. Source dependencies are explicitly traversed, bounded and frozen before typecheck/bundling. Both phases consume that frozen graph, not a live filesystem resolver.

## Partition-local state (implemented; not an observation grant)

`run` receives `{event, state, now}`. `state` starts as `null`. Return an optional
`state` JSON object (or `null`) together with the action to replace it. Omitting
`state` leaves it unchanged. `now` is the host clock, including the virtual fixture
clock; prefer it over script `Date.now()` for deterministic window tests.

- The state key is the host authority partition plus the bundled program SHA-256.
  Ordinary managed Discord partitions by conversation, sender and current policy
  revision. Observation partitions instead include reviewed scope, revision, guild and sender. This API does **not** merge channels or bypass participant admission.
- At most 100 active state partitions, 16000 serialized bytes per state, and a
  ten-minute expiry since the last replacement. Expiry is checked on use. Capacity
  fails closed; it does not evict live dedupe/cooldown state to make room.
- State, classification disposition and the existing raw-message dedupe IDs share
  the private atomic inbox journal. Successful publish retries do not rerun the
  classifier, so a counter/cooldown is not applied twice on delivery retry.
- A changed program cannot read the previous program's state. Idle does not run a
  worker, start inference, poll Discord, or perform periodic state cleanup.

## Independent observation and service-owned semantic wake

This capability is **default off** and owner-review-only. It is not a change to
ordinary participant admission. The observation program does not inherit any
observed account's commands or tools.

Create a dedicated published restricted Agent with **no tools or read domains**.
Select its model through normal reviewed Agent Markdown (including a smaller
configured model if wanted); this uses the real service session's inference
runtime, not an invented user/exec identity. Create a dedicated binding whose
channel target is the intended output audience, with `participants` all empty,
`tools:[]`, `readDomains:[]`, `manage:false`, `inheritThreads:false`. Add:

```json
{
  "observation": {
    "enabled": false,
    "guildId": "<resolved guild snowflake>",
    "channelIds": ["<resolved channel A>", "<resolved channel B>", "<resolved channel C>"],
    "audienceChannelId": "<same channel as this dedicated binding target>",
    "processor": {"code": "<checked frozen bundle>", "delayMs": 1000, "includeBots": false}
  }
}
```

The placeholders are explanatory, not valid snowflakes. Resolve real locations
through directory; inspect the audience's membership/privacy with the owner.
Human review explicitly authorizes the selected evidence to that output audience;
participant lists do not determine who can read channel replies. Scope source
channels must all be in the same guild, unique and explicit (2..20); no inherited
threads, wildcard channels, other guilds or implicit output destinations.

`observation_propose` uses the same local frozen compiler as ordinary processors:
`{action:"observation_propose",path:"processor.ts",bindingId,baseRevision,
delayMs:1000,guildId,channelIds,enabled:false,includeBots:false}`. It only drafts an
existing dedicated binding; changing to enabled true requires another exact
human-reviewed proposal. The local API can draft enabled true too when explicitly
requested, but never approves it. No test here activates a real Discord deployment.

Execution path:
1. Managed gateway gets candidate scopes separately from `admit`. Bot visibility
   for every exact source channel and output audience is checked; observed sender
   need not be a participant. Self is always excluded; other bots need opt-in.
2. Restricted worker runs with bounded scope/revision/guild/sender state. Plain
   emit is not enough: a service wake requires `{action:"emit",semantic:{type,data}}`.
3. Host checks the current scope, every triggering original item, and all live
   observation/output permissions again. It creates a host-held admission bound
   to the complete event input and dedicated service session ID. No user source,
   user admission, observed-sender execution context, global subscription or
   fabricated tool call is created.
4. Only `discord-observation:<project>:<binding UUID>` receives this evidence. It
   has its own epoch/history/private domain and **zero tools or delegation**.
   The execution/output principal is the Bot. Before inference/output and final
   delivery, scope revision, connection, visibility and explicit audience are
   checked again. Scope/Agent changes reset context and invalidate active work.
   Forged user/event inputs and modified output addresses are rejected.

`examples/discord-observation/{processor,signature}.ts` is the actual multi-file
campaign program, not adapter-specific hardcoding. It requires exactly four
images per post and conservative matching text + MIME/dimensions/byte-size
metadata in **three distinct selected channels within 20 seconds**. A single
four-image post does not trigger. Detection emits immediately on the third
channel, with a 60-second cooldown; raw IDs, state and cooldown survive adapter
restart. Filenames/URLs are not visual hashes; crops/re-encodings and visually
similar images with different metadata are not recognized. The implementation
must not be advertised as perceptual image recognition.

Fetch `processor_resource` names `observation/processor.ts`, `observation/signature.ts`,
and `observation/fixtures.json` from a non-repository cwd, or copy those three example files. Run `processor_check`, then
`processor_test` with `fixtures.json`; expected outputs include the semantic event.
The review freezes every dependency and bundled program just as for ordinary
processors. Durable observation inboxes are private per Bot and separate from
ordinary question inboxes. Delivery remains at-least-once admission, not
exactly-once model execution; the Discord gateway itself has no reliable replay
contract after host capacity rejection. Accepted service turns use the ordinary
session recovery machinery; an old event does not regain a service admission
merely from persisted content, so failed/revoked contexts fail closed rather than
reconstructing permission from a journal.

### Independently reviewed small-model classification (default absent/off)

Raw processors still cannot call node infer, tools, imports, host modules or network. A separate
InputClassifier service uses the existing LLMProvider.chat contract with empty tools and a fixed
bounded system prompt. It has no session, turn, exec identity, history or delegation. Only an
owner-reviewed observation processor can receive this grant; ordinary TS remains unchanged.
No classifier policy means no model calls. Model selection is exclusively the reviewed policy,
verified against the live provider model catalog before dispatch. External event data cannot
select a provider/model or override the instructions, schema, budget or deadline.

Fetch processor_resource names classifier/processor.ts, classifier/policy.json and
classifier/fixtures.json into any private non-repository cwd. These match
examples/discord-classifier exactly. Run processor_check and processor_test as usual. The
fixture classifier section contains {policy,responses:[JSON strings]}; it executes the actual
host service contract through an in-memory fake provider, with a temporary private ledger,
never runtime inference or external calls. Test results include modelCalls. Replace the policy
model placeholder with an already configured exact catalog ID before proposing real use.

observation_propose accepts optional classifier:<policy JSON object>. This embeds the policy
with the frozen source/dependency/bundle snapshot in the exact bindings.save human review;
proposal alone never activates it, and enabled still defaults false. Inline owner bindings.save
also supports the identical strict policy. A Discord manager cannot grant this capability.

Policy fields (all mandatory, unknown keys rejected):
- model: exact configured ID, 1..256 characters; instructions: reviewed task, 1..4000 characters.
- fields: content and/or attachments only. Input excludes author/channel names, IDs, URLs,
  filenames, other scope state and history. Attachment evidence is only MIME, dimensions and
  byte size, never downloads, image bytes or perceptual identity.
- maxInputBytes: 1..16000 serialized UTF-8 bytes; oversized input is unknown, never truncated.
- maxTokens: 32..1024 output tokens requested from the provider.
- maxRequests: 1..100; maxWindowTokens: 100..1000000; windowMs: 1000..86400000.
  Per exact scope/revision/policy sliding window, reserve UTF-8 bytes of system + selected
  input plus maxTokens as a conservative token bound BEFORE dispatch, never refund unknown
  usage. Provider-reported overruns increase the charge. Provider token enforcement remains
  provider-dependent; this is a dispatch ceiling, not a guaranteed currency/invoice cap.
- deadlineMs: 10..1500 for the complete operation (authorization/catalog/provider included),
  additionally bounded by the processor's two-second worker chain and stop/revocation signals.
- minConfidence: 0..1. Output schema is fixed and strict:
  {label:'ignore'|'buffer'|'semanticwake'|'unknown',confidence:number 0..1}.
  No custom schemas, arbitrary response text, tools or model-selected commands are exposed.

Programs return {action:'ignore',classify:true} only for special cases. The first pass's state
and semantic output are discarded. Host selects minimal input from the original scoped event,
checks live scope/revision/permissions, reserves budget durably, and calls the small model.
It rechecks authorization after the result, then runs the same frozen program again with
classification added to {event,state,now}. The second run cannot classify recursively; emit is
allowed only for semanticwake. Ignore/buffer labels may be routed by reviewed TS; unknown,
low confidence, absent grant, invalid JSON/schema, tool calls, unavailable model, budget
exhaustion, cancellation, revision change, revocation or deadline never implicitly wake the
strong model. Unknown finishes this original input without updating program state. The normal
semantic service wake still independently checks all observation/output permissions.
High-confidence four-image cross-channel rules continue to emit directly without any small
model call. Ordinary questions continue fixed-window buffering. There is no idle polling.

Billing/recovery semantics: a private project classifier-ledger.json in channel-integrations
stores reservation IDs hashed from scope + revision + policy + event ID, before provider dispatch.
Completed classifications are reused, and uncertain/in-flight/failed calls are unknown on
retry or restart; no automatic provider call retry occurs. A crash before actual dispatch can
therefore lose a classification opportunity; a crash after dispatch can have incurred a cost
without a known result. This is deliberately NOT exactly-once billing. Different explicitly
reviewed revisions have separate budgets and may classify the same external ID again. Ledger
capacity is 10000 reservations / 4000000 bytes; exhaustion fails closed, never automatic eviction
of billing dedupe. It currently has no owner reset/inspection UI. Atomic replacement is not an
fsync/power-loss guarantee and assumes one owning project runtime, as with managed Bot state.
Late/uncooperative providers may continue remote computation/billing after local timeout; their
late result cannot wake a service or automatically retry. No credentials, real provider calls,
online enablement, Discord actions or restart are performed by the tests or this delivery.
