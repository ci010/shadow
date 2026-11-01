# External input routing

External input has one in-process source/target router, separate from the Session
mailbox and the runtime/memory event bus. It is not a workflow engine, durable
queue, model classifier, or exactly-once delivery system.

## Contracts and authority

- `input/router.ts` defines generic `InputEnvelope<T, Reply>`: Project, host-assigned
  source `{type,id}`, input ID, kind, topic, payload, optional verified topic ancestry,
  correlation/deduplication key and reply context. A channel address is **not**
  mandatory for arbitrary inputs. Deduplication keys are metadata only; source
  adapters retain their existing replay/deduplication responsibilities.
- Source identity comes from an authenticated/authorized host entrypoint, never
  payload fields. Router subscriptions match exact source, kind and topic (with
  explicitly granted ancestry), and select a BOT or an entry-authorized Session.
  There is no implicit recipient and no broadcast on conflicting owners.
- The router does not interpret content, decide mentions/participants, grant tools,
  run inference, or treat a program signal as a human instruction. The selected
  handler enforces reception policy, then selects/creates/wakes its Session.
- `input/producer.ts` is a **host-only, currently uninstalled extension point**:
  `bindInputProducer` binds immutable source/Project/exact routes and a live host
  authorization check. Producer data cannot choose source, Project, explicit
  target, reply authority or additional routes. This adds no tool, public API,
  arbitrary program execution, scheduler, or automatic permission grants.
  Its synthetic program-signal tests do not demonstrate a live news connector.
- GitHub and other arbitrary source names fit the core envelope. No new GitHub
  connection or GitHub BOT subscription schema is installed by this change.

## Actual platform paths

Production composition in `runtime/main/project-runtime.ts` installs:

1. QQ/Feishu/Discord adapters validate transport data and preserve native reply IDs.
   `ChannelManager` checks Project/connection authority and owner/service purpose.
   QQ/Feishu group preflight consults deployed subscriptions before forwarding;
   Discord `prepareIngress` additionally verifies location/member/role/permission.
   This is security admission: trigger/processor declarations are returned as data,
   not executed at that boundary. QQ/Feishu source preflight can retain bounded
   unassigned-group discovery without evaluating a business trigger.
2. `ChannelInputRouter` adapts admitted channel messages into generic envelopes.
   Web has an explicit Session target. Personal ingress requires the exact verified
   owner and bound direct conversation, then uses an ordinary Session target.
3. Service adapters pass a **lazy strategy callback** to `runReceivePolicy`, not an
   already-computed trigger verdict. `ChannelManager.routeServiceInput` enters the
   same InputRouter and selects a deployed BOT before `bots/input.ts`'s
   `handleBotReceivePolicy` checks its sender policy and invokes that strategy.
   Platform algorithms remain reusable in adapter methods, but their execution is
   owned by this BOT-handler stage: QQ/Feishu trigger evaluation and Discord
   includeBots/cooldown, optional processor and mention trigger cannot run first.
   For QQ/Feishu, the handler also supplies frozen platform-specific `trigger`
   configuration from the selected directory binding. It does not defer a read of
   connection settings; Service QQ no longer consumes connection `triggerMode`.
   Unsubscribed/disabled/conflicting targets never execute the callback.
   `silent` output is filtered without creating Session/history or calling the
   main Agent model; it cannot fall back to an ordinary Agent.
4. The strategy's normalized output passes `ChannelInputRouter.receive` for a live
   subscription recheck, then retains its original `InboundMessage` fields through
   `AgentApp.receiveChannelMessage`, its command boundary, and `SessionManager`.
   Existing service policy/admission checks and restricted tools still apply;
   personal/Web sessions retain ordinary role tools and context. Bot-wide service
   model/inference settings are unchanged.
5. Discord observation first performs source/scope lookup only. Before `observe`
   applies receive rules or builds its live security proof, `runObservationPolicy`
   routes that scope to `handleBotObservationPolicy`. Only that selected handler
   can start the processor and its optional, explicitly budgeted classifier.
   The final wake is routed/rechecked again before isolated observation Session
   delivery; an observation remains evidence, not a human request.
6. The existing InputProcessor has an optional **in-memory host execution scope**,
   rebound on recovery, around every rule/classifier/publish attempt. Discord
   supplies live routing and revision/proof checks. Removing a subscription while
   work is buffered/stopped prevents stored code and classifiers from running on
   retry/recovery, not just the final wake. No queue, persistence format or scheduler
   was added; standalone compatibility adapters without production composition
   retain their direct policy execution.

Channel stream collection is independent. An admitted but non-triggering message
can remain in the bounded stream without becoming Session history. Sources that
never deliver an unmentioned message cannot be made observable by the router.

## Migration and internal boundaries

See [BOT subscriptions](agent-authoring.md#external-input-subscriptions). Missing
`subscriptions` preserves the old binding-derived routes without broadening them;
explicit `[]` closes input even when permission bindings remain configured.
Deployment confirmation includes subscription and trigger changes. Original files
are not silently rewritten; existing single-conversation ownership restrictions
remain. QQ/Feishu binding `trigger` defaults to `mention`. Legacy QQ Service
connection `triggerMode: all` is **not inherited**: preserving that broader behavior
requires explicit `trigger: all` in the BOT binding and normal owner confirmation.
This intentional compatibility narrowing never silently broadens a new BOT.
Personal/standalone QQ keeps its legacy connection option; Feishu keeps its prior
mention/reply/topic default unless the BOT explicitly selects `all`.

`AgentApp` no longer republishes channel content as `channel.message` through
`EventService`. Old persisted channel subscriptions are not deleted, but receive
no channel feed. New subscriptions/emissions using `channel.message` or the reserved
`channel:` source prefix are rejected. There is no automatic migration from broad
Session event watchers into BOT authority. Configure and confirm a BOT subscription
instead; wildcard runtime subscriptions do not observe external channel input.

Session-internal cron, maintenance, memory/runtime notifications, background
completion and their existing EventService/mailbox paths are unchanged. Existing
session-owned polling jobs are not migrated by this work. A future separately
authorized producer may emit external signals through the generic producer
contract; this is not permission to repurpose internal cron as an external source.
