---
name: profiling
description: "Read session usage, conversation token statistics and automation 用量 through on-demand virtual files; no telemetry tool or model calls."
metadata:
  category: development
---

# Read usage statistics

Use existing read/search capabilities only, when someone requests statistics. This skill adds no tools, permissions, inference calls, automatic self-analysis or background collection.

- `read("v:stats")` describes the available paths in the current Project.
- `search({handler: "glob", path: "v:stats", query: "**"})` lists metadata without scanning event history.
- `read("v:stats/project")` gives the Project total and rolling 24h summary.
- Read a returned `v:stats/sessions/<URL-encoded logical session ID>` for this conversation's own and including-descendants statistics. Use the logical ID, not a physical segment ID. For example `web:example` becomes `web%3Aexample`.
- Read `v:stats/automations/<URL-encoded feature ID>` for an automation's aggregation, frequency and run outcomes, such as `system%3Awork-organizer`.

Reads compute bounded source-record aggregates on demand. Normal read line paging applies. Discovery and grep expose path descriptions, not computed totals; read the exact returned path for metrics.

## Interpret, do not invent

Conversation totals include all physical segments of one logical session. Own excludes children; inclusive includes exact descendants once. These scopes overlap: never add own and inclusive or add a parent inclusive count to its children. Project aggregates deduplicate logical sessions. Rolling 24h is UTC `[asOf - 24h, asOf)` by persisted event completion time; automation run outcomes use run start time.

Known numeric zero differs from null/unknown historical usage. Tokens are known subtotals when usage or source coverage is incomplete. Check unknown calls, untracked sessions, scan-cap flags and limitations. Provider completions include failures, not separately counted transport retries; tool counts are recorded distinct results, not every attempted/nested call. Tokens are not cost, duration, quality or cached/reasoning estimates. No model calls are needed to obtain these records.

Only the owning Project and existing authorized session context are available. This is aggregate metadata, not access to private transcripts, prompts, model configuration or secrets. Do not bypass unavailable paths with filesystem/config inspection. Report unavailable coverage rather than requesting new privileges or running an automatic profiling loop.
