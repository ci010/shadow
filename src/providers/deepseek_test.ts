import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { ConfigSchema } from '../config/schema.ts'
import { parseAgentFile } from '../agent/types/parse.ts'
import { DeepSeekProvider } from './deepseek.ts'
import { createAggregatedProvider, createProvider } from './factory.ts'
import { resolveContextWindow } from './model-registry.ts'
import { openaiResponses } from './openai-responses.ts'
import { providerPlugin } from './routes.ts'
import type { ChatMessage, ContentPart, LLMProviderOptions } from './provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'

const model = 'deepseek-flash'
const image: ContentPart = { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj', detail: 'high' } }
const tool: ToolDefinition = {
  type: 'function',
  function: { name: 'inspect', description: 'Inspect fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
}
const completion = () => Response.json({
  model, choices: [{ message: { content: 'Done', reasoning_content: 'Synthetic reasoning' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
})
function harness(t: TestContext, responses: Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown>; init: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(typeof init.body, 'string')
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), init })
    const response = responses.shift()
    assert.ok(response, 'Unexpected request')
    return response
  })
  return calls
}

test('DeepSeek catalog exposes current Flash vision and keeps Chat Completions as its protocol', async () => {
  const provider = new DeepSeekProvider()
  assert.deepEqual(await provider.listModels(), ['deepseek-flash', 'deepseek-v4-pro'])
  const infos = await provider.listModelInfos()
  assert.equal(infos[0].vision, true)
  assert.equal(infos[1].vision, false)
  assert.deepEqual(infos[0].supportedEndpoints, ['/chat/completions'])
  assert.deepEqual(infos[0].reasoningEfforts, ['low', 'high', 'max'])
  for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(resolveContextWindow(`${id}@deepseek`), 1_000_000)
  }
  const aggregate = createAggregatedProvider(ConfigSchema.parse({
    agent: { model: `${model}@deepseek` }, providers: { deepseek: { apiKey: 'synthetic-key' } },
  }))
  assert.deepEqual(await aggregate.listModels(), ['deepseek-flash@deepseek', 'deepseek-v4-pro@deepseek'])
})

test('factory sends user images in native Chat format with configured credentials, tools and abort signal', async (t) => {
  const calls = harness(t, [completion()])
  const provider = createProvider(model, ConfigSchema.parse({
    providers: { deepseek: { apiKey: 'synthetic-key', baseUrl: 'https://api.deepseek.com/v1/' } },
  }))
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Synthetic instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Describe' }, image] },
  ]
  const signal = new AbortController().signal
  const result = await provider.chat(messages, [tool], {
    model, thinking: { type: 'enabled' }, reasoningEffort: 'low', maxTokens: 256, temperature: 0.5, signal,
  })
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer synthetic-key')
  assert.equal(calls[0].init.signal, signal)
  assert.deepEqual(calls[0].body, {
    model, messages, tools: [tool], max_tokens: 256, thinking: { type: 'enabled' }, reasoning_effort: 'low',
  })
  assert.equal(result.content, 'Done')
  assert.equal(result.reasoningContent, 'Synthetic reasoning')
  assert.equal(result.providerState, undefined)
  assert.deepEqual(result.usage, { promptTokens: 8, completionTokens: 4, totalTokens: 12, costIncomplete: true })
})

test('all canonical efforts are forwarded, server defaults stay unset, and thinking off omits effort', async (t) => {
  const options: LLMProviderOptions[] = [
    { model }, ...(['low', 'high', 'max'] as const).map(reasoningEffort => ({ model, reasoningEffort })),
    { model, thinking: { type: 'disabled' }, reasoningEffort: 'max', temperature: 0.2 },
  ]
  const calls = harness(t, options.map(completion))
  const provider = new DeepSeekProvider()
  for (const option of options) await provider.chat([{ role: 'user', content: 'Hello' }], [], option)
  assert.equal('reasoning_effort' in calls[0].body, false)
  assert.equal('thinking' in calls[0].body, false)
  assert.deepEqual(calls.slice(1, 4).map(call => call.body.reasoning_effort), ['low', 'high', 'max'])
  assert.ok(calls.slice(0, 4).every(call => !('temperature' in call.body)))
  assert.deepEqual(calls[4].body.thinking, { type: 'disabled' })
  assert.equal('reasoning_effort' in calls[4].body, false)
  assert.equal(calls[4].body.temperature, 0.2)
})

