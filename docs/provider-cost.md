# Provider token cost estimates

Shadow exposes optional `usage.costs: Array<{ amount: number; currency: 'USD' | 'CNY' | 'AI_CREDITS' }>` and `usage.costIncomplete: boolean`, alongside existing token counts on assistant messages and session/delegate totals. These are token-consumption estimates, **not invoices, remaining balances or additional cash charges**. Included allowances, granted balances, taxes, discounts, subscriptions, legacy request-based Copilot plans and non-token services are not calculated.

## Official sources and maintenance

Rates are an explicit exact-model-ID table in `src/providers/cost.ts`, reviewed on **2026-10-18**; GPT-6.1 Sol added and checked against the official table on **2026-10-19**:

- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing): USD per million cache-hit input / cache-miss input / output tokens. Flash off-peak: $0.003 / $0.15 / $0.60; Pro: $0.022 / $0.66 / $1.98. Peak rates are twice these rates.
- [Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing): per-million input, cached input, cache-write and output rates; **1 AI credit = $0.01 USD**. This is token-based pricing, not old premium-request multipliers.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), inspected commit `687f282e8625c6b8d11ff58211a90524be2e4317`: `packages/llm/llm/src/types.ts`, `packages/llm/llm-deepseek/src/translate.ts`, `packages/llm/token-meter/src/turn-usage.ts`. Harness separates uncached input/cache-read/cache-write, tracks durable attempts and preserves missing reports as unknown. Its current DeepSeek adapter uses Anthropic wire semantics. Shadow Chat Completions `prompt_tokens` already includes cache hits: subtract cached input before charging uncached input, do not add it twice. No TypeScript holiday/off-peak pricing implementation was found in that revision.

Update the table and tests when official rates change. There is no automatic remote pricing, fuzzy model matching, exchange conversion or retroactive repricing. Persisted estimates retain their original amount.

## Supported boundaries

- DeepSeek: official `https://api.deepseek.com` origin only, `deepseek-flash`, documented `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` aliases, and `deepseek-v4-pro`. Custom gateways are not assumed to charge official prices.
- DeepSeek off-peak: weekends, and weekday UTC hours outside 01:00–04:00 and 06:00–10:00. During weekday peak windows, Chinese public holidays can change the applicable rate. Without an authoritative holiday calendar, Shadow marks the estimate unknown rather than guessing. Time is taken when the response is received; requests spanning rate boundaries are not invoice-accurate.
- Copilot: GPT-5 mini, GPT-5.3-Codex, GPT-5.4 (including >272K input tier), GPT-5.4 mini/nano, GPT-5.5 (including >272K tier).
- Calculator entries also support Claude Haiku 4.5, Sonnet 4/4.6, Opus 4.8/5/5.5 and GPT-6 Astra (including >272K tier). Explicit valid normalized `cacheWriteTokens` (including zero) enables the complete token estimate. When only writes are missing, and the write rate is at least the ordinary input rate, Shadow charges non-cache-read input at the ordinary input rate: this is a **lower bound**, with `costIncomplete: true`, not an exact total. Current Copilot Chat/Responses transports have no verified cache-write HTTP mapping; no field is guessed. [Copilot CLI SDK usage documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing) describes a different interface and cannot establish undocumented internal HTTP field names. Fast-mode aliases and other models are not guessed. Unknown prices, absent/partial cache-read reports, and invalid token counts still produce no amount.
- Cache-read reports must be present (explicit zero is valid), complete and valid. Output already includes reasoning tokens, which are not charged twice. Search/fetch, infrastructure and other non-token charges are outside these estimates.

### Additional GPT and Grok coverage (2026-10-19)

Official Copilot pricing also covers the following exact IDs. Rates below are USD per million tokens in **input / cached input / output / cache-write** order; a dash means no separate cache-write charge. AI credits = USD × 100.

| IDs | Standard rates | Long-context input threshold | Long-context rates |
| --- | --- | --- | --- |
| `gpt-5.6-luna` | 0.20 / 0.02 / 1.20 / 0.25 | >200,000 | 0.40 / 0.04 / 1.80 / 0.50 |
| `gpt-5.6-sol` | 4 / 0.40 / 20 / 5 | >272,000 | 8 / 0.80 / 30 / 10 |
| `gpt-5.6-terra` | 2 / 0.20 / 12 / 2.50 | >272,000 | 4 / 0.40 / 18 / 5 |
| `gpt-6-luna` | 0.10 / 0.01 / 0.50 / 0.125 | >272,000 | 0.20 / 0.02 / 0.75 / 0.25 |
| `gpt-6-sol` | 2 / 0.20 / 10 / 2.50 | >272,000 | 4 / 0.40 / 15 / 5 |
| `grok-4.5`, `grok-4.6`, `grok-4.7` | 2 / 0.50 / 6 / — | >200,000 | 4 / 1 / 12 / — |

`gpt-5.6-sol-fast` appears in the user's model picker, but the official Copilot pricing table and supported-model documentation checked on 2026-10-19 do not establish a price for that exact fast variant. It remains explicitly unpriced; regular Sol rates are not silently reused. No guessed fast multiplier is applied.

### GPT-6.1 Sol

`gpt-6.1-sol` (including selection as `gpt-6.1-sol@copilot`) is supported. USD per million tokens, in input / cached input / cache-write / output order: **2 / 0.10 / 2.50 / 10** up to and including 272,000 input tokens; **4 / 0.20 / 5 / 15** above that threshold. Reasoning effort (`low`, etc.) changes token consumption, not these unit prices. With cache reads reported but writes unknown, the existing conservative lower-bound rule applies and the UI displays an incomplete subtotal rather than an exact charge.

A newly added price applies to new provider responses after the backend reloads. Existing historical usage without recorded amounts is not retroactively priced; refreshing the browser alone cannot update the running backend's price table.

## Persistence and compatibility

`cachedTokens` is cache-read input included in `promptTokens`. Optional `cacheWriteTokens` likewise represents writes included in `promptTokens`; absent is unknown. Cache-write aggregates are exposed only with complete reports. Existing `cacheReportedPromptTokens` semantics retain partial cache-read coverage.

The popup and assistant badges label every incomplete amount as a **known cost subtotal (incomplete)**, including aggregates mixed with legacy/unpriced usage; it must not be read as a complete total. If no amount can be calculated, they show **Cost could not be estimated**. With only missing writes this subtotal is a lower bound; with other missing calls its scope is only the known consumption.

Known costs sum **per currency**, never exchanged or combined across units. Mixing priced and legacy/unpriced usage retains the known subtotal and sets `costIncomplete`. Unknown pricing never produces a zero-cost entry. Old records remain readable without migration; absent cost fields mean no estimate. Failed/unreported calls retain existing usage-incomplete behavior, and known cost subtotals are marked incomplete too.

JSONL and SQLite retain extended usage in existing durable message/model-usage records. Existing physical-segment traversal and event-ID deduplication avoid double counting snapshots and duplicate events. Existing session-details and assistant SSE paths carry usage unchanged; no SQLite schema migration is required.

Focused verification: `pnpm exec node --import tsx --test src/providers/cost_test.ts src/providers/deepseek_test.ts src/providers/copilot-protocol_test.ts src/sessions/usage_test.ts src/sessions/session-details_test.ts`.
