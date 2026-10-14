import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnthropicProvider } from './anthropic.ts'
import { withProviderRetry } from './retry.ts'
import { openaiChat } from './openai-compatible.ts'
import { openaiResponses } from './openai-responses.ts'
import { ProviderTransportError, providerTransportFailure } from './provider.ts'

const options = { url: 'https://synthetic.invalid/model', apiKey: 'synthetic', model: 'fixture', messages: [], tools: [] }
const reset = () => new TypeError('terminated', { cause: Object.assign(new Error('private socket details'), { code: 'UND_ERR_SOCKET' }) })

for (const [name, chat] of [['chat', openaiChat], ['responses', openaiResponses], ['anthropic', (params: typeof options & { signal?: AbortSignal }) => new AnthropicProvider({ apiKey: params.apiKey, baseUrl: params.url }).chat(params.messages, params.tools, { model: params.model, signal: params.signal })]] as const) {
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

  test(`${name}: known pre-connection failures share retry and cancellation`, async t => {
    const controller = new AbortController()
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
    })
    t.mock.method(console, 'warn', () => controller.abort(new Error('stop retry')))
    await assert.rejects(chat({ ...options, signal: controller.signal }), /aborted|stop retry/i)
    assert.equal(fetch.mock.callCount(), 1)
  })

  test(`${name}: non-rate-limit HTTP failures never retry`, async t => {
    for (const status of [401, 413, 500, 503]) {
      const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status }))
      await assert.rejects(chat(options))
      assert.equal(fetch.mock.callCount(), 1)
      fetch.mock.restore()
    }
  })

  test(`${name}: rejected HTTP 429 retries but structured quota exhaustion does not`, async t => {
    let calls = 0
    const complete = name === 'responses'
      ? { status: 'completed', output: [] }
      : name === 'anthropic' ? { content: [] } : { choices: [] }
    const fetch = t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }) : Response.json(complete))
    await chat(options)
    assert.equal(calls, 2)
    fetch.mock.restore()
    const quota = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }))
    await assert.rejects(chat(options))
    assert.equal(quota.mock.callCount(), 1)
  })

  test(`${name}: a safe connection failure retries to a complete response`, async t => {
    let count = 0
    t.mock.method(console, 'warn', () => {})
    t.mock.method(globalThis, 'fetch', async () => {
      if (++count === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
      return Response.json(name === 'responses'
        ? { status: 'completed', output: [{ type: 'message', id: 'msg', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Complete', annotations: [] }] }] }
        : name === 'anthropic' ? { content: [{ type: 'text', text: 'Complete' }] }
        : { choices: [{ message: { content: 'Complete' } }] })
    })
    assert.equal((await chat(options)).content, 'Complete')
    assert.equal(count, 2)
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


test('shared retry exhausts five retries and preserves the final classified error', async t => {
  const errors: ProviderTransportError[] = []
  const waits: string[] = []
  t.mock.method(console, 'warn', (message: string) => { waits.push(message) })
  await assert.rejects(withProviderRetry(async () => {
    const error = new ProviderTransportError('connect', 'ECONNREFUSED')
    errors.push(error)
    throw error
  }), error => error === errors.at(-1))
  assert.equal(errors.length, 6)
  assert.equal(waits.length, 5)
  waits.forEach((message, i) => assert.match(message, new RegExp(`after ${(i + 1) * 1000}ms`)))
})

test('shared retry pre-abort prevents even the initial request', async () => {
  const reason = new Error('cancelled')
  await assert.rejects(withProviderRetry(async () => assert.fail('must not call'), AbortSignal.abort(reason)), error => error === reason)
})
