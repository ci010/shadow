import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareNewMessageImages } from './new-message-images.ts'
import type { ChatMessage } from './provider.ts'
import { pngFixture } from '../testing/image.ts'
import { imageFromBytes, MAX_IMAGE_BYTES } from '../utils/image-input.ts'

const small = imageFromBytes(pngFixture()).part

test('new-image guard preserves original content and image detail, tool pairing and provider state', async () => {
  const messages: ChatMessage[] = [{ role: 'tool', tool_call_id: 'call', name: 'computer', content: [{ type: 'text', text: 'Original screenshot' }, { ...small, image_url: { ...small.image_url, detail: 'high' } }] }]
  const original = structuredClone(messages)
  const prepared = await prepareNewMessageImages(messages)
  assert.deepEqual(messages, original)
  assert.deepEqual(prepared, original)
  assert.notStrictEqual(prepared[0], messages[0])
})

test('HTTP new image is boundedly snapshotted and passed through the same model-image rules', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(new Uint8Array(pngFixture()), { headers: { 'content-type': 'image/png' } }) })
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png', detail: 'low' } }] }]
  const [prepared] = await prepareNewMessageImages(messages)
  assert(Array.isArray(prepared.content))
  assert.deepEqual(prepared.content[0], { ...small, image_url: { ...small.image_url, detail: 'low' } })
  assert.equal(requests, 1)
  assert.match(JSON.stringify(messages), /https:\/\/synthetic.invalid/)
  // Replaying the resulting model copy performs no further network request.
  await prepareNewMessageImages([prepared])
  assert.equal(requests, 1)
})

test('display-only images are not fetched or transformed', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch a sticker') })
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'image_url', displayOnly: true, image_url: { url: 'https://synthetic.invalid/sticker.png' } }] }]
  assert.deepEqual(await prepareNewMessageImages(messages), messages)
})

for (const mode of ['http', 'declared-size', 'stream-size', 'mime', 'empty'] as const) test(`new URL snapshot rejects ${mode} rather than persisting a mutable fallback URL`, async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'http') return new Response('private response body', { status: 403 })
    if (mode === 'empty') return new Response(null)
    if (mode === 'declared-size') return new Response('x', { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })
    if (mode === 'stream-size') return new Response(new Uint8Array(MAX_IMAGE_BYTES + 1))
    return new Response(new Uint8Array(pngFixture()), { headers: { 'content-type': 'image/jpeg' } })
  })
  await assert.rejects(prepareNewMessageImages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png' } }] }]))
})

test('new image input validation and cancellation are shared across sources', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Must not fetch') })
  for (const url of ['https://user:password@synthetic.invalid/image.png', 'file:///image.png', 'data:image/png;base64,invalid']) {
    await assert.rejects(prepareNewMessageImages([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]))
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(prepareNewMessageImages([{ role: 'user', content: [small] }], controller.signal), { name: 'AbortError' })
  assert.equal(fetches, 0)
})
