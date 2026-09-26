---
name: event-sources
description: Create persistent, user-requested polling event sources and subscribe sessions to their events. Use for external changes such as a GitHub issue closing.
metadata:
  core: true
  category: scheduling
---

# Polling event sources

Read `v:events/sources` and `v:events` first. Existing channel, cron, or
custom sources may already produce the event. The event tools are dynamically
available, not part of the base tool list: use
`search({space:"glob:v:tools/events", query:"**"})` to discover both
`event_source` and `event_subscribe`; read the returned paths for the current
schemas. Invoke by exact name with `invoke_tool({name:"event_source",args:{...}})`
or `invoke_tool({name:"event_subscribe",args:{...}})`. The first invocation
loads that tool for the session; reading this skill does not install code or
start a producer. Source creation, removal, and manual runs require a direct
user turn in a local, durable Project conversation, not a peer/event/task turn.

`invoke_tool({name:"event_source",args:{action:"create",id,code,grant_json,interval_seconds}})`
creates an immutable source. `id` is lowercase letters, digits, `_` or `-`,
starting with a letter. Intervals are 30–86400 seconds. The source emits under
`custom:<id>`. A duplicate ID is rejected; there is no in-place permission
change. Do not silently remove/recreate a source to change its grant: obtain
direct user confirmation of the new permission first.

The source code is a self-contained JS/TS module exporting
`async function run({checkpoint})`. It may import only
`{ fetch } from '@shadow/fetch'`. This `fetch(path, options?)` uses a Project
HTTP grant; `path` is absolute within the granted HTTPS origin, `options`
supports `method` (default GET), `query`, and (where granted) `body` and
`idempotencyKey`. It does **not** accept full URLs, credentials, custom headers,
or native filesystem/network imports. It returns `{status, body}`.
The credential stays with the host broker.

Return `{events, checkpoint}`. Each event is
`{id, type, content, meta?}`. `id` must be a stable external occurrence ID,
not a random ID generated each poll. On first run, establish an initial
checkpoint without announcing old events unless the user explicitly requested
historical events. Store sufficient cursor information to catch every change
between polls; paginate external APIs when needed. Handle API failures by
throwing, not by advancing the checkpoint or reporting success. Max 100 events
per poll; if more remain, leave the cursor before the unprocessed events.

`grant_json` is a JSON string with an HTTP grant named `fetch`. For example,
`{"id":"fetch","kind":"http","origin":"https://api.github.com","routes":[{"method":"GET","path":"/repos/owner/repo/issues/123/events"}],"credential":{"secretRef":"github-issues","header":"Authorization","prefix":"Bearer "}}`.
Use the Project's existing credential *reference*, never its value in code,
arguments, output, or history. Missing references must be provisioned privately
before source creation. Use an exact read route for one issue; don't request
broad API access by default.

After creating the source, subscribe with
`invoke_tool({name:"event_subscribe",args:{action:"subscribe",event:"github.issue.closed",source:"custom:<id>"}})`.
Use `invoke_tool({name:"event_source",args:{action:"run",id}})` to establish the initial checkpoint,
then inspect `v:events` and report the source ID, interval and subscription ID.
`invoke_tool({name:"event_source",args:{action:"list"}})` shows owned sources without their code or
checkpoint. `invoke_tool({name:"event_source",args:{action:"remove",id}})` stops and removes the source;
unsubscribe separately with the subscription ID. Removing a source does not
erase existing session history.

The Project backend must remain running for polling. Scripts run in disposable
child processes; subscriptions and checkpoints survive restarts. The delivery
contract is at-least-once, not exactly-once: a crash between acceptance and
checkpoint persistence can redeliver an occurrence.
