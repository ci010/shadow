import { AggregatedProvider } from './aggregated.ts'
import type {
  ChatMessage,
  LLMProvider,
  LLMProviderOptions,
} from './provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { ProviderSetupStatus } from './setup.ts'
import { isReasoningEffort } from '../agent/llm-config.ts'
import { ProviderHttpError } from './provider.ts'

export function providerPlugin(
  source: LLMProvider | undefined | (() => LLMProvider | undefined),
  readiness?: () => Promise<ProviderSetupStatus>,
): GatewayPlugin {
  const current = () => typeof source === 'function' ? source() : source
  return (app) => {
    app.get('/api/models', async (c) => {
      const provider = current()
      const models = await (provider?.listModels() ?? [])
      const infos = provider?.listModelInfos
        ? await provider.listModelInfos()
        : models.map((id) => ({ id }))
      return c.json({ models, infos, ...(provider instanceof AggregatedProvider ? { providers: provider.instances } : {}) }, 200)
    })

    // ── OpenAI-compatible LLM API ────────────────────────────────────────────

    app.get('/v1/models', async (c) => {
      const provider = current()
      const models = await (provider?.listModels() ?? [])
      return c.json({
        object: 'list',
        data: models.map((id) => {
          const at = id.lastIndexOf('@')
          const ownedBy = at > 0
            ? id.slice(at + 1)
            : (provider?.name ?? 'unknown')
          return { id, object: 'model' as const, created: 0, owned_by: ownedBy }
        }),
      })
    })

    app.post('/v1/chat/completions', async (c) => {
      const provider = current()
      if (!provider) return c.json({ error: 'provider_unavailable' }, 501)
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_json' }, 400)
      }
      if (typeof body.model !== 'string' || !body.model.includes('@')) {
        const setup = await readiness?.()
        if (setup && !setup.ready) return c.json({ error: 'provider_setup_required', setup }, 409)
      }
      const messages = (body.messages ?? []) as ChatMessage[]
      const tools = (body.tools ?? []) as ToolDefinition[]
      if (typeof body.model !== 'string' || !body.model.trim()) {
        return c.json({ error: 'model_required' }, 400)
      }
      if (body.reasoning_effort !== undefined && !isReasoningEffort(body.reasoning_effort)) {
        return c.json({ error: 'invalid_reasoning_effort' }, 400)
      }
      const thinking = body.thinking
      if (thinking !== undefined && (
        typeof thinking !== 'object' || thinking === null || Array.isArray(thinking) ||
        !('type' in thinking) || (thinking.type !== 'enabled' && thinking.type !== 'disabled') ||
        Object.keys(thinking).length !== 1
      )) return c.json({ error: 'invalid_thinking' }, 400)
      const options: LLMProviderOptions = {
        model: body.model,
        signal: c.req.raw.signal,
        maxTokens: typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined,
        temperature: typeof body.temperature === 'number'
          ? body.temperature
          : undefined,
        reasoningEffort: isReasoningEffort(body.reasoning_effort) ? body.reasoning_effort : undefined,
        thinking: thinking && typeof thinking === 'object' && 'type' in thinking
          && (thinking.type === 'enabled' || thinking.type === 'disabled') ? { type: thinking.type } : undefined,
      }
      try {
        const result = await provider.chat(messages, tools, options)
        return c.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: result.model ?? options.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
              ...(result.reasoningContent != null ? { reasoning_content: result.reasoningContent } : {}),
              ...(result.providerState ? { provider_state: result.providerState } : {}),
              ...(result.toolCalls.length > 0
                ? {
                  tool_calls: result.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                    },
                  })),
                }
                : {}),
            },
            finish_reason: result.toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: result.usage
            ? {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
            }
            : undefined,
        })
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status === 400
          && (err.code === 'unsupported_reasoning_effort' || err.code === 'model_not_supported' || err.code === 'unsupported_api_for_model')) {
          return c.json({ error: err.code, detail: err.message }, 400)
        }
        return c.json({
          error: 'chat_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 500)
      }
    })
  }
}
