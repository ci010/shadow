import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installFrontendNetworkLog } from './frontend-network-log.ts'

function fixture(fetcher: typeof fetch) {
  class Source extends EventTarget { static CONNECTING = 0; constructor(readonly url: string) { super() } close() {} }
  const target = { location: { href: 'http://fixture.test/' }, fetch: fetcher, EventSource: Source } as unknown as Window & typeof globalThis
  const messages: string[] = []
  const stop = installFrontendNetworkLog(target, 'http://fixture.test/projects/a/', message => messages.push(message))
  return { target, messages, stop, Source }
}

test('HTTP/network metadata preserve responses and exceptions, omit private data and collector traffic', async () => {
  const error = Error('private payload')
  const response = new Response('private response', { status: 503 })
  const original: typeof fetch = async input => { if (String(input).includes('agent-types')) throw error; return response }
  const { target, messages, stop } = fixture(original)
  assert.equal(await target.fetch('/projects/a/api/projects?secret=private'), response)
  await assert.rejects(target.fetch('/projects/a/api/agent-types'), value => value === error)
  await target.fetch('/projects/b/api/projects')
  await target.fetch('/projects/a/api/runtime/frontend-logs')
  await target.fetch('http://other.test/api/projects')
  await target.fetch('/api/unknown/private-session')
  assert.deepEqual(messages, ['API projects: HTTP 503', 'API agent-types: fetch failed (network/CORS/connection; browser code unavailable)'])
  assert.doesNotMatch(messages.join(), /private|secret|fixture/)
  stop(); assert.equal(target.fetch, original)
})

test('EventSource errors cover live stream interruption after connection; native code remains unavailable', () => {
  const { target, messages, stop, Source } = fixture(async () => new Response())
  const source = new target.EventSource('/api/live?topics=private')
  assert.ok(source instanceof Source)
  source.dispatchEvent(new Event('error'))
  assert.match(messages[0]!, /API live: EventSource error.*interrupted/)
  assert.doesNotMatch(messages[0]!, /topics|private/)
  stop()
  source.dispatchEvent(new Event('error'))
  assert.equal(messages.length, 1)
  assert.equal(target.EventSource, Source)
})

test('body failure after successful fetch is not intercepted and intentional abort is quiet', async () => {
  const failure = Error('truncated stream')
  const response = new Response(new ReadableStream({ start(controller) { controller.error(failure) } }))
  const { target, messages, stop } = fixture(async (_input, init) => { if (init?.signal?.aborted) throw init.signal.reason; return response })
  const result = await target.fetch('/api/projects')
  await assert.rejects(result.text(), value => value === failure)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(target.fetch('/api/projects', { signal: controller.signal }))
  assert.deepEqual(messages, [])
  stop()
})
