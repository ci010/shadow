# Copilot request gzip and HTTP continuation probe — 2026-11-05

## Scope and safeguards

Live verification using one currently configured valid Copilot credential via the existing credential broker and backend macOS system-proxy routing. Credentials were held in memory, never printed or copied into this report. Only synthetic numbered text and a random test marker were transmitted; no session history, attachments, source files or user data were sent. No production configuration or provider behavior was changed. The probe made six inference requests, plus model metadata discovery. This is a point-in-time account/model/endpoint observation, not a universal Copilot API guarantee.

- Auth profile/integration: existing Copilot V2 App OAuth / `copilot-developer-app`.
- Model: `gpt-6-astra`, advertised with `/responses` and `ws:/responses`.
- Tested transport: HTTP POST `/responses`, SSE response, reasoning effort `low`, maximum output 128 tokens.
- Gzip was genuine `gzipSync(JSON.stringify(body))` binary data with `Content-Encoding: gzip` and `Content-Type: application/json`, not just `Accept-Encoding`.
- Cache control and gzip requests had exactly the same uncompressed JSON as the initial baseline, including the same synthetic marker. The third request alone changed request encoding.
- Network time is single-request elapsed time through the configured proxy, not a benchmark.

## Results: gzip preserves reported prompt-cache reuse

| Request | HTTP / completion | JSON bytes | Transmitted body bytes | Input tokens | Cached tokens | Cache write tokens | Elapsed ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain baseline | 200 / completed | 23,880 | 23,880 | 5,485 | 0 | 5,482 | 2,153 |
| Identical plain cache control | 200 / completed | 23,880 | 23,880 | 5,485 | 5,482 | 0 | 2,065 |
| Identical JSON, gzip body | 200 / completed | 23,880 | 1,208 | 5,485 | 5,482 | 0 | 2,783 |

All three returned the requested `ACK`. Reported cache counters came from `usage.input_tokens_details`, not an estimate. Gzip reduced transmitted body bytes by approximately 94.94% on this intentionally repetitive text fixture; the same cached-token count was preserved. Headers, framing and TLS overhead are excluded from byte counts.

This confirms that request gzip works on this tested Copilot HTTP Responses route without losing the cache reuse observed in the plain control. It does **not** establish latency improvement, support for other models/endpoints/proxies, behavior for multi-megabyte inputs, or resolution of the original 408. Already-compressed PNG/JPEG/WebP base64 will generally not achieve the same reduction as repetitive text; gzip does not reduce model context tokens or server-side decoded-body limits.

## Results: HTTP continuation rejected

The continuation fixture used a fresh random marker distinct from the gzip fixture.

1. Seed with `store: false`: HTTP 200 / completed, response ID returned; 23,880 JSON bytes, 5,485 input tokens, 0 cached tokens, 5,482 cache-write tokens, 2,722 ms.
2. Follow-up containing only a new question and `previous_response_id` from that seed: HTTP 400, classified from the server error as `previous_response_id_unsupported`; 664 request bytes, 254 ms. The question requested the earlier marker so that mere HTTP success would not have been treated as proof of recovered context.
3. Seed with `store: true`: HTTP 400, classified from the server error as `store_unsupported`; 23,879 request bytes, 424 ms. No stored follow-up was attempted because the seed was rejected.

A response ID is therefore not sufficient evidence for usable HTTP continuation. Do not enable HTTP `previous_response_id` or `store: true` on the tested route. The advertised WebSocket transport was not tested; these HTTP results must not be generalized to persistent WebSocket connection-local state.

## Recommendation

Use transport gzip as the next implementation candidate for the tested Copilot Responses route, not semantic history compaction. Preserve the exact serialized JSON and existing stateless replay semantics. Before production enablement, add bounded/asynchronous compression, a minimum-size threshold and skip-if-not-smaller rule, cancellation and synthetic protocol tests, plus separate uncompressed JSON / transmitted body byte telemetry. Do not automatically replay requests after uncertain transport failures; any unsupported-encoding fallback must be based on a definitive rejection and a bounded policy.

Current `llm.request.body_bytes` continues to mean serialized uncompressed JSON UTF-8 bytes. Future gzip support must not silently change its meaning. The initial probe itself did not enable gzip. The subsequent source refactor below opts in only the verified Copilot HTTP Responses route; no running service was restarted.

Probe method: an isolated local script using the existing credential broker and native HTTP requests as described above; not a production path. It used synthetic content, printed only aggregate metadata/classified failures, and held response IDs and credentials only in memory. The temporary script is not part of the committed deliverable. Repeating live probes consumes provider quota.

## Subsequent provider refactor and live smoke check

The provider now opts into asynchronous gzip on HTTP `/responses` for final JSON of at least 16 KiB, only if compression is smaller. It uses fast zlib compression and preserves byte-for-byte JSON on decompression. No other providers opt in. The shared request-preparation helper preserves the existing uncompressed byte counter and additionally reports wire-body bytes and content encoding. Preparation is outside retry loops, abort destroys the compression pipeline, and rejection never causes an automatic identity fallback.

A live synthetic call through the refactored `CopilotProviderV2` and its actual adapters successfully dispatched gzip to `/responses` (`gpt-6-astra`, 1,261 transmitted body bytes) and returned the expected `ACK`: 5,485 prompt tokens, 5 completion tokens. This used a fresh marker, so zero cached tokens in this smoke call was expected; cache-preservation evidence remains the controlled identical-JSON experiment above. Different compressed sizes arise from adapter-added fields and fast compression rather than the initial default gzip settings.

Chat Completions remains **uncompressed in production code**. An exploratory gzip request for the advertised `mai-code-2-flash` Chat route returned HTTP 400. A subsequent controlled comparison returned HTTP 400 for **both plain and gzip**. Consequently, this is inconclusive about Chat gzip support, not evidence that compression itself caused rejection. An attempted selection of `gpt-4.1` found no matching advertised Chat endpoint and sent no inference. We do not enable gzip on an unvalidated route and do not substitute another model at runtime.

The exploratory probes were not invoked by application startup or tests. The initial six-request count above describes only the original capability probe, not these subsequent smoke/exploratory calls.

Refactor validation: all 295 provider tests passed, including gzip round-trip/UTF-8/media identity, cancellation, unchanged 429 retry bytes, no replay after HTTP rejection, and provider-level append-only prefix checks. Backend `pnpm build` passed. A backend TypeScript run passed after fixing the gzip Buffer typing; the final repeat was blocked by concurrent, unrelated MicroApps changes (`approval`/`approve`/`revoke` missing in MicroApps scripts/tests and session integration tests), with no gzip-path diagnostics reported. No unrelated MicroApps edits were changed, and the running service was not restarted.