test('Chat replays reasoning from every assistant turn, preserves tool IDs and strips old Responses metadata', async (t) => {
  const calls = harness(t, [completion()])
  const toolCall: NonNullable<ChatMessage['tool_calls']>[number] = {
    id: 'call_fixture', type: 'function', function: { name: 'inspect', arguments: '{"path":"fixture.txt"}' },
  }
  const messages: ChatMessage[] = [
    { role: 'assistant', content: 'Previous answer', reasoning_content: 'Previous turn reasoning' },
    { role: 'user', content: 'Next turn' },
    {
      role: 'assistant', content: null, reasoning_content: 'Tool reasoning', tool_calls: [toolCall],
      provider_state: { provider: 'deepseek', model, reasoning: [], outputItems: [] },
    },
    { role: 'tool', tool_call_id: toolCall.id, content: 'Fixture contents' },
    { role: 'assistant', content: 'Legacy answer' },
  ]
  const before = structuredClone(messages)
  await new DeepSeekProvider().chat(messages, [tool], { model, reasoningEffort: 'high' })
  const sent = calls[0].body.messages as ChatMessage[]
  assert.equal(sent[0].reasoning_content, 'Previous turn reasoning')
  assert.equal(sent[2].reasoning_content, 'Tool reasoning')
  assert.equal(sent[4].reasoning_content, '')
  assert.deepEqual(sent[2].tool_calls, [toolCall])
  assert.equal(sent[3].tool_call_id, toolCall.id)
  assert.ok(!JSON.stringify(sent).includes('provider_state'))
  assert.deepEqual(messages, before)
})

test('DeepSeek reports cache-hit input tokens and keeps unset cache unreported', async (t) => {
  const reported = [
    {},
    { prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_cache_hit_tokens: 60 },
    { prompt_tokens_details: { cached_tokens: 30 }, prompt_cache_hit_tokens: 60 },
    { prompt_tokens_details: { reasoning_tokens: 9 } },
  ]
  const calls = harness(t, reported.map(extra => Response.json({
    model,
    choices: [{ message: { content: 'Done', reasoning_content: 'Synthetic reasoning' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104, ...extra },
  })))
  const provider = new DeepSeekProvider()
  const results = []
  for (let index = 0; index < reported.length; index++) {
    results.push(await provider.chat([{ role: 'user', content: 'Hello' }], [], { model }))
  }
  assert.equal(calls.length, reported.length)
  assert.deepEqual(results.map(result => result.usage?.cachedTokens), [undefined, 0, 60, 30, undefined])
  assert.deepEqual(results.map(result => result.usage?.promptTokens), reported.map(() => 100))
})

test('parallel tool image results become user images only after every matching tool output', async (t) => {
  const calls = harness(t, [completion()])
  const messages: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: ['one', 'two'].map(id => ({
      id, type: 'function' as const, function: { name: 'inspect', arguments: '{}' },
    })) },
    { role: 'tool', tool_call_id: 'one', name: 'inspect', content: [{ type: 'text', text: 'Screenshot one' }, image] },
    { role: 'tool', tool_call_id: 'two', name: 'inspect', content: [image] },
    { role: 'user', content: 'Compare the screenshots' },
  ]
  const before = structuredClone(messages)
  await new DeepSeekProvider().chat(messages, [tool], { model })
  const sent = calls[0].body.messages as ChatMessage[]
  assert.deepEqual(sent.map(message => message.role), ['assistant', 'tool', 'tool', 'user', 'user'])
  assert.equal(sent[1].tool_call_id, 'one')
  assert.equal(sent[2].tool_call_id, 'two')
  assert.match(String(sent[1].content), /Screenshot one/)
  assert.ok(Array.isArray(sent[3].content))
  assert.deepEqual(sent[3].content.filter(part => part.type === 'image_url'), [image, image])
  assert.deepEqual(messages, before)
})

