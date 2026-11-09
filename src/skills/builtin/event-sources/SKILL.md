---
name: event-sources
description: Author and reload programmable REST/HTML EventSourceProviders with shared instances and per-session processors. Use for external changes such as a GitHub issue closing.
metadata:
  core: true
  category: scheduling
---

# Consume an existing source first

Read `v:events/` for the concise catalog, then `v:events/providers/<id>`.
Each provider is ONE complete consumer file, not a directory: capabilities and
unsupported behavior, demand/event schemas and examples, delivery semantics,
applicable versions with minimal instance availability, and exact subscribe calls.
Read only this contract for consumption; do not fetch implementation/configuration
just to subscribe. A version section applies only to its listed instances, not
blindly the latest revision. No available instance means setup is needed; do not
invent one or promise monitoring. Discover `event_provider` under `v:tools/events`
and read its live contract. Subscriptions require direct user input and deliver to self.

# Explicit authoring and management

Only when authoring/debugging, read/list/search
`v:events/authoring/providers/<id>/revisions/<version>/manifest.json` and `source.ts`.
Schemas/examples have one source in the manifest; `consumer` contains authored
`summary`, optional short `unsupported` catalog text, `capabilities`, `limitations`, `semantics` (never extracted from code).
Supply accurate concise consumer metadata and examples for executable subscriptions.
Old manifests without it remain usable but display “not documented” defaults.
Optional instance `purpose` is a short consumer-safe description, never a binding.
`v:events/instances` and `subscriptions` are explicit Project-wide management views
for configuration, processors and status. Detailed pending diagnostics are under
`v:events/authoring/subscriptions/<id>/diagnostics.json`. Root recursive search is
consumer-only; explicitly search authoring to find code. This is progressive
disclosure, not an access boundary. Views are read-only generated runtime snapshots,
not new persistence. Use ordinary read offset/limit paging.
Provider discover/inspect/share actions are removed. All eligible local sessions
in the same Project can use existing instances and manage pause/resume/reload;
subscriptions always deliver to self and only their subscriber may unsubscribe.
Native collection does not depend on creator availability. Existing explicit
managed-browser authority is still required for browser bind/rebind and collection;
Project visibility does not grant cookies or another session's browser authority. See
`docs/event-source-providers.md` in the Shadow source for complete working REST
cursor and public HTML examples. Write a local JSON manifest and adjacent `.ts`
module, then `event_provider({action:"reload",path:"providers/source.json"})`.
Code edit/reload needs no extra approval; actual instance/network/credential and
subscription bindings retain the tool's direct-user authority checks. Definitions
alone grant no IO. Instances retain immutable HTTP permissions across reload;
a new origin, route, method, query/body schema or credential header requires a
separately authorized instance. Public sources need no secret. Scripts import
`{call} from '@shadow/fetch'`, passing `{method,path,query?,body?,idempotencyKey?}`
and receiving `{status,body}` (JSON or bounded text). GitHub uses the same broker with fixed read-only
GraphQL query/body constraints owned by its adapter and host-injected PAT; it uses the standard `{method,path,body}` API too. A host-bound route `effect:"read"` is a trusted acquisition assertion allowing fresh POST polls without mutation receipts, not proof inferred from HTTP or a per-call override. All other non-GET calls require stable idempotency keys. Providers and subscriber processors may
also import `{parseHtml} from '@shadow/html'` for pure local static HTML parsing:
`parseHtml(html).querySelector('h1')?.textContent`, `querySelectorAll(css)`,
`element.getAttribute(name)`, and bounded `element.getHtml()` outer fragments.
Cheerio is internal, not an arbitrary npm import grant. Limits: 1 MiB UTF-8 input,
1024-code-unit selectors, 256 nodes per querySelectorAll, 64 KiB fragments;
violations throw rather than truncate. Text includes script/style source (never
executed). No live browser DOM or dynamic JS-site execution is provided by this
parser. Processors still have no IO capabilities. See the provider documentation
for malformed HTML, entity and selector semantics.

# Internal runtime events

For cron, channel and background-task events, read `v:events/internal/sources`
and `v:events/internal/` for registered sources and your subscriptions. Discover
`event_subscribe` under `v:tools/events` and invoke its live contract. These
EventService subscriptions are separate from external provider subscriptions.
