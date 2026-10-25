# Discord patrol compatibility tool

Prefer the Project-owned [channel message stream](channel-stream.md) tools:
`channel_directory`, `channel_read`, and `channel_send`. They consume local append
positions, capture admitted passive messages and edits/deletes, and use an explicit
stable logical consumer rather than tying consumption to one session.

`discord_patrol` remains a transitional loadable built-in for trusted persistent
local Web sessions. In production composition:

- `read`, `ack` and `retry` delegate to `channel_read`; `reply` delegates to
  `channel_send`. There is **one** active stream/consumption store, not a second
  API-snowflake patrol cursor pipeline.
- Existing `bot`, `channel`, `batch`, `attempt`, `error`, `key`, `message` and
  `content` arguments are mapped to their generic counterparts. `consumer` may be
  supplied explicitly; if omitted, a legacy session-derived consumer is used for
  compatibility (which does not survive a change of logical session ID).
- Read responses now contain `events`, not the old REST `messages` projection.
  Read never acks; unfinished batches retain their exact event positions.
  `inspect` returns a migration notice; use generic read to inspect its batch.
- Existing API-snowflake cursors and uncertain legacy reply records are retained
  on disk but **not automatically migrated** into local append positions or new
  send keys. Do not repeat old replies under new keys without reconciliation.
  New collection starts with an explicit bounded latest-100 baseline gap.
- `bots`, `directory`, `threads` and `context` retain their Discord discovery/read
  adapters. Channel-specific requests now also enforce existing Bot assignments
  (personal verified-owner DM or configured service channel/thread).
  Directory metadata is not permission to collect arbitrary visible chats.
  Public archived threads still require bounded explicit pagination; private
  archives and complete historical inventories are not supported.

No new permission grant, cron installation or approval workflow is implied. Use
an existing Project Bot/assignment. No real network deployment or production
restart is needed for the synthetic tests. See the stream guide for retention,
collection gaps, idempotent sends and the full supported-platform boundary.
