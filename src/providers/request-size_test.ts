import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trace, type Attributes, type Span } from '@opentelemetry/api'
import { openaiResponses } from './openai-responses.ts'
import type { ChatMessage } from './provider.ts'
import { AnthropicProvider } from './anthropic.ts'
import { openaiChat } from './openai-compatible.ts'
import { ProviderHttpError, isContextSizeError } from './provider.ts'

for (const body of ['html', 'empty', 'unreadable']) {
  test(`chat completions HTTP 413 (${body}) is recoverable and never retried`, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return new Response(body === 'html' ? '<html>Request too large</html>' : body === 'empty' ? null : new ReadableStream({
        start(controller) { controller.error(new TypeError('body failed')) },
      }), { status: 413 })
    })
    await assert.rejects(openaiChat({ url: 'https://fixture.invalid/chat/completions', apiKey: 'fixture', model: 'fixture', messages: [], tools: [] }), error =>
      error instanceof ProviderHttpError && error.status === 413 && isContextSizeError(error))
    assert.equal(calls, 1)
  })
}

test('Anthropic HTTP 413 remains recoverable with an unreadable body', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('body failed')) } }), { status: 413 })
  })
  const provider = new AnthropicProvider({ apiKey: 'fixture', baseUrl: 'https://fixture.invalid' })
  await assert.rejects(provider.chat([], [], { model: 'fixture' }), error =>
    error instanceof ProviderHttpError && error.status === 413 && isContextSizeError(error))
  assert.equal(calls, 1)
})

for (const protocol of ['chat', 'responses'] as const) {
  test(`${protocol} records exact outbound UTF-8 bytes even for rejected requests, without content`, async (t) => {
    const attributes: Attributes = {}
    t.mock.method(trace, 'getActiveSpan', () => ({
      setAttributes(value: Attributes) { Object.assign(attributes, value) },
    }) as unknown as Span)
    let sent = ''
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      sent = init.body as string
      return new Response('{}', { status: 408 })
    })
    const messages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: '检查图片🔎' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ] }]
    const params = {
      url: 'https://synthetic.invalid/test', apiKey: 'synthetic-private-key',
      model: 'synthetic-model', providerName: 'copilot', messages, tools: [],
    }
    await assert.rejects(() => protocol === 'chat' ? openaiChat(params) : openaiResponses(params), /HTTP 408/)
    assert.equal(attributes['llm.request.body_bytes'], Buffer.byteLength(sent, 'utf8'))
    assert.ok(Buffer.byteLength(sent, 'utf8') > sent.length)
    assert.doesNotMatch(JSON.stringify(attributes), /AQID|检查|synthetic-private-key/)
  })
}