test('Flash aliases, external URLs and supported data formats retain image parts', async (t) => {
  const ids = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']
  const calls = harness(t, ids.map(completion))
  const content: ContentPart[] = [
    ...['png', 'jpeg', 'gif', 'webp'].map(format => ({ type: 'image_url' as const, image_url: { url: `data:image/${format};base64,c3ludGhldGlj` } })),
    { type: 'image_url', image_url: { url: 'https://fixture.invalid/image.png' } },
  ]
  for (const id of ids) await new DeepSeekProvider().chat([{ role: 'user', content }], [], { model: id })
  assert.deepEqual(calls.map(call => call.body.model), ids)
  assert.ok(calls.every(call => call.url.endsWith('/chat/completions')))
  for (const call of calls) assert.deepEqual((call.body.messages as ChatMessage[])[0].content, content)
})

test('unsupported models, formats and roles fail explicitly before sending or discarding images', async (t) => {
  const calls = harness(t, [])
  const provider = new DeepSeekProvider()
  await assert.rejects(provider.chat([{ role: 'user', content: [image] }], [], { model: 'deepseek-v4-pro' }), /Select deepseek-flash/)
  for (const role of ['system', 'assistant'] as const) {
    await assert.rejects(provider.chat([{ role, content: [image] }], [], { model }), /only supported in user messages or tool results/)
  }
  for (const url of ['data:image/svg+xml;base64,AAAA', 'file:///private.png', `https://fixture.invalid/${'a'.repeat(8192)}`]) {
    await assert.rejects(provider.chat([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }], [], { model }), /JPEG, PNG, GIF or WebP/)
  }
  await assert.rejects(provider.chat([{ role: 'tool', content: [image] }], [], { model }), /missing its call ID/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.chat([], [], { model, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls.length, 0)
})

test('custom gateways preserve their Chat endpoint instead of opting into Responses', async (t) => {
  const calls = harness(t, [completion()])
  await new DeepSeekProvider(model, { baseUrl: 'http://127.0.0.1:1234/v1' }).chat([], [], { model })
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions')
})

test('global config, agent frontmatter and compatible gateway accept low and reject noncanonical effort', async (t) => {
  assert.equal(ConfigSchema.parse({ agent: { reasoningEffort: 'low' } }).agent.reasoningEffort, 'low')
  assert.equal(parseAgentFile('---\nreasoningEffort: low\n---\nSynthetic agent', 'fixture', '.').reasoningEffort, 'low')
  const calls = harness(t, [completion()])
  const app = new Hono()
  providerPlugin(new DeepSeekProvider())(app)
  const send = (fields: Record<string, unknown>) => app.request('/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }], ...fields }),
  })
  for (const fields of [
    { reasoning_effort: 'none' }, { reasoning_effort: false },
    { thinking: { type: 'other' } }, { thinking: { type: 'enabled', extra: true } },
  ]) assert.equal((await send(fields)).status, 400)
  const response = await send({ reasoning_effort: 'low', thinking: { type: 'enabled' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.reasoning_content, 'Synthetic reasoning')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.reasoning_effort, 'low')
})

test('dormant Responses transport still understands persisted DeepSeek plaintext reasoning', async (t) => {
  const item = { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Synthetic retained reasoning' }] }
  const calls = harness(t, [Response.json({ status: 'completed', model, output: [item] }), Response.json({ status: 'completed', model, output: [] })])
  const params = { url: 'https://fixture.invalid/responses', apiKey: 'synthetic-key', providerName: 'deepseek', model, messages: [], tools: [] }
  const first = await openaiResponses(params)
  assert.equal(first.reasoningContent, 'Synthetic retained reasoning')
  await openaiResponses({ ...params, messages: [{ role: 'assistant', content: null, provider_state: first.providerState }] })
  assert.deepEqual(calls[1].body.input, [{ ...item, summary: [] }])
})


test('DeepSeek maps shared medium/xhigh effort to documented high without losing historical reasoning', async (t) => {
  const calls = harness(t, [completion(), completion()])
  for (const reasoningEffort of ['medium', 'xhigh'] as const) {
    await new DeepSeekProvider().chat([
      { role: 'assistant', content: 'Earlier answer', reasoning_content: 'Earlier non-tool reasoning' },
      { role: 'user', content: 'Continue using tools' },
    ], [tool], { model, reasoningEffort })
  }
  for (const call of calls) {
    assert.equal(call.body.reasoning_effort, 'high')
    assert.equal((call.body.messages as ChatMessage[])[0].reasoning_content, 'Earlier non-tool reasoning')
  }
})
