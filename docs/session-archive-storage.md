# Cold conversation storage

Ordinary conversation archival is separate from both live SessionState storage
and fresh-automation finalization. It is not a reversible `archived` flag.
[Session cleanup](session-retirement.md) supplies the existing completion,
delivery and preservation assessment; this document specifies storage only.

## Layout and access

Both JSONL and SQLite active backends use the same cold database:
`<sessionsDir>/.conversation-archive-v1/archive.db`. The active backend need not
be converted to SQLite. There is one archive database per Project session
storage directory, not one database per conversation or month.

- `archives`: indexed lightweight directory JSON, a versioned historical state
  snapshot with SHA-256, publication status and an interrupted-transfer journal.
- `segments`: original physical IDs and raw-record counts.
- `blocks`: independently gzip-compressed JSON record arrays with original start
  offsets, record counts, uncompressed lengths and SHA-256 checksums.
- `resources`: distinct Project/folder/workdir references. Ownership checks need
  resources, not full archived states or one entry per historical conversation.

Directory pages do not deserialize full snapshots or read message blocks. Pages
use an opaque `(archivedAt, sessionId)` keyset cursor, not SQL OFFSET. Cold states
are excluded from `getState`, `listAllStates`, live navigation and the automation
summary archive. Direct historical `readArchivedState` resolves them without
inserting them into SessionManager's live maps.

The canonical partial-read interface is `readArchivedLogRange(physicalId,
offset, limit)`. Offsets refer to original **raw records**, not rendered model
messages. Range lookup seeks to the preceding block and reads only overlapping
blocks. Responses may be byte-limited before `limit`; follow `nextOffset` when
present. Logical IDs, physical segment IDs, unknown raw-record fields and tool
call/result ordering survive storage conversion. A missing physical ID returns
null; a corrupt stored block is an error, not empty history.

Existing history readers still work through the archive-aware store iterator.
The legacy `SessionManager.getHistory` reconstructs and sanitizes model history;
its rendered pagination is **not** the bounded raw-range fast path. New archive
consumers should use the dedicated archive endpoints, rather than materializing
and slicing an entire transcript. No archive browser UI or full-text search
index is added in this version.

## Worker and limits

Archive SQLite, gzip and decompression run in a dedicated Node worker. The
worker source is embedded so source execution with tsx and bundled backend builds
use the same code without installing an external worker asset. It is opened
lazily; absent read-only archives do not create files. WAL and FULL synchronous
mode protect publication. A worker busy timeout bounds temporary SQLite lock
contention; worker errors reject pending calls rather than silently retrying an
unknown write. Synchronous store shutdown uses a bounded worker acknowledgement
before returning, so Windows SQLite/WAL handles are released; only teardown
waits on this acknowledgement, not ordinary archival or chat operations.

Worker RPC admission is bounded to 32 queued operations and 32 MiB retained
input. Transfers lock their own logical/physical IDs, not the whole active
store. Unrelated known active IDs bypass archive membership RPCs; their writes
do not wait for the full transfer. Per-ID operation queues and retained input
are bounded too. These caches/locks assume the existing single store writer. Blocks target 256 KiB uncompressed or 1,000
records, while a larger single record can occupy its own block. Raw records and
blocks are limited to approximately 16 MiB, snapshots to 1 MiB, physical segment
index to 4,096, directory pages to 200 rows and raw range requests to 1,000
records. Range responses have an approximately 16 MiB record-content budget.
Oversized or malformed sources fail without publishing or deleting the source.
These are deliberate first-version limits, not silent truncation.

Metadata/record serialization and reading the active source still use the host
store; moving cold SQLite and compression off-thread does not make all work in
an archival transfer free of main-thread CPU cost. No unbounded in-memory cache
of cold snapshots or decompressed transcripts is maintained.

## Publication, cleanup and interruption

1. SessionManager holds the ordinary admission/preparation lock and verifies the
   exact assessed state/history and preservation outputs.
2. The store captures the historical snapshot, serializes mutations, and streams
   strict source records into uncommitted independent blocks. SQLite sources do
   not use the legacy malformed-record-skipping display reader.
3. The worker verifies stored blocks and transactionally publishes the directory,
   snapshot, resource references and a pending source-cleanup record.
4. Cleanup re-verifies the published snapshot and complete block/source-hash
   coverage, then checks source state revision and source record fingerprints
   before removing active logs/state; session files/attachments are not removed.
   This verification also runs during pending recovery: a damaged archive must
   not cause deletion of an intact source.
5. The pending cleanup record is cleared and SessionManager drops its live
   state/cache entry. Published cold IDs reject recreation, append and deletion
   through ordinary store mutation methods.

At initialization only outstanding published cleanup tasks are examined, in
bounded batches, not every archived snapshot. Already-removed sources are
accepted during retry. A source revision or fingerprint conflict fails closed;
newer source data is not overwritten to force a cleanup. An unpublished partial
archive is invisible and can be replaced when that same source is retried.
No automatic full-history import, old-retirement migration, archive sweep or
purge runs at startup. Legacy truncated physical identities are rejected because
source logs may not be exclusively owned.

This is a single-runtime/store-writer protocol. It does not provide a filesystem
transaction against arbitrary external editors or a second process bypassing
the store. Stop competing writers before repair. Backup must use a consistent
SQLite backup procedure or quiesced database/WAL handling, not a live copy of
`archive.db` alone. Attachment files remain separately retained and need their
own backup; archive snapshots are not permission grants.

## Lifecycle and API

Cold history cannot be restored or resumed in place. Start a new conversation
and reference it. Human messages, automation delivery and command preparation
cannot reactivate a cold ID. Legacy reversible retirement receipts retain their
old restore path and are not bulk-migrated. The old deletion API does not purge
a cold archive; this version has no cold purge API or automatic retention timer.

Project-authorized access uses:

- `GET /api/session-archives?limit=50&cursor=...`
- `GET /api/session-archives/<encoded-session-id>`
- `GET /api/session-archives/<encoded-session-id>/records?segmentIndex=0&offset=0&limit=100`

Detail and record reads retain historical folder authorization. Raw record
responses explicitly mark `readOnly: true`. No list/count/full-text scan is
required to open the runtime or fetch one page.

## Verification

```sh
pnpm exec node --import tsx --test src/sessions/conversation-archive_test.ts
pnpm exec node --import tsx --test src/sessions/archive-startup_test.ts
pnpm exec node --import tsx --test src/sessions/retirement_test.ts src/cron/session-cleanup_test.ts
pnpm exec tsc --noEmit
```

Fixtures cover both active backends, restart, exact multi-segment raw reads,
immutable mutation denial, keyset/range index usage, corrupt and malformed data,
large-record/range limits, partial publication/cleanup states, API authorization
and inactive navigation isolation. The startup scaling fixture inserts
1k/10k/100k directory entries with deliberately unreadable state snapshots:
startup and directory access must work without hydrating those snapshots. Its
timings are diagnostics, not hardware-independent latency guarantees or a
realistic compression/full-corpus benchmark. Fault fixtures reconstruct durable
interruption stages; they are not exhaustive power-loss or filesystem-fault
certification. No production conversations are archived by running these tests.
