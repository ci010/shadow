import assert from 'node:assert/strict'
import { test } from 'node:test'
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
