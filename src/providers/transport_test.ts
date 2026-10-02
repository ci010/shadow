import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openaiChat } from './openai-compatible.ts'
import { openaiResponses } from './openai-responses.ts'
import { ProviderTransportError, providerTransportFailure } from './provider.ts'

const options = { url: 'https://synthetic.invalid/model', apiKey: 'synthetic', model: 'fixture', messages: [], tools: [] }
const reset = () => new TypeError('terminated', { cause: Object.assign(new Error('private socket details'), { code: 'UND_ERR_SOCKET' }) })

for (const [name, chat] of [['chat', openaiChat], ['responses', openaiResponses]] as const) {
  test(`${name}: response interruption never replays a paid POST or returns partial tool calls`, async t => {
    let pulls = 0
    const body = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode(name === 'responses'
            ? 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"partial","name":"exec","arguments":"{}"}}\n\n'
            : '{"choices":[{"message":{"tool_calls":[{"id":"partial"'))
        } else controller.error(reset())
      },
    })
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body, {
      headers: { 'content-type': name === 'responses' ? 'text/event-stream' : 'application/json' },
    }))
    await assert.rejects(chat(options), error => {
      assert.ok(error instanceof ProviderTransportError)
      assert.equal(error.phase, 'response')
      assert.equal(error.code, 'UND_ERR_SOCKET')
      assert.equal(error.mayHaveBeenProcessed, true)
      assert.match(error.message, /not automatically replayed/)
      assert.doesNotMatch(error.message, /private socket|synthetic.invalid/)
      return true
    })
    assert.equal(fetch.mock.callCount(), 1)
    if (name === 'responses') assert.equal(body.locked, false)
  })

  test(`${name}: ambiguous connection resets and programmer TypeErrors are not retried`, async t => {
    const programmerError = new TypeError('fixture programmer error')
    const errors = [reset(), programmerError]
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw errors.shift() })
    await assert.rejects(chat(options), error => error instanceof ProviderTransportError && error.mayHaveBeenProcessed)
    await assert.rejects(chat(options), error => error === programmerError)
    assert.equal(fetch.mock.callCount(), 2)
  })
}

test('known pre-connection failure can retry; abort during backoff prevents another request', async t => {
  const controller = new AbortController()
  const cause = Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' })
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause }) })
  const warning = t.mock.method(console, 'warn', () => controller.abort(new Error('stop retry')))
  await assert.rejects(openaiChat({ ...options, signal: controller.signal }), /aborted|stop retry/i)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(warning.mock.callCount(), 1)
})

test('a known pre-connection failure retries once and returns the complete response', async t => {
  let count = 0
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    if (++count === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
    return Response.json({ choices: [{ message: { content: 'Complete' } }] })
  })
  assert.equal((await openaiChat(options)).content, 'Complete')
  assert.equal(count, 2)
})

test('transport classification preserves abort reasons and rejects arbitrary diagnostic codes', () => {
  const reason = new Error('user stopped')
  assert.throws(() => providerTransportFailure(reset(), 'response', AbortSignal.abort(reason)), error => error === reason)
  const foreign = Object.assign(new Error('not a transport error'), { code: 'private-value' })
  assert.equal(providerTransportFailure(foreign, 'connect'), foreign)
  const cause = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
  const failed = providerTransportFailure(new TypeError('fetch failed', { cause }), 'connect')
  assert.ok(failed instanceof ProviderTransportError)
  assert.equal(failed.mayHaveBeenProcessed, false)
})
