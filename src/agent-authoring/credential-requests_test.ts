import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentCredentialStore } from './credentials.ts'
import { CredentialRequests, CredentialRequestError } from './credential-requests.ts'
import { parseCredentialRequest, parseCredentialRequestResult } from './credential-request-contract.ts'

const SECRET = 'synthetic-owner-secret'
const input = { name: 'api-key', purpose: '  Authenticate the configured API request.  ' }
function store(initial: Record<string, string> = {}) {
  const values = { ...initial }
  const writes: Array<{ name: string; value: string }> = []
  return {
    values, writes, names: () => Object.keys(values),
    put(name: string, value: string) { writes.push({ name, value }); values[name] = value },
  }
}
function fixture(projectId = 'project-a', credentials = store()) {
  return { requests: new CredentialRequests({ projectId, credentials }), credentials, controller: new AbortController() }
}
function error(code: string, status: number) {
  return (value: unknown) => {
    assert.ok(value instanceof CredentialRequestError)
    assert.equal(value.code, code)
    assert.equal(value.status, status)
    assert.equal(String(value).includes(SECRET), false)
    assert.equal(value.stack?.includes(SECRET), false)
    assert.equal('cause' in value, false)
    return true
  }
}

test('request immediately exposes only strict metadata; submit returns only a ref and saved status', async () => {
  const { requests, credentials, controller } = fixture()
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const metadata = requests.pending()!
  assert.deepEqual(parseCredentialRequest(metadata, 'project-a'), metadata)
  assert.equal(metadata.sessionId, 'web:chat-admin')
  assert.equal(metadata.secretRef, 'api-key')
  assert.equal(metadata.purpose, input.purpose.trim())
  assert.equal(metadata.replacesExisting, false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  metadata.purpose = 'caller mutation'
  assert.equal(requests.pending()!.purpose, input.purpose.trim())
  const result = requests.submit(metadata.id, SECRET)
  assert.deepEqual(parseCredentialRequestResult(result), result)
  assert.deepEqual(result, { requestId: metadata.id, secretRef: 'api-key', status: 'saved' })
  result.status = 'cancelled'
  assert.equal((await waiting).status, 'saved')
  assert.equal(requests.pending(), null)
  assert.equal(credentials.values['api-key'], SECRET)
  assert.equal(JSON.stringify(metadata).includes(SECRET), false)
  assert.equal(JSON.stringify(await waiting).includes(SECRET), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('duplicate requests, stale IDs, and repeated submission never write', async () => {
  const { requests, credentials, controller } = fixture()
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const id = requests.pending()!.id
  const duplicate = new AbortController()
  await assert.rejects(requests.request(input, duplicate.signal, 'web:chat-admin'), error('request_pending', 409))
  assert.equal(getEventListeners(duplicate.signal, 'abort').length, 0)
  assert.throws(() => requests.submit('stale', SECRET), error('stale_request', 409))
  assert.throws(() => requests.cancel('stale'), error('stale_request', 409))
  assert.equal(credentials.writes.length, 0)
  requests.submit(id, SECRET)
  await waiting
  assert.throws(() => requests.submit(id, 'replacement'), error('stale_request', 409))
  assert.throws(() => requests.cancel(id), error('stale_request', 409))
  assert.equal(credentials.writes.length, 1)
  const next = requests.request(input, controller.signal, 'web:chat-admin')
  assert.notEqual(requests.pending()!.id, id)
  assert.throws(() => requests.submit(id, 'replacement'), error('stale_request', 409))
  requests.cancel(requests.pending()!.id)
  await next
  assert.equal(credentials.writes.length, 1)
})

test('explicit cancellation resolves cancelled and removes its abort listener', async () => {
  const { requests, credentials, controller } = fixture()
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const id = requests.pending()!.id
  const result = requests.cancel(id)
  assert.deepEqual(await waiting, result)
  assert.equal(result.status, 'cancelled')
  assert.equal(requests.pending(), null)
  assert.equal(credentials.writes.length, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  controller.abort(new Error(SECRET))
  assert.throws(() => requests.submit(id, SECRET), error('stale_request', 409))
})

test('already-aborted and later-aborted signals reject safely with no writes', async () => {
  const { requests, credentials, controller } = fixture()
  controller.abort(new Error(SECRET))
  await assert.rejects(requests.request(input, controller.signal, 'web:chat-admin'), error('aborted', 409))
  assert.equal(requests.pending(), null)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const active = new AbortController()
  const waiting = requests.request(input, active.signal, 'web:chat-admin')
  const id = requests.pending()!.id
  const rejected = assert.rejects(waiting, error('aborted', 409))
  active.abort(new Error(SECRET))
  await rejected
  assert.equal(requests.pending(), null)
  assert.equal(getEventListeners(active.signal, 'abort').length, 0)
  assert.throws(() => requests.submit(id, SECRET), error('stale_request', 409))
  assert.equal(credentials.writes.length, 0)
  const retry = requests.request(input, new AbortController().signal, 'web:chat-admin')
  requests.cancel(requests.pending()!.id)
  await retry
})

test('stop rejects pending, removes listeners, is idempotent and permanently blocks new requests', async () => {
  const { requests, credentials, controller } = fixture()
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const id = requests.pending()!.id
  const rejected = assert.rejects(waiting, error('stopped', 503))
  requests.stop()
  requests.stop()
  await rejected
  assert.equal(requests.pending(), null)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await assert.rejects(requests.request(input, controller.signal, 'web:chat-admin'), error('stopped', 503))
  assert.throws(() => requests.submit(id, SECRET), error('stale_request', 409))
  assert.throws(() => requests.cancel(id), error('stale_request', 409))
  assert.equal(credentials.writes.length, 0)
})

test('invalid submissions do not reach storage, never echo values and retain the pending request', async () => {
  const { requests, credentials, controller } = fixture()
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const metadata = requests.pending()
  for (const value of [null, undefined, 5, true, { value: SECRET }, '', `${SECRET}\n`, `${SECRET}\r`,
    `${SECRET}\t`, `${SECRET}\u0000`, `${SECRET}\u007f`, SECRET.repeat(1000)]) {
    assert.throws(() => requests.submit(metadata!.id, value), error('invalid_value', 400))
    assert.deepEqual(requests.pending(), metadata)
  }
  assert.equal(credentials.writes.length, 0)
  requests.submit(metadata!.id, SECRET)
  await waiting
  assert.equal(credentials.writes.length, 1)
})

test('failed storage preserves pending request for retry and sanitizes persistence exceptions', async () => {
  const credentials = store()
  let fail = true
  let attempts = 0
  const { requests, controller } = fixture('project-a', {
    ...credentials,
    put(name: string, value: string) {
      attempts++
      if (fail) throw new Error(`Cannot persist ${value}`, { cause: new Error(SECRET) })
      credentials.put(name, value)
    },
  })
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const metadata = requests.pending()!
  assert.throws(() => requests.submit(metadata.id, SECRET), error('storage_error', 500))
  assert.deepEqual(requests.pending(), metadata)
  assert.equal(credentials.writes.length, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  fail = false
  requests.submit(metadata.id, SECRET)
  assert.equal((await waiting).status, 'saved')
  assert.equal(attempts, 2)
  assert.equal(credentials.writes.length, 1)
})

test('real store write failure preserves the previous in-memory and persisted credential until successful retry', async t => {
  const directory = join(process.cwd(), `.credential-request-test-${randomUUID()}`)
  const storeDirectory = join(directory, 'store')
  const unavailableDirectory = join(directory, 'unavailable-store')
  await mkdir(directory)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const credentials = new AgentCredentialStore(storeDirectory)
  credentials.put('api-key', 'old-synthetic-value')
  const requests = new CredentialRequests({ projectId: randomUUID(), credentials })
  t.after(() => requests.stop())
  const waiting = requests.request(input, new AbortController().signal, 'web:chat-admin')
  void waiting.catch(() => undefined)
  const metadata = requests.pending()!
  assert.equal(metadata.replacesExisting, true)

  // Block the store's directory, without touching its existing synthetic file.
  await rename(storeDirectory, unavailableDirectory)
  await writeFile(storeDirectory, 'Blocked test directory')
  assert.throws(() => requests.submit(metadata.id, SECRET), error('storage_error', 500))
  assert.equal(credentials.resolve('api-key'), 'old-synthetic-value')
  assert.equal(new AgentCredentialStore(unavailableDirectory).resolve('api-key'), 'old-synthetic-value')
  assert.deepEqual(requests.pending(), metadata)

  await rm(storeDirectory)
  await rename(unavailableDirectory, storeDirectory)
  requests.submit(metadata.id, SECRET)
  assert.equal((await waiting).status, 'saved')
  assert.equal(credentials.resolve('api-key'), SECRET)
  assert.equal(new AgentCredentialStore(storeDirectory).resolve('api-key'), SECRET)
})

test('pending requests and stored values remain isolated between projects', async () => {
  const a = fixture('project-a')
  const b = fixture('project-b')
  const waitA = a.requests.request(input, a.controller.signal, 'web:chat-admin')
  const waitB = b.requests.request(input, b.controller.signal, 'web:chat-admin')
  const metaA = a.requests.pending()!
  const metaB = b.requests.pending()!
  assert.notEqual(metaA.id, metaB.id)
  assert.throws(() => b.requests.submit(metaA.id, SECRET), error('stale_request', 409))
  assert.throws(() => a.requests.cancel(metaB.id), error('stale_request', 409))
  a.requests.submit(metaA.id, SECRET)
  await waitA
  assert.deepEqual(b.requests.pending(), metaB)
  assert.equal(b.credentials.values['api-key'], undefined)
  b.requests.submit(metaB.id, 'other-project-secret')
  await waitB
  assert.equal(a.credentials.values['api-key'], SECRET)
  assert.equal(b.credentials.values['api-key'], 'other-project-secret')
})

test('separate service instances cannot open concurrent requests for the same project', async () => {
  const a = fixture('shared-project')
  const b = fixture('shared-project')
  const first = a.requests.request(input, a.controller.signal, 'web:chat-admin')
  await assert.rejects(b.requests.request(input, b.controller.signal, 'web:chat-admin'), error('request_pending', 409))
  assert.equal(b.requests.pending(), null)
  a.requests.cancel(a.requests.pending()!.id)
  await first
  const second = b.requests.request(input, b.controller.signal, 'web:chat-admin')
  a.requests.stop()
  assert.notEqual(b.requests.pending(), null)
  b.requests.submit(b.requests.pending()!.id, SECRET)
  assert.equal((await second).status, 'saved')
  assert.equal(a.credentials.writes.length, 0)
  assert.equal(b.credentials.writes.length, 1)
})

test('replacement metadata is a names-only snapshot and save explicitly replaces the stored value', async () => {
  const credentials = store({ 'api-key': 'old-synthetic-secret' })
  const { requests, controller } = fixture('project-a', credentials)
  const waiting = requests.request(input, controller.signal, 'web:chat-admin')
  const metadata = requests.pending()!
  assert.equal(metadata.replacesExisting, true)
  delete credentials.values['api-key']
  assert.equal(requests.pending()!.replacesExisting, true)
  assert.equal(JSON.stringify(metadata).includes('old-synthetic-secret'), false)
  credentials.values['api-key'] = 'old-synthetic-secret'
  requests.submit(metadata.id, SECRET)
  await waiting
  assert.equal(credentials.values['api-key'], SECRET)
})

test('invalid request metadata and failed names lookup never expose untrusted errors or register pending state', async () => {
  const { requests, controller } = fixture()
  for (const invalid of [{ name: SECRET.toUpperCase(), purpose: 'request' }, { name: 'ok', purpose: ' ' },
    { name: 'ok', purpose: SECRET.repeat(100) }, { ...input, extra: SECRET },
    { name: 'ok', purpose: 1 }]) {
    await assert.rejects(requests.request(invalid as typeof input, controller.signal, 'web:chat-admin'), error('invalid_request', 400))
    assert.equal(requests.pending(), null)
  }
  const broken = new CredentialRequests({ projectId: 'project-a', credentials: {
    names() { throw new Error(SECRET) }, put() { assert.fail('must not write') },
  } })
  await assert.rejects(broken.request(input, controller.signal, 'web:chat-admin'), error('storage_error', 500))
  assert.equal(broken.pending(), null)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  for (const projectId of ['', 'x'.repeat(201)]) {
    assert.throws(() => new CredentialRequests({ projectId, credentials: store() }), error('invalid_project', 400))
  }
})

test('browser-safe contract parsers strictly reject unknown fields, wrong scope and malformed metadata/results', () => {
  const metadata = {
    id: 'cc425467-2a74-4d43-b726-c14a380b9faf', projectId: 'project-a', sessionId: 'web:chat-admin',
    secretRef: 'api-key', purpose: 'Authenticate request.', createdAt: '2026-09-18T00:00:00.000Z', replacesExisting: false,
  }
  assert.deepEqual(parseCredentialRequest(metadata), metadata)
  for (const invalid of [null, [], {}, { ...metadata, value: SECRET }, { ...metadata, id: SECRET },
    { ...metadata, sessionId: 'user-session' }, { ...metadata, projectId: '' },
    { ...metadata, projectId: 'x'.repeat(201) }, { ...metadata, purpose: ' ' },
    { ...metadata, purpose: ' padded ' }, { ...metadata, purpose: 'x'.repeat(501) },
    { ...metadata, secretRef: 'Invalid' }, { ...metadata, createdAt: 'September 18, 2026' },
    { ...metadata, createdAt: '2026-99-99T00:00:00Z' }, { ...metadata, replacesExisting: 'false' }]) {
    assert.throws(() => parseCredentialRequest(invalid), error('invalid_request_metadata', 400))
  }
  assert.throws(() => parseCredentialRequest(metadata, 'project-b'), error('invalid_request_metadata', 400))
  const result = { requestId: metadata.id, secretRef: 'api-key', status: 'saved' }
  assert.deepEqual(parseCredentialRequestResult(result), result)
  for (const invalid of [null, [], {}, { ...result, value: SECRET }, { ...result, requestId: SECRET },
    { ...result, secretRef: '' }, { ...result, status: 'failed' }]) {
    assert.throws(() => parseCredentialRequestResult(invalid), error('invalid_request_result', 400))
  }
  const poisoned = Object.defineProperty({ ...metadata }, 'purpose', { get() { throw new Error(SECRET) } })
  assert.throws(() => parseCredentialRequest(poisoned), error('invalid_request_metadata', 400))
})
