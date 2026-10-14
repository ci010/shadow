# Session context usage

## Context window settings

The model/effort menu includes **Context window** for the current conversation.
Choose **256K**, **400K**, or **1M**, or **Follow project default** to remove the
conversation override. App settings and Project settings expose the same choices
under Model defaults. Their inherited choice and effective selection are shown
separately; Use inherited values clears overrides when saved.

Priority is **conversation override > Project override > App/global default**.
Omitting all three retains the existing provider/model context-window resolution,
including arbitrary `providers.*.modelContextWindows` metadata. These settings
use decimal tokens: **256000 / 400000 / 1000000**, not binary Ki-token units.
Setting a budget does not grant a provider/model additional capacity; its server
can still reject a request larger than its actual supported limit.

Choices persist in the existing App/Project configuration stores and conversation
state (both JSONL and SQLite). A null API patch removes an override; omission
leaves it unchanged. Draft choices persist with the existing installation/Project/
folder-local draft key. Changes apply to the next turn, not a running response.
Only the three explicit choices are accepted by the settings APIs.

## Capacity and auto handoff

Session details shows the effective conversation budget used by the inference
loop, including models absent from the catalog. A model-only conversation override
does not change this budget. Catalog limits are only a fallback for integrations
without runtime configuration.

The compact capacity bar distinguishes the latest reported prompt from remaining
capacity. Unknown usage is striped and is not treated as empty context. Counts can
exceed the budget; the bar clips at full capacity and displays the overflow separately.
Lifetime and subagent token totals are not added to current context usage.

Low (between turns) and high (during a turn) markers use the same effective budget
as inference and auto handoff. Each turn passes its own budget to the shared
HandoffManager, including the summary loop, without changing that manager's default
for other conversations. With auto handoff disabled the configured window still
shows, but its thresholds do not trigger automatic compaction. The provider's
context-size rejection recovery remains available.

The provider records prompt totals, not independent instruction/history/tool token
counts. The UI labels the aggregate as all prompt content and does not invent
category proportions. This is the last reported selected segment, not a live
estimate of the draft or pending tool results. Historical segment capacity and
handoff policy use current effective conversation settings, not a historical
configuration snapshot.

## Prompt cache reuse and reports

Work changes are ordinary, persisted conversation events.
Each event is appended to history before inference and remains unchanged in later
requests. A newer event of the same type supersedes the older snapshot; it is not
a new human request or an authorization grant. Identical snapshots are omitted,
and changes between inference boundaries coalesce to the latest observed value.
Clearing existing Work appends a clearing event instead of deleting old context.
No timer delays consequential updates. Recent tool receipt IDs already exist in
tool history and are not repeatedly copied into Work events.

Response delivery is specified by the stable execution contract: session finals address
this conversation's reader, task finals report to the configured completion recipient,
and call finals return through the originating tool call. Trusted sender/event envelopes
identify provenance, not recipients or new authorization. Substantive asynchronous
results answer the user's existing request normally; redundant acknowledgements do not
need user-facing text. No response-audience snapshots or per-inference system suffixes
are injected. Legacy audience records remain readable in persisted history but are
explicitly obsolete under the current runtime rules, including after recovery or handoff.
ResponseContext remains display/continuity metadata, not a routing authority.

Remaining execution counts and countdowns are not injected into model prompts.
The host still enforces inference-request limits, nested-inference reservations,
timeouts and cancellation. Do not reintroduce per-request `with*` context wrappers:
context updates belong in immutable history events, not a rewritten system prompt
or a transient suffix. Deduplication is derived from persisted events, so reload
preserves it; a new compacted segment receives a fresh current snapshot.

Response-context parsing is shared with the renderer. Runtime event recognition
lives in the browser-safe `src/sessions/runtime-context-contract.ts`; event
creation and message building remain backend-only in `runtime-context-event.ts`.
Renderer contracts must not import those Node runtime services.

The system prompt is fixed for the entire active session, including idle time
between turns, compaction and Work context replacement. Invalidation affects
preparation before activation or the next activation after sleep/unload, never
rewrites an active snapshot. Tool and authorization checks still run at their
normal boundaries; revoking a capability does not wait for prompt refresh.
Sleep alone does not write a new prompt: reactivation rebuilds it from current
configuration. Model/tool-definition changes and handoff can still change the
overall request prefix; an unchanged prefix does not guarantee a provider hit.

Shadow does not send a `prompt_cache_key`. The session-key experiment did not
improve observed Copilot GPT-6 cache reuse and was removed. Persisting the actual
context events preserves earlier message endings for implicit cache reuse, rather
than discarding a temporary suffix on the next request. No explicit cache
breakpoint policy is enabled. Actual cache hits still depend on the provider and
must be measured after deployment; prefix regression tests do not prove a hit.

Cache-read totals preserve explicit zero and distinguish absent reports from
reported misses. When only some calls report cache usage, details show the known
cache-read total and the covered input-token count as a **partial cache report**.
The displayed hit rate divides known cache reads by covered inputs only, not all
session inputs. Calls without any usage make token totals explicitly partial.
Old JSONL and SQLite records need no rewrite: coverage is computed while reading
existing usage records. Missing historical cache counts remain unknown.
