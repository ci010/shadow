# Flash providers

- DeepSeek V4.1 Flash uses the official API ID `deepseek-flash`, not `deepseek-v4.1-flash`. The existing `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` aliases remain usable for saved configurations; the service routes them to V4.1 Flash. The picker advertises the current ID. Context: 1M; vision supported.
- Agnes AI is built in with base URL `https://apihub.agnes-ai.com/v1`, `AGNES_API_KEY` or `providers.agnes.apiKey`, and API IDs `agnes-3.0-flash` / `agnes-2.5-flash`. Documentation URL slugs `30` and `25` are not API model IDs. Both have 512K context and image URL input. 3.0 documents exactly 65,536 maximum output tokens; 2.5 only states rounded 65.5K.
- Agnes uses Chat Completions with `chat_template_kwargs.enable_thinking=true` by default; explicitly disabling thinking sends `false`. Shared reasoning-effort settings are not forwarded because Agnes does not document that field. DeepSeek keeps its native thinking switch and maps shared `medium` / `xhigh` efforts to `high`.
- Provider-returned reasoning is displayed by the existing expandable thinking UI. DeepSeek plaintext reasoning is replayed from every assistant turn when tools are supplied. Agnes returned reasoning is display-only: its Chat documentation does not promise a reasoning replay protocol.
- Cache hit rate uses reported cached input tokens divided by input tokens. OpenAI-compatible `prompt_tokens_details.cached_tokens` and DeepSeek `prompt_cache_hit_tokens` are supported by the existing usage pipeline. Missing cache data stays “Not reported”; explicit zero means zero hits. No cache usage is inferred from pricing or thinking settings.

## Evidence and limitations

Official references inspected:

- https://api-docs.deepseek.com/quick_start/pricing
- https://agnes-ai.com/zh-Hans/docs/agnes-30-flash
- https://agnes-ai.com/zh-Hans/docs/agnes-25-flash

Agnes documents Chat thinking requests but does not show a Chat reasoning response or cache-token extension in its basic response examples. Its Messages API documents cache-read/write fields, but the built-in integration uses Chat Completions only. Returned compatible reasoning/cache fields are handled if actually present; their presence is not guaranteed. Tests use synthetic authenticated-request fixtures, not real API credentials or billable calls.
