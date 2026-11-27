# Project usage and recall

In **Shadow → Usage**, **All projects** uses the host's read-only `GET /api/usage`
endpoint. The host checks context authorization and applies the same authorization
as each Project's `GET /api/project/usage` before merging its result. Unavailable
Projects are shown separately and do not silently contribute zero usage. A single
Project and its daily history use the same local index. Browsing the panel never
opens conversation logs. Costs are estimated, stored in the recorded currencies,
and are not invoices.

The overview, Project/model/tool rankings, and daily trends share one UTC
period selector.
Project and model rankings can compare tokens, recorded estimated cost, provider
calls, or cumulative call time. Tools show result counts only; there is no
reliable token or cost attribution to tools. Choose bars, a ring, or a table
without changing the ranked values. Project/model rings show proportions among
displayed known values; expand to see lower-ranked entries. Tool charts show the
eight most-called tools and combine the rest as Other tools, with shares based on
all recorded calls in the selected scope. The Tool table lists every tool
separately. Model labels separate the model from its provider/account instance;
focus or open the label to see the full identifier, also visible in the table. Daily trends
use matching dates for Today, Past 7 days, and This month, with column, line,
and table views. All time retains cumulative totals and
rankings; its trend explicitly shows only the latest 31 UTC dates sent in the
overview. The separately paginated daily history is unaffected. If an aggregate
refresh crosses midnight UTC, the relative periods follow each Project’s
snapshot date and the trend is hidden until those dates align.
Choosing cost reads recorded estimates instead of converting token counts.
USD includes AI credits at 100:1; CNY is shown separately. Missing estimates
for the selected currency are unavailable, not zero.

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
P50/P95 and a sample count. **Request quality** uses dated indexed requests
up to each Project snapshot within the selected UTC usage period. It
includes outcome counts, observed attempts and the count of requests supplying
attempt data, text-observation categories, input/output/cache tokens and
reporting counts, and sampled latency. Global usage displays per-Project
percentiles and samples, not averages of percentiles. `v:stats/model-requests` reports Project outcomes, observed attempt
counts, cache-token coverage, and P50/P95/sample counts for first text, retry
queue and total elapsed times. Both the usage page and `v:stats/model-requests`
report estimated output speed (`tokens/s`) and its sample count per Project.
The usage breakdown switches between Project and model in one chart. Skill and
Memory reads are separate charts, always grouped by entry and scoped by the
page’s Project filter. All Projects sums the returned entries across Projects.
The usage page charts request outcomes, P50/P95 latency and estimated output
speed by Project, model or provider. Rates across buckets use summed output
tokens and elapsed time, not an average of rates. Latency groups stay separate
per Project; percentiles are not averaged. Expand **Request quality details**
for the underlying counts, observations, latency and token telemetry.
The estimate divides the sum of provider-reported output tokens by the sum of
seconds from the first observed streamed answer text to the end of the successful
attempt. Requests with unknown or zero output tokens, missing stream timing, or a
nonpositive interval are excluded; no samples means unavailable. Existing indexed
records with these fields contribute without a rebuild. This is not a decoder
benchmark or visible-text-only rate: provider token counts can include reasoning
or tool output, and the measured interval can include stream finalization.

## Recall

`v:skills/.stats` and the usage panel count successful initial body reads only
from regular conversation turns. Host-admitted turn source and structured session
ancestry exclude event turns, learning, automation and their descendants (including
Automatic Work). Session-message sender ancestry is checked too. Missing provenance
is unknown, never guessed from agent names or session addresses.

The previous `state/skill-recall.sqlite` is read-only during migration. Old
aggregates and unversioned journal events remain in the legacy tables; they are
not relabeled as regular-conversation reads. Corrected counts start with version-2
events and use separate `skill_recall_v2` / `memory_recall_v2` projections in
`stats.sqlite`. No percentage or recall-rate denominator is inferred. **Skill & Memory reads** appears beside Tool usage (below it on narrow panels).
The Main owner, approved Child workspace UI, and mobile clients can read the
same Main Project usage and recall statistics when authorized for Project usage. Recall returns at most 100 Skill entries or Memory
entry/source pairs per Project. It is cumulative since tracking began, independent
of the selected usage period. It uses the Project-local index, not source logs or
document bodies. Recall is included in the usage summary, not the daily history
endpoint. Child workspace UI requests still require device proof; standalone
Child bearers and unauthenticated requests cannot read Main Project usage. The
page distinguishes unavailable read statistics from available statistics with no entries. `v:stats/memory-recall` remains an
administrator view of the top 100
entry/source pairs. The active source counts successful initial Wiki body reads
under `v:memory`; listing, searches and continuation pages are excluded. The
automatic source is listed separately from active recall and counts log briefings selected into historical prompt context,
not diagnostic previews, lookup indexes or working-set filenames. Neither means the model used the
material, and prompt composition does not prove a request was submitted.

To rebuild, stop the Project before moving aside its `stats.sqlite` (including
SQLite sidecars if present). Retain session logs/archives, the old Skill
baseline, and `state/recall-source.jsonl`, the append-only source for new recall
metadata (including version and origin classification). Restart and let coverage complete.
Replay preserves this classification without consulting mutable current sessions;
legacy events rebuild only the legacy projection. Existing legacy-only database
counts without journal events cannot be recreated, so retain the moved database
as well if those historical counts are needed. Recall stores entry identifiers,
dates, sources and origin classifications only; it does not copy body text or search terms. No recall
history predating the available sources can be reconstructed.
