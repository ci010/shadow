# Client presence and unattended Ask

Presence is advisory, never authentication, approval, or evidence that a person
read a question. `UserPresence` (`src/sessions/presence.ts`) aggregates independent
client reports. The host shares this registry across its Project runtimes.

## Collection and identity

- Each mounted application gets a random client UUID. A 15-second heartbeat sends
  visibility, focus and age since the last trusted pointer/key/wheel/touch event.
  Focus, visibility changes, synthetic events and heartbeats do not count as input.
  No keys, text, mouse coordinates, application names or screen contents are sent.
- Electron's owning-window/main-frame-only IPC samples `powerMonitor` system idle
  seconds and coarse lock state. macOS/Windows lock/unlock events supplement the
  idle-state query. Unsupported/unknown lock state remains unknown. No global
  keyboard hooks are installed. Browser clients do not claim OS idle capability.
- Reports use `/api/chat/presence` with the same gateway authentication, Web
  channel authorization and `allowFrom` check as chat. A strict schema rejects
  body-supplied user IDs. The server assigns the existing Web owner principal
  `web:web-user`, not a caller-chosen account. Current Web authentication represents
  one local owner, including that owner's paired clients; this is **not** a new
  multi-account login system. Other channels have distinct channel/sender keys and
  currently have no presence reporter, so they remain unknown.
- Child/node connection status is never consulted. Only an actual application
  client can report presence; running a remote execution node does not mean a
  human is active. Reports are in memory, not persisted or copied into prompts.

Any fresh active client wins, including Windows activity while a Mac is locked.
Freshness is 45 seconds. Activity means system idle under two minutes (unless
locked), or a visible/focused client with trusted input within two minutes.
All known clients must positively support away (locked, or supported unlocked
system-idle state at least two minutes) for the aggregate to be away. Hidden Web,
missing capability, disconnected/stale clients and no clients are unknown.
One unknown client prevents the away shortcut, but never the fixed deadline.
Stale clients remain conservatively unknown until host restart; there are at most
128 client entries per principal. Capacity eviction marks the principal incomplete
(unknown unless a retained client is active), never all-away. Reloads get new IDs.
Reports are client assertions, not tamper-proof human attestation.

## Waiting policy

For **user-recipient** requests only, the default fixed wait is ten minutes and
continuous confirmed-away grace is thirty seconds:

```json
{
  "tools": {
    "unattended": { "timeoutMs": 600000, "awayGraceMs": 30000 }
  }
}
```

Both values are integer milliseconds, 1..2147483647; `timeoutMs: null` disables
both automatic expiry and away shortening. Explicit existing
`SessionConfig.yield.timeoutMs` takes precedence, then `tools.yield.timeoutMs`,
then `tools.unattended.timeoutMs`. In particular an existing explicit `null`
continues to mean infinite waiting; merely omitting `tools.yield` uses the new
finite default. An explicit empty `tools.yield` object retains its existing
schema default of `null`. Removing a session override returns to global policy.
Policy is captured at opening, so editing configuration affects future requests.

Unknown and active users get the same fixed deadline; activity does not extend
it indefinitely. Away must be continuous; active/unknown resets the away grace.
Away is sampled by a backend timer (up to one-second granularity), never a
frontend countdown. Closing the frontend cannot disable the fixed deadline.
Existing question-discussion timeout pause remains respected. Parent-recipient
and authenticated A2A caller waits retain their existing policy and never consult
presence. Host-specific owner confirmations retain their explicit timeout, but
also fail closed rather than authorizing on timeout.

## Settlement, history and limits

`YieldManager` is the sole decision settlement authority. An unanswered human
request records the existing `closed.reason: deferred` and returns a
`YieldContinuation` with `approved: false`, the original reference, and its
blocked/unaffected scope. No `option`, human answer, or default approval is
invented. The agent may investigate or do already-authorized unaffected work;
the action needing the decision stays blocked. Without a durable journal, expiry
fails with `unavailable` rather than manufacturing a receipt.

Ordinary input expiry records a failed `input_request` close (not an answer).
The Ask tool returns JSON `{kind:"input",status:"unavailable",approved:false,reason}`,
not fabricated user text. Cancellation still follows its existing abort path.
Micro App owner testing confirmations no longer auto-continue after sixty seconds.

Existing pending phase/request-ID guards serialize human replies and expiry
before awaiting persistence. Whichever settlement starts first owns the request;
late/replayed IDs cannot settle a replacement. A journal write failure does not
resume with approval. Existing JSONL and SQLite decision/input fact formats are
reused, including readers for historical timeout answers; no data migration or
rewriting historical human/timeout provenance occurs. Live waiters/presence are
not restored on process restart; old openings are history, never authorization.

Automated coverage: `src/sessions/presence_test.ts`,
`src/sessions/unattended_test.ts`, `src/channels/web-presence_test.ts`,
`app/src/presence_test.ts`, and `desktop/src/presence.node-test.ts`.
Native tests use synthetic powerMonitor events; real macOS/Windows lock/sleep and
cross-device network recovery still require device testing. Mobile/native wrappers
without the desktop API use browser-only evidence.
