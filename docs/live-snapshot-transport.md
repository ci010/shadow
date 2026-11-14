# Work and knowledge-maintenance live snapshots

The frontend opts into `GET /api/work?transport=snapshot-v1` and
`GET /api/knowledge/maintenance?view=summary&transport=snapshot-v1`. Both remain authorized,
Project-scoped and `Cache-Control: no-store`. Without the query parameter, the
existing JSON contracts remain unchanged; older servers can also serve the new
frontend their legacy responses.

## Contract

The initial response is `{ protocol: "snapshot-v1", version, dictionary, data }`.
Subsequent requests send `since=<last successfully applied version>`. A response
with `base` is a delta against that exact version; without `base` it is a complete
replacement. An unchanged response has an empty change list. Versions include a
route-local random epoch and a content hash: another Project, restarted service,
evicted version or unknown cursor receives a snapshot, never an unrelated delta.
No external persistence or JSONL/SQLite format changes are involved.

`src/shared/snapshot-wire.ts` defines dictionary encoding (tagged string, array
and object nodes) and path changes. A change `[path, value]` sets/replaces a field;
`[path]` deletes it. Keyed session/finding maps plus ordered ID lists preserve
existing consumer array order while avoiding whole-array retransmission when one
session/finding changes. The dictionary encodes repeated strings and field names
once, including repeated finding source titles, messages and targets. This is
lossless, not a truncation of diagnostic findings.

The Work live projection additionally omits focus evidence excerpt `text`/`at`
and internal organizer admission/retry state. Evidence identity and kind remain
available for graph source labels and navigation. Full persisted focus validation
and the legacy endpoint retain excerpts. The live projection still validates
hierarchy and provenance; this is not a relaxation of persisted evidence rules.

Each responder retains at most four prior values within a 16 MiB serialized UTF-8
budget. Oversized values still work but are not retained, so they resnapshot.
The client validates domain data before committing a version, serializes reads,
and retries once without a cursor after malformed/mismatched deltas. Aborted
reads cannot commit. Existing live invalidations and reconnect refreshes continue
to drive reads; no polling is introduced. Legacy POST scan/preview/apply contracts are
unchanged; the UI opts into a lightweight scan result as described below.

## Verification and boundaries

Run `pnpm exec node --import tsx --test src/shared/snapshot-wire_test.ts` for
round-trip encoding, keyed one-session updates, deletions, unchanged responses,
Project isolation, restart/cache misses, malformed-base recovery, cancellation,
legacy fallback and initial payload measurements. Fixtures use 2,322 sessions and
5,979 findings. `app/src/knowledge-maintenance_test.ts` also covers lightweight
status counts, demand loading, stale report rejection, replacement/cancellation,
legacy fallback and scan refresh.

Maintenance initially requests only report metadata, total `findingCount` and
full-report counts by reason, never a partial-page count. The existing Show
findings disclosure lazily requests `/api/knowledge/maintenance/report?reportId=…`.
The server rejects replaced/missing reports with 409; clients discard late results
for an old report/Project. All findings are then available to the existing local
filtering/pagination and source-level repair preview. Scans opt into
`POST /api/knowledge/maintenance/scan?view=summary`; legacy scans still return the
full report. Applying repair invalidates the displayed report and rescans before
loading new details. Summary and full-status transport cursors are separate.

An in-memory measurement of the supplied HAR (no user text committed) yielded:
- Six Work responses: 9,346,391 original JSON bytes → 880,042 snapshot/delta bytes
  (877,826 initial; refreshes 491, 278, 478, 479, 490).
- Maintenance's one available body: 2,669,346 original JSON bytes with 5,979
  findings → 241 summary JSON bytes / 469 initial transport bytes; unchanged 278.
  The full report remains 2,669,296 bytes, transferred only if findings are opened.

These are uncompressed JSON byte counts using HAR bodies, not a live-browser or
compressed-transfer benchmark. Full overview/status generation and domain
validation still occur on refresh, and cached values consume bounded server
memory. Dictionary encoding can increase payload size for unusual collections
with mostly unique very short values.
