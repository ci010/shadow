# Project usage and recall

In **Shadow → Usage**, **All projects** uses the host's read-only `GET /api/usage`
endpoint. The host checks context authorization and applies the same authorization
as each Project's `GET /api/project/usage` before merging its result. Unavailable
Projects are shown separately and do not silently contribute zero usage. A single
Project and its daily history use the same local index. Browsing the panel never
opens conversation logs. Costs are estimated, stored in the recorded currencies,
and are not invoices.

## Sources and coverage

Each Project stores its own `state/stats.sqlite`. SQLite and JSONL session records
remain the source; Automation execution state and diagnostic telemetry are not
moved. A completed provider call or recorded tool result is indexed after the
source write succeeds. Models deduplicate on logical session ID and usage-event
ID; tools deduplicate on logical session ID and result call ID. The Tool ranking
can resolve recorded wrapper targets, so its counts can differ from session and
Automation profiles, which count distinct result IDs. Neither counts tool
attempts interrupted before a result was recorded.

The runtime backfills raw physical logs in the background, including cold
archives. It deduplicates replayed rows and persists a completion checkpoint per
segment. An interrupted or changed segment can be replayed; partial history is
not repaired on request. Older assistant token snapshots are not model requests.
A complete index only means the backfill finished, not that older providers
reported cost, tokens or timing. Undated calls are excluded from date windows.
Daily model and tool aggregates use UTC; exact as-of and 24-hour windows use details.
`v:stats/project`, session profiles and Automation usage retain their original
scope/lineage and time-window meanings. `v:stats/usage` shows the calendar view.

## Request metrics

`model_usage` continues to mean one completed **logical** `provider.chat`
invocation, including failure and cancellation. The index retains its recorded
outcome, total elapsed time, input/output/cache usage and reported cost. Observed
provider retries are separate attempt summaries, linked to the logical request;
unsupported providers or old rows do not imply one transport attempt. The common
retry scheduler tracks actual wait time (including retry backoff), separately
from request preparation and provider elapsed time.

For supported streams (OpenAI Responses and DeepSeek Account), first-text
latency runs from the observed attempt dispatch to the first nonblank answer
text in the stream. It **does not** measure rendering, delivery or thinking/tool
chunks; Shadow can buffer the complete response before displaying it. The
successful logical request's last attempt supplies the sample. Nonstreaming,
tool-only, unsupported and historical requests without observations do not use
total elapsed time as a substitute. Project first-text summaries use nearest-rank
P50/P95 and a sample count, all time; the global view does not average Project
percentiles. `v:stats/model-requests` reports Project outcomes, observed attempt
counts, cache-token coverage, and P50/P95/sample counts for first text, retry
queue and total elapsed times.

## Recall

`v:skills/.stats` retains successful initial body-read totals. The previous
`state/skill-recall.sqlite` is read-only as a legacy baseline during migration;
old counts have no historical day attribution. New recalls are indexed in
`stats.sqlite`. `v:stats/memory-recall` is an administrator view of the top 100
entry/source pairs. The active source counts successful initial Wiki body reads
under `v:memory`; listing, searches and continuation pages are excluded. The
automatic source counts log briefings selected into historical prompt context,
not diagnostic previews, lookup indexes or working-set filenames. Neither means the model used the
material, and prompt composition does not prove a request was submitted.

To rebuild, stop the Project before moving aside its `stats.sqlite` (including
SQLite sidecars if present). Retain session logs/archives, the old Skill
baseline, and `state/recall-source.jsonl`, the append-only source for new recall
metadata. Restart and let coverage complete. Recall stores entry identifiers,
dates and sources only; it does not copy body text or search terms. No recall
history predating the available sources can be reconstructed.
