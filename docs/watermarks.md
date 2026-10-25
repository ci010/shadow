# Project-owned consumption watermarks

`src/watermarks/` is source/provider/scheduler independent. `Watermarks` persists
consumer/source opaque cursors and batches under Project storage `.watermarks/`.
A batch captures an expected `from` and proposed `to`. Only a successful `ack`
from its current running attempt advances the cursor. `retry` returns running
work to pending without advancing it; every claim needs a new unique attempt ID.
After restart inspect pending/running batches before fetching new input. Recover
an interrupted running attempt with retry, then claim with a fresh ID.

This is at-least-once processing, **not exactly-once external delivery**. A crash
between sending a reply and acknowledgement can repeat a send. Keep external
send idempotency/receipts separate from the consumption cursor. Cursors are
opaque: adapters must validate ordering, source identity and authorization, and
must not acknowledge unseen input. No source messages or credentials are stored
by this core.

## Agent tool

`watermark` is a registered discoverable built-in, invoked through `invoke_tool`.
It requires a current Project session; storage is bound to that Project and the
logical session ID plus the caller's consumer name. It cannot manage learning's
journal, another session's consumer, or grant channel access. Do not use multiple
sessions to share an agent-tool consumer; host adapters can explicitly own a
stable consumer through the core API.

Example arguments (each operation is a separate `watermark` invocation):

- `{ "action": "inspect", "consumer": "discord-review" }`
- `{ "action": "prepare", "consumer": "discord-review", "source": "discord:channel:123", "to": "456" }` (omit `from` for initial null cursor)
- `{ "action": "claim", "consumer": "discord-review", "id": "<returned batch UUID>", "attempt": "<fresh attempt UUID>" }`
- After processing: `{ "action": "ack", "consumer": "discord-review", "id": "<batch UUID>", "attempt": "<same attempt UUID>" }`
- On failure instead: `{ "action": "retry", "consumer": "discord-review", "id": "<batch UUID>", "attempt": "<same attempt UUID>", "error": "Interrupted before processing finished" }`

Subsequent prepare calls supply `from` equal to the inspected cursor. A source
can have only one unfinished batch. Repeated ack by the same successful attempt
is safe. There is no implicit timeout or lock stealing. Source access remains a
separate authorized tool operation.

## Learning compatibility and concurrency

Learning and the generic store both use `ConsumptionCore` for cursor checking,
batch creation/lookup, claiming, acknowledgement/advancement and retry/recovery.
Adapters mutate their existing document; persistence is one journal write, not a
sidecar. Learning supplies numeric source coordinates and its legacy cursor
resolver; the generic store supplies opaque cursors. Its richer
artifacts/events/retry policy and numeric cursor/legacy fallback adapters remain in
`LearningLedger`; the consumption state machine is shared. The existing `.learning/state.v1.json`
format/location and `memory/.reflect-watermark.json` fallback are unchanged:
no progress reset, duplicate sidecar, or cross-file acknowledgement transaction.
Only verified `applied`/`no_change` outcomes finish a learning batch successfully.

Both stores use exclusive file locks and optimistic full-document comparison.
A stale instance fails and must be reconstructed before retrying. Atomic private
file replacement prevents partial JSON visibility; this is not a distributed
transaction or a power-loss fsync guarantee. After a process dies while holding
a `.lock` directory, stop all writers and remove that stale directory manually.
No automatic live-lock stealing is attempted. Completed history is currently
retained without compaction.

## Discord boundary (not implemented by this change)

There is intentionally **no new Discord watermark** and no new Discord access
grant. `src/channels/integration.ts` rejects non-user integration inputs with
`external_input_required`; `integration-contract.ts` defines the isolated
Discord observation service capability surface. The generic agent bookkeeping
tool does not bypass either control or enable cron in service Bot sessions.

A normal Web session awakened by cron still needs an owner-reviewed authorization
path for reading authorized channel messages, enumerating new threads, and
sending replies. This change does not add that grant workflow, so it does not
claim a working end-to-end Discord unread polling feature. Once an authorized
adapter exists it should read message/thread pages through that adapter, prepare
and claim batches in this core, process, then acknowledge. Thread discovery needs
its own source key/cursor, separate from each thread's message cursor. Never
substitute a service Bot cron job for the user's Web-session workflow.

Recovery via the agent tool: `inspect` returns batch IDs, state and full `attempts`
arrays. For a running batch use its last attempt in `retry`, then `claim` with a
fresh UUID. Old acknowledgements are fenced after that claim. Learning also
requires fresh execution-session IDs on retry (its dispatcher creates new runs);
same-session rebinding is rejected rather than accepting potentially stale receipts.
