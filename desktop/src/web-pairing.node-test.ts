import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { IPC_CHANNELS } from './ipc-contract.js'
import type { RuntimeAuthorization } from './runtime-authorization.js'
import { parseDesktopWebPairing } from './web-pairing-contract.js'
import { createWebPairingApi } from './web-pairing-preload.js'
import { installWebPairing } from './web-pairing.js'
import type { WindowControlsIpc } from './window-controls.js'

const token = 'synthetic-desktop-pairing-management-credential-123'
const origin = 'http://127.0.0.1:43123'
const offer = () => ({
  version: 1, code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
  expiresAt: new Date(Date.now() + 300_000).toISOString(), url: `${origin}/`,
})

function setup(request: typeof fetch = async () => Response.json(offer())) {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    webContents: { mainFrame: {}, isDestroyed: () => false },
  })
  const handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  let authorization: RuntimeAuthorization | null = { apiBase: origin, launchToken: token }
  const dispose = installWebPairing({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: channel => { handlers.delete(channel) },
  }, window, () => authorization, request)
  const handler = handlers.get(IPC_CHANNELS.createWebPairing)!
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  return { window, handlers, handler, event, dispose, setAuthorization(value: RuntimeAuthorization | null) { authorization = value } }
}

test('pairing IPC is argument-free, main-frame-only, and unavailable before Main is ready', async () => {
  let calls = 0
  const state = setup(async () => { calls++; return Response.json(offer()) })
  try {
    for (const args of [[origin], [undefined], [null], [{}]]) {
      await assert.rejects(async () => state.handler(state.event, ...args), /no arguments/)
    }
    await assert.rejects(async () => state.handler({ ...state.event, sender: {} }), /Main window/)
    await assert.rejects(async () => state.handler({ ...state.event, senderFrame: {} }), /Main window/)
    state.setAuthorization(null)
    await assert.rejects(async () => state.handler(state.event), /Main is not ready/)
    assert.equal(calls, 0)
  } finally { state.dispose() }
})

test('only main sends the credential to the fixed control endpoint and returns the validated DTO', async () => {
  const result = offer()
  const state = setup(async (input, init) => {
    assert.equal(input, `${origin}/local/v1/web-pairing`)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${token}` })
    assert.ok(init?.signal)
    return Response.json(result)
  })
  try {
    assert.deepEqual(await state.handler(state.event), result)
    assert.ok(!JSON.stringify(await state.handler(state.event)).includes(token))
  } finally { state.dispose() }
})

test('invalid or unbounded control responses never expose credentials or raw errors', async () => {
  const responses: Array<() => Response> = [
    () => new Response(token, { status: 500 }),
    () => new Response(token, { status: 302, headers: { Location: 'https://example.com' } }),
    () => new Response('x'.repeat(4097)),
    () => new Response('{not-json'),
    () => Response.json({ ...offer(), url: 'http://127.0.0.1:9999/' }),
    () => Response.json({ ...offer(), token }),
    () => Response.json({ ...offer(), code: token }),
    () => Response.json({ ...offer(), expiresAt: new Date(0).toISOString() }),
  ]
  for (const response of responses) {
    const state = setup(async () => response())
    try {
      await assert.rejects(async () => state.handler(state.event), error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Could not generate a pairing code. Check that Main is running, then retry.')
        assert.ok(!error.message.includes(token))
        return true
      })
    } finally { state.dispose() }
  }
  const state = setup(async () => { throw new Error(`transport error ${token}`) })
  try { await assert.rejects(async () => state.handler(state.event), { message: 'Could not generate a pairing code. Check that Main is running, then retry.' }) }
  finally { state.dispose() }
})

test('pending issuance rejects duplicates and stale runtime authorization; retry is possible', async () => {
  let resolveResponse!: (response: Response) => void
  const response = new Promise<Response>(resolve => { resolveResponse = resolve })
  const state = setup(async () => response)
  try {
    const pending = state.handler(state.event)
    await assert.rejects(async () => state.handler(state.event), /already being generated/)
    state.setAuthorization({ apiBase: origin, launchToken: token })
    resolveResponse(Response.json(offer()))
    await assert.rejects(async () => pending, /Main changed/)
  } finally { state.dispose() }
  let calls = 0
  const retry = setup(async () => {
    if (++calls === 1) throw new Error('offline')
    return Response.json(offer())
  })
  try {
    await assert.rejects(async () => retry.handler(retry.event), /Could not generate/)
    assert.ok(await retry.handler(retry.event))
    assert.equal(calls, 2)
  } finally { retry.dispose() }
})

test('closing the window aborts in-flight requests and unregisters pairing IPC', async () => {
  let signal: AbortSignal | undefined
  const state = setup(async (_input, init) => {
    signal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }))
  })
  const pending = state.handler(state.event)
  state.window.emit('closed')
  assert.equal(signal?.aborted, true)
  assert.equal(state.handlers.size, 0)
  await assert.rejects(async () => pending, /Could not generate/)
  await assert.rejects(async () => state.handler(state.event), /Main window/)
  state.dispose()
})

test('destroyed windows and invalid runtime destinations cannot issue codes', async () => {
  let calls = 0
  const state = setup(async () => { calls++; return Response.json(offer()) })
  try {
    for (const apiBase of ['https://example.com', `${origin}/path`, 'http://localhost:43123']) {
      state.setAuthorization({ apiBase, launchToken: token })
      await assert.rejects(async () => state.handler(state.event), /Could not generate/)
    }
    state.window.destroyed = true
    await assert.rejects(async () => state.handler(state.event), /Main window/)
    assert.equal(calls, 0)
  } finally { state.dispose() }
})

test('pairing preload exposes only frozen, argument-free issuance and validates responses', async () => {
  const calls: unknown[][] = []
  let value: unknown = offer()
  const api = createWebPairingApi({ invoke: async (...args) => { calls.push(args); return value } })
  assert.ok(Object.isFrozen(api))
  assert.deepEqual(Object.keys(api), ['create'])
  assert.deepEqual(await api.create(), value)
  assert.deepEqual(calls, [[IPC_CHANNELS.createWebPairing]])
  value = { ...offer(), url: 'https://example.com/' }
  await assert.rejects(api.create(), /Invalid browser pairing/)
})

test('pairing DTO rejects malformed codes, unsafe URLs and invalid expiry bounds', () => {
  const now = Date.now()
  for (const value of [
    null, [], {}, { ...offer(), version: 2 }, { ...offer(), code: 'AAAA\nBBBB' },
    { ...offer(), code: 'ABC' }, { ...offer(), url: `${origin}/?code=secret` },
    { ...offer(), url: 'http://user:password@127.0.0.1/' },
    { ...offer(), expiresAt: new Date(now).toISOString() },
    { ...offer(), expiresAt: new Date(now + 305_001).toISOString() },
  ]) assert.throws(() => parseDesktopWebPairing(value, origin, now), /Invalid browser pairing/)
  assert.equal(parseDesktopWebPairing(offer(), origin, now).version, 1)
})
