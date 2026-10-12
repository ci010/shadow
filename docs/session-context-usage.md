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
