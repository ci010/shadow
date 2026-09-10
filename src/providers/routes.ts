import type {
  ChatMessage,
  LLMProvider,
  LLMProviderOptions,
} from './provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import type { GatewayPlugin } from '../gateway/types.ts'

export function providerPlugin(
  provider: LLMProvider | undefined,
): GatewayPlugin {
  return (app) => {
    app.get('/debug/models', async (c) => {
      const models = await (provider?.listModels() ?? [])
      const infos = provider?.listModelInfos
        ? await provider.listModelInfos()
        : models.map((id) => ({ id }))
      return c.json({ models, infos }, 200)
    })

    // ── OpenAI-compatible LLM API ────────────────────────────────────────────

    app.get('/v1/models', async (c) => {
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
      if (!provider) return c.json({ error: 'provider_unavailable' }, 501)
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_json' }, 400)
      }
      const messages = (body.messages ?? []) as ChatMessage[]
      const tools = (body.tools ?? []) as ToolDefinition[]
      if (typeof body.model !== 'string' || !body.model.trim()) {
        return c.json({ error: 'model_required' }, 400)
      }
      const options: LLMProviderOptions = {
        model: body.model,
        maxTokens: typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined,
        temperature: typeof body.temperature === 'number'
          ? body.temperature
          : undefined,
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
        return c.json({
          error: 'chat_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 500)
      }
    })
  }
}
