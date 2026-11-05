import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { trace, type Attributes, type Span } from '@opentelemetry/api'
import { prepareRequestBody, REQUEST_GZIP_MIN_BYTES } from './request-body.ts'
import { openaiChat } from './openai-compatible.ts'
import { openaiResponses } from './openai-responses.ts'
import { ProviderHttpError, type ChatMessage } from './provider.ts'

const sample = { text: '检查🔎 stable prefix\n'.repeat(2000), image: 'data:image/png;base64,AQID', tools: [{ name: 'read', arguments: '{"path":"synthetic.txt"}' }] }

test('gzip round trips to the exact JSON bytes without mutating input; reports only sizes and encoding', async t => {
  const attributes: Attributes = {}
  t.mock.method(trace, 'getActiveSpan', () => ({ setAttributes(a: Attributes) { Object.assign(attributes, a) } }) as unknown as Span)
  const original = structuredClone(sample)
  const plain = await prepareRequestBody(sample)
  const gzip = await prepareRequestBody(sample, 'gzip')
  assert.deepEqual(gzip.headers, { 'content-encoding': 'gzip' })
  assert(Buffer.isBuffer(gzip.body))
  assert.deepEqual(gunzipSync(gzip.body), Buffer.from(plain.body))
  assert.deepEqual(sample, original)
  assert(gzip.body.length < Buffer.byteLength(plain.body))
  assert.equal(attributes['llm.request.body_bytes'], Buffer.byteLength(plain.body))
  assert.equal(attributes['llm.request.wire_body_bytes'], gzip.body.length)
  assert.equal(attributes['llm.request.content_encoding'], 'gzip')
  assert.doesNotMatch(JSON.stringify(attributes), /AQID|检查|synthetic.txt/)
})

test('small requests stay identity and non-opted-in large requests remain byte-identical', async () => {
  for (const value of [{ text: 'small' }, { text: 'x'.repeat(REQUEST_GZIP_MIN_BYTES - 12) }]) {
    assert(Buffer.byteLength(JSON.stringify(value)) < REQUEST_GZIP_MIN_BYTES)
    assert.deepEqual(await prepareRequestBody(value, 'gzip'), { body: JSON.stringify(value), headers: {} })
  }
  assert.deepEqual(await prepareRequestBody(sample), { body: JSON.stringify(sample), headers: {} })
  assert.equal((await prepareRequestBody({ text: 'x'.repeat(REQUEST_GZIP_MIN_BYTES) }, 'gzip')).headers['content-encoding'], 'gzip')
})

test('pre-aborted requests do not serialize, and abort during zlib destroys the pipeline', async () => {
  const before = new AbortController()
  before.abort()
  let serialized = false
  await assert.rejects(prepareRequestBody({ toJSON() { serialized = true } }, 'gzip', before.signal), { name: 'AbortError' })
  assert.equal(serialized, false)
  const during = new AbortController()
  const pending = prepareRequestBody({ text: 'z'.repeat(2_000_000) }, 'gzip', during.signal)
  const reason = new Error('synthetic cancellation')
  during.abort(reason)
  await assert.rejects(pending, error => error === reason)
})

for (const protocol of ['chat', 'responses'] as const) {
  const invoke = protocol === 'chat' ? openaiChat : openaiResponses
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: sample.text }, { type: 'image_url', image_url: { url: sample.image } }] }]
  const params = { url: `https://synthetic.invalid/${protocol}`, apiKey: 'synthetic-key', model: 'synthetic', providerName: 'copilot', messages, tools: [], requestCompression: 'gzip' as const }
  const reply = () => Response.json(protocol === 'chat'
    ? { choices: [{ message: { content: 'ACK' } }] }
    : { id: 'resp_synthetic', status: 'completed', output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ACK', annotations: [] }] }] })

  test(`${protocol}: gzip transport is byte-equivalent to identity including images and does not change response handling`, async t => {
    const received: string[] = []
    const encodings: Array<string | null> = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const headers = new Headers(init.headers)
      assert.equal(headers.get('content-type'), 'application/json')
      assert.equal(headers.get('authorization'), 'Bearer synthetic-key')
      const encoding = headers.get('content-encoding')
      encodings.push(encoding)
      received.push(encoding === 'gzip' ? gunzipSync(init.body as Buffer).toString('utf8') : init.body as string)
      return reply()
    })
    assert.equal((await invoke({ ...params, requestCompression: undefined })).content, 'ACK')
    assert.equal((await invoke(params)).content, 'ACK')
    assert.deepEqual(encodings, [null, 'gzip'])
    assert.equal(received[0], received[1])
    assert.match(received[1]!, /data:image\/png;base64,AQID/)
  })

  for (const status of [400, 408, 413, 415, 500]) test(`${protocol}: HTTP ${status} never causes an automatic identity replay`, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++
      assert.equal(new Headers(init.headers).get('content-encoding'), 'gzip')
      return new Response('{}', { status })
    })
    await assert.rejects(invoke(params), e => e instanceof ProviderHttpError && e.status === status)
    assert.equal(calls, 1)
  })

  test(`${protocol}: existing 429 retry reuses identical prepared gzip bytes`, async t => {
    const bodies: BodyInit[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      bodies.push(init.body!)
      return bodies.length === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : reply()
    })
    assert.equal((await invoke(params)).content, 'ACK')
    assert.equal(bodies.length, 2)
    assert.strictEqual(bodies[0], bodies[1])
    assert(Buffer.isBuffer(bodies[0]))
  })

  test(`${protocol}: abort during compression dispatches no HTTP request`, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return reply() })
    const controller = new AbortController()
    const pending = invoke({ ...params, signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(calls, 0)
  })
}
