/**
 * Built-in model context window registry.
 *
 * `contextWindow` is the total token budget the model can hold (prompt + completion),
 * used by `HandoffManager` to decide when to compact the conversation. This is a
 * different concept from `maxTokens` (the per-request completion budget sent as
 * `max_tokens` in the API call).
 *
 * Resolution priority (see `resolveContextWindow`):
 *   1. providers[name].modelContextWindows[model]     — per-model override
 *   2. MODEL_CONTEXT_WINDOWS[model]                   — built-in registry
 *   3. DEFAULT_CONTEXT_WINDOW                         — fallback
 */

export const DEFAULT_CONTEXT_WINDOW = 400_000

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-haiku-3-5-20241022': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-5-20251101': 200_000,
  // Copilot-flavoured aliases
  'claude-sonnet-4.5': 200_000,
  'claude-opus-4.5': 200_000,
  'claude-sonnet-4.6': 200_000,
  'claude-opus-4.6': 200_000,

  // ── OpenAI GPT-4 / GPT-5 family ──────────────────────────────────
  'gpt-4': 8_192,
  'gpt-4-32k': 32_768,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-preview': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'gpt-5-mini': 128_000,
  'gpt-5.2': 200_000,
  'gpt-5.2-codex': 200_000,
  'gpt-5.3-codex': 200_000,

  // ── OpenAI o-series (reasoning) ──────────────────────────────────
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-preview': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,

  // ── Legacy OpenAI ────────────────────────────────────────────────
  'gpt-3.5-turbo': 16_385,
  'gpt-3.5-turbo-16k': 16_385,

  // ── Google Gemini ────────────────────────────────────────────────
  'gemini-1.5-flash': 1_048_576,
  'gemini-1.5-flash-8b': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-2.0-pro': 2_097_152,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-pro': 2_097_152,

  // ── DeepSeek ─────────────────────────────────────────────────────
  'deepseek-chat': 128_000,
  'deepseek-coder': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-v3': 128_000,
  'deepseek-r1': 128_000,
  'deepseek-flash': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
  'deepseek-v4-pro': 1_000_000,

  'agnes-3.0-flash': 512_000,
  'agnes-2.5-flash': 512_000,

  // ── Groq / Llama ─────────────────────────────────────────────────
  'llama-3.1-8b-instant': 128_000,
  'llama-3.1-70b-versatile': 128_000,
  'llama-3.3-70b-versatile': 128_000,
  'llama3-8b-8192': 8_192,
  'llama3-70b-8192': 8_192,
  'mixtral-8x7b-32768': 32_768,
  'gemma2-9b-it': 8_192,

  // ── Moonshot / Kimi ──────────────────────────────────────────────
  'moonshot-v1-8k': 8_192,
  'moonshot-v1-32k': 32_768,
  'moonshot-v1-128k': 128_000,
  'kimi-k2': 128_000,
  'kimi-k2.5': 128_000,

  // ── StepFun ──────────────────────────────────────────────────────
  'step-1-8k': 8_192,
  'step-1-32k': 32_768,
  'step-1-128k': 128_000,
  'step-1-256k': 256_000,
  'step-2-16k': 16_384,
  'step-2-mini': 32_768,
}

export interface ContextWindowOverrides {
  /** Per-model overrides, keyed by model id. Highest priority. */
  modelContextWindows?: Record<string, number>
}

import { parseModelSpec } from './aggregated.ts'

/**
 * Resolve the context window size (in tokens) for a given model.
 *
 * Handles `model@provider` format by stripping the provider suffix before
 * looking up in the registry.
 *
 * @param model The model id (e.g. `'gpt-4o'`, `'claude-sonnet-4.6'`, `'gpt-4o@openai'`).
 * @param overrides Optional per-model overrides from `bot.config.json`.
 */
export function resolveContextWindow(
  model: string | undefined,
  overrides?: ContextWindowOverrides,
): number {
  const bareModel = model ? parseModelSpec(model).model : undefined
  if (bareModel && overrides?.modelContextWindows?.[bareModel] !== undefined) {
    return overrides.modelContextWindows[bareModel]
  }
  if (bareModel && MODEL_CONTEXT_WINDOWS[bareModel] !== undefined) {
    return MODEL_CONTEXT_WINDOWS[bareModel]
  }
  return DEFAULT_CONTEXT_WINDOW
}
