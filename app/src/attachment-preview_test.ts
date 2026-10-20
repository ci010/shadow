import assert from 'node:assert/strict'
import test from 'node:test'
import { readAttachmentBytes } from './attachment-preview.ts'

test('attachment reads are bounded, cancel the stream, and preserve UTF-8 bytes', async t => {
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('中文报告 extra bytes')) },
    cancel() { cancelled = true },
  })))
  const result = await readAttachmentBytes('http://fixture/api/media', new AbortController().signal, 12)
  assert.equal(result.truncated, true)
  assert.equal(new TextDecoder().decode(result.bytes), '中文报告')
  assert.equal(cancelled, true)
})

test('attachment preview does not turn denied media into a filesystem fallback', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(url); return new Response('', { status: 404 }) })
  await assert.rejects(readAttachmentBytes('http://fixture/api/media?path=denied', new AbortController().signal), /404/)
  assert.deepEqual(calls, ['http://fixture/api/media?path=denied'])
})
