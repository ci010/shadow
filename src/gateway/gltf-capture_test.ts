import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { GLTF_CAPTURE_HEADER, GLTF_CAPTURE_PATH } from '../gltf-capture-contract.ts'
import { CaptureViewTool } from '../tools/capture-view.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { transientToolSummary } from '../tools/tool.ts'
import { GltfCaptureBridge } from './gltf-capture.ts'
import { createGltfCaptureOwner } from './gltf-capture-auth.ts'
import { GatewayClientAddressRegistry } from './server.ts'

const scope = { projectId: 'fixture', sessionId: 'web:chat', assetId: 'asset.glb', version: 'v1' }
const image = {
  mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  camera: { position: [1, 2, 3], target: [0, 0, 0] }, objectIds: ['cube'],
}

async function fixture(t: TestContext) {
  const app = new Hono(), bus = new Bus()
  const owner = new AbortController(), other = new AbortController()
  const access = (request: Request) => request.headers.get('x-fixture-owner') === 'a' ? owner.signal
    : request.headers.get('x-fixture-owner') === 'b' ? other.signal : undefined
  const sessions = new Set([scope.sessionId, 'web:other'])
  const bridge = new GltfCaptureBridge(scope.projectId, access, id => sessions.has(id))
  bridge.mount(app)
  const channel = new WebChannel(bus, { authorize: request => !!access(request) })
  channel.setReceiver(async message => {
    await bridge.admitWebInput(message)
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  await channel.start(app)
  t.after(async () => { bridge.close(); await channel.stop() })
  const post = (action: string, binding?: string, data?: unknown, auth = 'a', signal?: AbortSignal) => app.request(
    action.startsWith('/') ? action : `${GLTF_CAPTURE_PATH}/${action}`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-fixture-owner': auth,
        ...(binding ? { [GLTF_CAPTURE_HEADER]: binding } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
  const register = async (target = scope, auth = 'a') => {
    const reply = await post('register', undefined, target, auth)
    assert.equal(reply.status, 200)
    return (await reply.json()).binding as string
  }
  const send = async (binding?: string, chatId = 'chat', auth = 'a', retry = false) => {
    const reply = await post('/api/chat/send', binding, { chatId, content: 'Observe the asset', retry }, auth)
    assert.equal(reply.status, 200)
    return (await reply.json()).requestId as string
  }
  const tool = new CaptureViewTool(scope.projectId, bridge)
  const base = new Tools(process.cwd())
  const importer = new ImportTool(new Map(), process.cwd())
  importer.registerBuiltin(tool.name, tool, ctx => tool.available(ctx))
  base.register(new InvokeTool(importer))
  base.register({ name: 'read', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => '' })
  const tools = new SessionTools(base, process.cwd())
  tools.setExecutionScope('session', [])
  const context = (messageId: string): ExecutionContext => ({
    messageId, projectId: scope.projectId, sessionId: scope.sessionId, channel: 'web', chatId: 'chat',
    physicalSessionId: 'fixture', workUserInput: 'Observe the asset', senderId: 'web-user', inputSource: 'user', admin: true, tools, signal: new AbortController().signal,
  })
  const invoke = (messageId: string, args: Record<string, unknown> = {}, ctx = context(messageId)) => tools.execute('invoke_tool', {
    name: tool.name, args: { assetId: scope.assetId, ...args },
  }, ctx)
  const poll = async (binding: string) => (await post('poll', binding)).json()
  return { post, register, send, owner, bridge, invoke, context, importer, sessions, poll }
}

test('capture_view is dynamically scoped to the real Web input and returns a transient PNG and exact camera metadata', async t => {
  const f = await fixture(t)
  assert.equal((await f.post('register', undefined, scope, 'anonymous')).status, 403)
  assert.equal((await f.post('register', undefined, { ...scope, projectId: 'wrong' })).status, 400)
  const binding = await f.register()
  for (const id of [await f.send(), await f.send(binding, 'other'), await f.send(binding, 'chat', 'b'), await f.send(binding, 'chat', 'a', true)]) {
    assert.deepEqual(await f.importer.virtualEntries(f.context(id), { subpath: 'capture_view' }), [])
    assert.match(String(await f.invoke(id)), /requires an active binding/)
  }
  const id = await f.send(binding)
  assert.deepEqual((await f.importer.virtualEntries(f.context(id), { subpath: 'capture_view' })).map(entry => entry.name), ['capture_view'])
  assert.match(String(await f.invoke(id, {}, { ...f.context(id), inputSource: 'session' })), /requires an active binding/)
  assert.match(String(await f.invoke(id, { assetId: 'elsewhere' })), /No unique, live Viewer/)
  assert.equal((await f.post('poll', binding, undefined, 'b')).status, 409)
  for (const bad of [{ position: [1, 2, 3] }, { position: [0, 1, 0], target: [0, 1, 0] }]) {
    assert.match(String(await f.invoke(id, bad)), /distinct finite xyz/)
  }
  const pending = f.invoke(id, { position: [1, 2, 3], target: [0, 0, 0], version: 'v1' })
  const job = await f.poll(binding)
  assert.deepEqual(job.scope, scope)
  assert.deepEqual(job.view, { mode: 'custom', position: [1, 2, 3], target: [0, 0, 0] })
  assert.equal((await f.post('result', binding, { id: job.id, result: image }, 'b')).status, 409)
  assert.equal((await f.post('result', binding, { id: job.id, result: image })).status, 204)
  const result = await pending
  if (typeof result === 'string') throw new Error(result)
  assert.match(transientToolSummary(result) ?? '', /transient/)
  assert.deepEqual(result.content, [
    { type: 'text', text: JSON.stringify({ assetId: scope.assetId, version: 'v1', mode: 'custom', camera: image.camera, objectIds: image.objectIds }) },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}`, detail: 'auto' } },
  ])
  f.bridge.finishTurn(id)
  assert.match(String(await f.invoke(id)), /requires an active binding/)
})

test('hot reload cancels the old frame; afterVersion rejects stale renders but the original turn can capture the update', async t => {
  const f = await fixture(t)
  const binding = await f.register(), id = await f.send(binding)
  assert.match(String(await f.invoke(id, { afterVersion: 'v1' })), /still has the previous asset version.*no image was captured/)
  const old = f.invoke(id, { version: 'v1' })
  const oldJob = await f.poll(binding)
  assert.equal((await f.post('version', binding, { previousVersion: 'v1', version: 'v2' }, 'b')).status, 409)
  assert.equal((await f.post('version', binding, { previousVersion: 'v1', version: 'v2' })).status, 204)
  assert.match(String(await old), /expired|cancelled/)
  assert.equal((await f.post('result', binding, { id: oldJob.id, result: image })).status, 409)
  assert.match(String(await f.invoke(id, { version: 'v1' })), /does not match the requested version/)
  const updated = f.invoke(id, { mode: 'top', afterVersion: 'v1' })
  const job = await f.poll(binding)
  assert.equal(job.scope.version, 'v2')
  assert.equal((await f.post('result', binding, { id: job.id, result: image })).status, 204)
  const result = await updated
  assert(typeof result !== 'string' && JSON.parse((result.content[0] as { text: string }).text).version === 'v2')
})

test('ambiguous mounts, wrong pixels, identity revocation, unmount and session loss fail closed', async t => {
  const f = await fixture(t)
  const first = await f.register(), id = await f.send(first)
  const pending = f.invoke(id)
  const job = await f.poll(first)
  const second = await f.register({ ...scope, version: 'other' }, 'b')
  assert.match(String(await pending), /expired|cancelled/)
  assert.equal((await f.post('result', first, { id: job.id, result: image })).status, 409)
  assert.match(String(await f.invoke(await f.send(first))), /requires an active binding/)
  assert.equal((await f.post('unregister', second, undefined, 'b')).status, 204)
  assert.match(String(await f.invoke(id)), /requires an active binding/)
  const current = await f.send(first)
  const invalid = f.invoke(current)
  const invalidJob = await f.poll(first)
  assert.equal((await f.post('result', first, { id: invalidJob.id, result: { ...image, data: 'dGV4dA==' } })).status, 400)
  assert.match(String(await invalid), /expired|cancelled/)
  f.owner.abort()
  assert.equal((await f.post('poll', first)).status, 409)
  assert.match(String(await f.invoke(current)), /requires an active binding/)
  const next = await f.register(scope, 'b'), nextId = await f.send(next, 'chat', 'b')
  f.sessions.delete(scope.sessionId)
  assert.equal((await f.post('poll', next, undefined, 'b')).status, 409)
  assert.match(String(await f.invoke(nextId)), /requires an active binding/)
})

test('tool cancellation and timed-out jobs reject late responses', async t => {
  const f = await fixture(t)
  const binding = await f.register(), id = await f.send(binding)
  const controller = new AbortController()
  const cancelled = f.bridge.capture(scope, id, { mode: 'current' }, controller.signal)
  const cancelledJob = await f.poll(binding)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.equal((await f.post('result', binding, { id: cancelledJob.id, result: image })).status, 409)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const pending = f.bridge.capture(scope, id, { mode: 'current' }, new AbortController().signal)
  const job = await f.poll(binding)
  const rejected = assert.rejects(pending, /expired/)
  t.mock.timers.tick(8_001)
  await rejected
  assert.equal((await f.post('result', binding, { id: job.id, result: image })).status, 409)
  t.mock.timers.tick(12_000)
  assert.equal((await f.post('poll', binding)).status, 409)
  assert.equal(f.bridge.available(scope.sessionId, id), false)
})

test('owner authorization separates the trusted desktop launch from delegated and cross-site clients', async () => {
  const clientAddresses = new GatewayClientAddressRegistry()
  const origin = 'http://127.0.0.1:12345'
  const options = { clientAddresses, delegated: (request: Request) => request.headers.has('x-fixture-delegated') }
  const owner = createGltfCaptureOwner({ ...options, launchCredential: 'fixture-launch-token' })
  const request = (headers: Record<string, string>, hostname = '127.0.0.1') => {
    const req = new Request(`${origin}/api/gltf-capture/register`, { method: 'POST', headers })
    clientAddresses.capture(req, { transport: 'tcp', hostname })
    return req
  }
  const desktop = { origin: 'null', 'sec-fetch-site': 'cross-site', authorization: 'Bearer fixture-launch-token' }
  const desktopIdentity = await owner(request(desktop))
  assert(desktopIdentity)
  assert.equal(await owner(request(desktop)), desktopIdentity)
  assert.equal(await owner(request({ ...desktop, authorization: 'Bearer wrong' })), undefined)
  assert.equal(await owner(request({ ...desktop, origin: 'http://external.invalid' })), undefined)
  assert.equal(await owner(request({ ...desktop, 'x-fixture-delegated': '1' })), undefined)
  assert.equal(await owner(request(desktop, '192.168.1.12')), undefined)
  const local = createGltfCaptureOwner(options)
  assert.equal(await local(request({ origin })), undefined)
  assert.equal(await local(request({ origin, 'sec-fetch-site': 'cross-site' })), undefined)
  assert.equal(await local(request({})), undefined)
})

test('supports 4096 selected IDs and explicitly rejects oversized IDs and images', async t => {
  const f = await fixture(t)
  const binding = await f.register(), id = await f.send(binding)
  const selections = Array.from({ length: 4096 }, (_, index) => `${index}`.padEnd(256, 'x'))
  const successful = f.bridge.capture(scope, id, { mode: 'current' }, AbortSignal.timeout(2000))
  const job = await f.poll(binding)
  assert.equal((await f.post('result', binding, { id: job.id, result: { ...image, objectIds: selections } })).status, 204)
  assert.deepEqual((await successful).objectIds, selections)
  for (const body of [
    { result: { ...image, objectIds: ['猫'.repeat(86)] } },
    { result: { ...image, objectIds: [...selections, 'overflow'] } },
    { result: null, error: 'limits' },
  ]) {
    const pending = f.bridge.capture(scope, id, { mode: 'current' }, AbortSignal.timeout(2000))
    const rejected = assert.rejects(pending, /3 MiB.*4096.*256 UTF-8 bytes/)
    const request = await f.poll(binding)
    assert.equal((await f.post('result', binding, { id: request.id, ...body })).status, 204)
    await rejected
  }
})
