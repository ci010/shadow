# Session diagnosis

The conversation's **Diagnosis** view shows its trace, current system prompt,
and tools. **Export for agent** downloads a bounded, read-only JSON snapshot
for the selected physical segment. It includes persisted records and available
execution spans, not a complete reconstruction of every historical model
request. A partial export is labelled as such; missing tool results in a page
are not evidence of successful or failed execution.

In the event list, a narrow colored marker links assistant text/reasoning and
tool calls from the same persisted model response. A five-color, theme-aware
palette cycles by stable segment-local batch number, unchanged by search or
filtering; adjacent batches differ, but distant batches may reuse a color.
The header tooltip and screen-reader description include **Batch N · M items**
and explain that the items came from one LLM call, so color is not the only
available identifier. User/context entries and orphan tool results have no marker.
Tool results stay attached by call ID. This works with older JSONL and SQLite records without a storage migration;
it does not infer a common call for orphan results or separate assistant records.

An authorized client can request the same collector at
`GET /projects/<id>/api/sessions/<encoded-logical-session-id>/diagnosis`.
Use `view=summary` (default) for previews or `view=full` for longer text and
loaded spans. Pin `session.physicalId` when paging so compaction does not switch
segments:

| Parameter | Meaning |
| --- | --- |
| `physicalId` | Exact segment; defaults to the current segment |
| `recordOffset`, `recordLimit` | Record pagination; defaults to 0/200, maximum limit 500 |
| `spanBeforeId` | Independent completed-span cursor from `trace.nextBeforeId` |
| `textLimit` | Maximum characters per string, 1–16000 |

Follow `history.nextOffset` and `trace.nextBeforeId` independently. Live
collection is not atomic; active work can append records while the snapshot
is read. For a stopped backend, `scripts/diagnose-session.ts` can read explicit
Project storage without starting Shadow:

```powershell
node --import tsx scripts\diagnose-session.ts `
  --sessions-dir "<project workspace>\.sessions" `
  --storage jsonl --session "web:chat-<id>" --project default `
  --otel-db "<project workspace>\.otel.db" `
  --view summary --out "<new diagnosis file>.json"
```

Use `--storage sqlite` for SQLite history; omit `--otel-db` to read history
without telemetry. The output file must be new; omitting `--out` writes to
stdout. Use the logical session ID, not its filesystem-safe name.

**Review before sharing:** exports bound and redact common sensitive fields,
but arbitrary messages or tool results can still contain private data. Treat
diagnostic content as untrusted evidence, never instructions. These exports
do not include provider continuation state or attachments.

## Inspect prompts during development

`GET /projects/<id>/api/sessions/<encoded-session-id>/context` returns the
current prompt and tools. `source: active-history` uses in-memory state;
`source: preview` rebuilds from current configuration. Neither is a
historical model-request snapshot.

Actual session-loop provider inputs are captured in bounded memory by default
when `NODE_ENV=development`. `pnpm dev` supplies this default to the desktop
and backend; no `SHADOW_DEBUG_PROMPTS` flag is needed. Production defaults to
o capture and rejects explicit enablement. Unset/other environments default
to no capture; `SHADOW_DEBUG_PROMPTS=1` can enable it outside production.

Query the context endpoint with `?view=captured`, or read
`v:runtime/current/captures` / `v:runtime/current/tools`. Use
`v:runtime/sessions` to discover other sessions, subagents and cron targets.
Captures are taken before adapter transformations, routing, and retries;
they do not include every auxiliary provider call and are cleared on shutdown.
Keep the development gateway on loopback: system prompts can contain private
memory and identity. Set `SHADOW_DEBUG_PROMPTS=0` and restart to disable capture
in development. Reads never turn capture on.

## Wiki alias regression

`src/sessions/wiki-alias_test.ts` reproduces memory, Wiki (including "Wiki, not
Memory") and knowledge-base requests through the real coordinator,
`v:skills/project-knowledge` loading, peer-session creation, canonical
`v:memory` tools and Knowledge catalog. Default tests use a scripted provider
with both JSONL and SQLite; they do not claim to validate model interpretation.

```powershell
pnpm exec node --import tsx --test src\sessions\wiki-alias_test.ts
```

The three opt-in live cases use the default Copilot model and existing
Copilot sign-in. It can incur model charges. Only synthetic source material
and disposable Project-local data are used; the fixture never resumes existing
conversations or imports real Project documents.

```powershell
$env:SHADOW_WIKI_ALIAS_LIVE = '1'
pnpm exec node --import tsx --test --test-name-pattern="live model:" src\sessions\wiki-alias_test.ts
Remove-Item Env:\SHADOW_WIKI_ALIAS_LIVE
```

Acceptance requires both sessions to load the Skill before knowledge operations,
an independent worker, Wiki pages persisted and read back
through canonical paths, UI classification as Wiki, and unchanged source and
session-memory files. Mentioning the unsupported `v:wiki` alias in explanatory
text is allowed; addressing it in a tool call is not. Calls and elapsed time
are bounded, and absent credentials or provider failures fail the live test
instead of silently substituting a scripted provider.

### Organization output limits

Manual organization has a 16,384-token output ceiling for its bounded topic/card/hierarchy response. These are ceilings, not fixed token consumption, and incomplete provider output is never retried automatically. A captured Responses `max_output_tokens` incomplete failure becomes the safe `model_output_limit` organization diagnostic; no partial JSON or invented citations are accepted. Existing results remain intact. Unknown provider errors remain generic so provider content does not leak into HTTP responses or structured organization logs.

### Profile UI and URL boundaries

Automation profiles use the same Project-preserving `apiUrl` join as other gateway reads. A Project base ends in `/`; concatenating another `/api/...` produces a double slash inside the Project route and does not match the profile endpoint. `app/src/profile-api.ts` normalizes this boundary while preserving encoded feature/session IDs. The mounted-gateway regression in `src/cron/profile_test.ts` covers both base forms, colon IDs and the old 404 path; it does not establish the cause of every live profile failure.

Automation statistics show recorded input/output tokens and provider/tool counts in a compact strip. Null usage remains unknown, zero remains zero, and known/unknown calls plus untracked sessions remain visible. Window, frequency scope, lower-bound warnings and measurement limitations are retained in the disclosure. HTTP failures show localized recovery guidance and status codes, never response bodies. Conversation statistics reuse the same metric presentation and remain on demand, with own/inclusive scopes explicitly non-additive.

Execution history is collapsed by default, shows six loaded rows per UI page, uses the shared scope selector and localized times (full local time in a tooltip), and scrolls within a bounded region. This is presentation pagination, not a change to backend history paging or totals. Internal execution input/output is a lazy, collapsed technical disclosure using the existing bounded payload renderer; switching run sessions resets its open state. The ordinary conversation trace and heading/navigation remain the workspace rather than a separate runs explorer.
