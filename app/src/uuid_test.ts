import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createUuid } from './uuid.ts'
import { createChatDraft } from './chat-draft.ts'
import { appendChatAttachments, updateImageAttachment } from './chat-attachments.ts'
import { createConversationResources } from './project-workspaces.ts'
import { startImageReferenceDrag, readImageReference } from './image-context.ts'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function replaceCrypto(t: TestContext, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else Reflect.deleteProperty(globalThis, 'crypto')
  })
}

test('createUuid prefers native randomUUID and preserves its receiver', t => {
  const expected = '00112233-4455-4677-8899-aabbccddeeff'
  const crypto = {
    randomUUID() { assert.equal(this, crypto); return expected },
    getRandomValues() { assert.fail('Native UUID must not use the fallback') },
  }
  replaceCrypto(t, crypto)
  assert.equal(createUuid(), expected)
})

test('createUuid formats random bytes as UUID v4 without losing leading zeroes', t => {
  const crypto = {
    getRandomValues(bytes: Uint8Array) {
      assert.equal(this, crypto)
      assert.equal(bytes.length, 16)
      bytes.set(Array.from({ length: 16 }, (_, index) => index))
      return bytes
    },
  }
  replaceCrypto(t, crypto)
  assert.equal(createUuid(), '00010203-0405-4607-8809-0a0b0c0d0e0f')
  assert.equal('randomUUID' in crypto, false, 'No global polyfill is installed')
})

test('createUuid masks version and variant bits and requests fresh randomness on each call', t => {
  let calls = 0
  const buffers = new Set<Uint8Array>()
  replaceCrypto(t, {
    getRandomValues(bytes: Uint8Array) {
      buffers.add(bytes)
      bytes.fill(calls++)
      return bytes
    },
  })
  for (let byte = 0; byte < 256; byte++) {
    const uuid = createUuid()
    assert.match(uuid, uuidPattern)
    const encoded = Buffer.from(uuid.replaceAll('-', ''), 'hex')
    for (let index = 0; index < 16; index++) {
      assert.equal(encoded[index], index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte)
    }
  }
  assert.equal(calls, 256)
  assert.equal(buffers.size, 256)
})

test('createUuid fails explicitly when secure randomness is unavailable or fails', t => {
  replaceCrypto(t, undefined)
  assert.throws(createUuid, /Secure random number generation is unavailable/)
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  assert.throws(createUuid, /Secure random number generation is unavailable/)
  const failure = new Error('Random source failed')
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true, value: { getRandomValues() { throw failure } },
  })
  assert.throws(createUuid, error => error === failure)
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true, value: {
      randomUUID() { throw failure },
      getRandomValues() { assert.fail('Native errors must not be swallowed') },
    },
  })
  assert.throws(createUuid, error => error === failure)
})

test('chat drafts, attachment keys, resource keys and image drag tokens work without randomUUID', async t => {
  const crypto = globalThis.crypto
  replaceCrypto(t, { getRandomValues: crypto.getRandomValues.bind(crypto) })
  const draft = createChatDraft({ createSession: async () => { throw new Error('Unexpected folder request') } })
  const sessionId = await draft.prepare()
  assert.ok(sessionId.startsWith('web:chat-'))
  assert.match(sessionId.slice('web:chat-'.length), uuidPattern)
  assert.equal(await draft.prepare(), sessionId)

  const file = new File(['image'], 'example.png', { type: 'image/png' })
  const attachments = appendChatAttachments([], [file], { createObjectUrl: () => 'blob:fixture' })
  assert.match(attachments[0]!.key, uuidPattern)
  const images = updateImageAttachment([], 'image', file, { createObjectUrl: () => 'blob:fixture' })
  assert.match(images[0]!.key, uuidPattern)

  const resources = createConversationResources()
  const first = resources.draft('default')
  resources.prepared(first.key, sessionId)
  const second = resources.draft('default')
  assert.ok(second.key.startsWith(`${first.key}:`))
  assert.match(second.key.slice(first.key.length + 1), uuidPattern)

  const data = new Map<string, string>()
  const reference = { sourceKey: 'image', file, source: { path: 'C:\\fixture\\image.png', modified: false } }
  const endDrag = startImageReferenceDrag({
    setData: (type, token) => { assert.match(token, uuidPattern); data.set(type, token) },
    effectAllowed: 'none',
  }, reference)
  const transfer = { types: [...data.keys()], getData: (type: string) => data.get(type) ?? '' }
  assert.equal(readImageReference(transfer), reference)
  endDrag()
  assert.throws(() => readImageReference(transfer), /no longer available/)
})
