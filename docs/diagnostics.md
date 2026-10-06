# Session diagnosis

The conversation's **Diagnosis** view shows its trace, current system prompt,
and tools. **Export for agent** downloads a bounded, read-only JSON snapshot
for the selected physical segment. It includes persisted records and available
execution spans, not a complete reconstruction of every historical model
request. A partial export is labelled as such; missing tool results in a page
are not evidence of successful or failed execution.

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

For actual session-loop provider inputs, enable the development-only,
in-memory capture **before** starting the backend:

```powershell
$env:SHADOW_DEBUG_PROMPTS = '1'
pnpm dev:server
```

Query the context endpoint with `?view=captured`. Captures are taken before
adapter transformations, routing, and retries; they do not include every
auxiliary provider call. Capture is disabled by default, rejected in
production, and cleared on shutdown. Keep the development gateway on
loopback: system prompts can contain private memory and identity. Unset the
variable (or set it to `0`) and restart to disable capture.

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
