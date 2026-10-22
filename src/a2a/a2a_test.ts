import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { once } from 'node:events'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { AgentCard, GetTaskRequest, ListTasksRequest, SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { withTempWorkspace } from '../testing/workspace.ts'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { A2aConfigurationError, A2aConfigSchema, a2aRequestProject, resolveA2aSecret } from './config.ts'
import { A2aStore } from './store.ts'
import { A2aService, type A2aRunner } from './service.ts'
import { a2aAuthenticator, registerA2aRoutes } from './routes.ts'
import { A2aClientTools, a2aFetch } from './client.ts'

const token = 'synthetic-a2a-token-not-a-secret-0001'
const otherToken = 'synthetic-a2a-token-not-a-secret-0002'
const owner = (name = 'alice') => new ServerCallContext({
  user: { isAuthenticated: true, userName: name }, requestedVersion: '1.0',
})
const request = (text = 'hello', extra: Record<string, unknown> = {}) => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text, mediaType: 'text/plain' }], ...extra },
  configuration: { returnImmediately: true },
})
const serverConfig = (url = 'http://127.0.0.1/projects/p/a2a') => A2aConfigSchema.parse({
  server: { url, agentType: 'a2a-text', callers: { alice: 'A2A_TEST_TOKEN', bob: 'A2A_TEST_OTHER_TOKEN' } },
}).server!
const wait = async (service: A2aService, id: string, name = 'alice') => {
  let final
  for await (const event of service.resubscribe({ id, tenant: '' }, owner(name))) final = event
  assert(final)
  return service.getTask(GetTaskRequest.fromJSON({ id }), owner(name))
}

test('A2A configuration is explicit, scoped, and does not accept unsafe URLs or credentials', () => {
  assert.equal(A2aConfigSchema.parse({}).server, undefined)
  for (const url of ['http://example.com/a2a', 'http://localhost/a2a', 'https://user:pass@example.com/a2a', 'https://example.com/a2a?q=token']) {
    assert.throws(() => serverConfig(url))
  }
  assert.throws(() => resolveA2aSecret('MISSING', {}), error => error instanceof A2aConfigurationError && /credential/.test(error.message))
  assert.throws(() => a2aAuthenticator({ alice: 'TOKEN', bob: 'TOKEN' }, { TOKEN: token }),
    error => error instanceof A2aConfigurationError && /distinct/.test(error.message))
  for (const [path, method, expected] of [
    ['/projects/p/a2a', 'POST', 'p'], ['/projects/p/a2a/.well-known/agent-card.json', 'GET', 'p'],
    ['/projects/p/api/config', 'POST', undefined], ['/projects/p/a2a/extra', 'POST', undefined],
    ['/projects/p/a2a', 'GET', undefined], ['/a2a', 'POST', undefined],
  ] as const) {
    assert.equal(a2aRequestProject(new Request(`http://localhost${path}`, { method })), expected)
  }
})

test('A2A admissions deduplicate, scope owners/contexts, persist terminal outcomes and do not replay after restart', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(join(root, 'tasks')); store.init()
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let executions = 0
    const service = new A2aService('p', serverConfig(), store, {
      async run() { executions++; entered.resolve(); await release.promise; return { status: 'completed', content: 'result' } },
    })
    try {
      const input = request()
      const [task, duplicate] = await Promise.all([
        service.sendMessage(input, owner()), service.sendMessage(input, owner()),
      ])
      await entered.promise
      assert.equal(task.id, duplicate.id)
      assert.equal(executions, 1)
      await assert.rejects(service.sendMessage(request('changed', { messageId: input.message!.messageId }), owner()), /different content/)
      await assert.rejects(service.getTask(GetTaskRequest.fromJSON({ id: task.id }), owner('bob')), /not found/i)
      await assert.rejects(service.sendMessage(request('new', { contextId: task.contextId }), owner('bob')), /Unknown context/)
      await assert.rejects(service.sendMessage(request('new', { contextId: task.contextId }), owner()), /active task/)
      await assert.rejects(service.getTask(GetTaskRequest.fromJSON({ id: task.id, tenant: 'foreign' }), owner()), /scope/)
      release.resolve()
      const final = await wait(service, task.id)
      assert.equal(final.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.equal(final.artifacts[0].parts[0].content?.value, 'result')
      assert.equal((await service.getTask(GetTaskRequest.fromJSON({ id: task.id, historyLength: 0 }), owner())).history.length, 0)
      const ownList = await service.listTasks(ListTasksRequest.fromJSON({ includeArtifacts: false }), owner())
      assert.equal(ownList.tasks.length, 1)
      assert.deepEqual(ownList.tasks[0].artifacts, [])
      assert.equal((await service.listTasks(ListTasksRequest.fromJSON({}), owner('bob'))).totalSize, 0)
      await assert.rejects(service.cancelTask({ id: task.id, tenant: '', metadata: undefined }, owner()), /cancel/i)
      const continuation = await service.sendMessage(request('follow up', { contextId: task.contextId }), owner())
      await wait(service, continuation.id)
      assert.equal(store.inbound.get(continuation.id)?.sessionId, store.inbound.get(task.id)?.sessionId)
      await service.close()
      const reopened = new A2aStore(join(root, 'tasks')); reopened.init()
      const restored = new A2aService('p', serverConfig(), reopened, { run: async () => { throw new Error('Must not replay') } })
      assert.equal((await restored.sendMessage(input, owner())).id, task.id)
      assert.equal(executions, 2)
      await restored.close()
    } finally { release.resolve(); await service.close() }
  })
})

test('A2A interruption recovery is durable and cancellation waits for execution to stop', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(join(root, 'tasks')); store.init()
    const entered = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    let aborted = false
    const service = new A2aService('p', serverConfig(), store, {
      async run(_record, _message, signal) {
        entered.resolve()
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
        await stopped.promise
        return { status: 'cancelled', content: '' }
      },
    })
    try {
      const task = await service.sendMessage(request(), owner())
      await entered.promise
      const restartStore = new A2aStore(join(root, 'tasks')); restartStore.init()
      const restart = new A2aService('p', serverConfig(), restartStore, { run: async () => { throw new Error('Must not run') } })
      const interrupted = await restart.getTask(GetTaskRequest.fromJSON({ id: task.id }), owner())
      assert.equal(interrupted.status?.state, TaskState.TASK_STATE_FAILED)
      assert.match(String(interrupted.status?.message?.parts[0].content?.value), /not replayed/)
      await restart.close()
      let canceled = false
      const cancelling = service.cancelTask({ id: task.id, tenant: '', metadata: undefined }, owner()).then(value => { canceled = true; return value })
      await Promise.resolve()
      assert.equal(aborted, true)
      assert.equal(canceled, false)
      stopped.resolve()
      assert.equal((await cancelling).status?.state, TaskState.TASK_STATE_CANCELED)
    } finally { stopped.resolve(); await service.close() }
  })
})

test('A2A rejects unsupported input and output instead of silently discarding content', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(join(root, 'tasks')); store.init()
    const service = new A2aService('p', serverConfig(), store, { run: async () => ({ status: 'completed', content: 'ok' }) })
    try {
      for (const input of [
        request('', { parts: [{ url: 'file:///private' }] }),
        request('hello', { referenceTaskIds: ['foreign'] }),
        request('hello', { metadata: { admin: true } }),
        request('hello', { role: 'ROLE_AGENT' }),
        request(' '), request('x'.repeat(65537)),
      ]) await assert.rejects(service.sendMessage(input, owner()))
      const input = request()
      input.configuration!.acceptedOutputModes = ['image/png']
      await assert.rejects(service.sendMessage(input, owner()), /content/i)
      assert.equal(store.inbound.size, 0)
    } finally { await service.close() }
  })
})

test('A2A bounds concurrency and output bytes, and disconnecting a subscriber does not cancel execution', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(join(root, 'tasks')); store.init()
    const release = Promise.withResolvers<void>()
    let canceled = false
    const service = new A2aService('p', { ...serverConfig(), maxConcurrent: 1 }, store, {
      async run(_record, _message, signal) {
        signal.addEventListener('abort', () => { canceled = true }, { once: true })
        await release.promise
        return { status: 'completed', content: 'x'.repeat(256 * 1024 + 1) }
      },
    })
    try {
      const accepted = await service.sendMessage(request('x'.repeat(64 * 1024)), owner())
      await assert.rejects(service.sendMessage(request('other'), owner()), /concurrency/)
      const disconnect = new AbortController()
      const context = owner()
      context.state.set('signal', disconnect.signal)
      const stream = service.resubscribe({ id: accepted.id, tenant: '' }, context)
      assert.equal((await stream.next()).value?.payload?.$case, 'task')
      disconnect.abort()
      await assert.rejects(stream.next(), { name: 'AbortError' })
      assert.equal(canceled, false)
      release.resolve()
      const final = await wait(service, accepted.id)
      assert.equal(final.status?.state, TaskState.TASK_STATE_FAILED)
      assert.match(String(final.status?.message?.parts[0].content?.value), /256 KiB/)
      assert.deepEqual(final.artifacts, [])
    } finally { release.resolve(); await service.close() }
  })
})

test('real HTTP SDK clients discover, stream, resubscribe and call bidirectionally without granting admin access', { timeout: 15_000 }, async () => {
  await withTempWorkspace(async root => {
    const app = new Hono()
    const addresses = Promise.withResolvers<number>()
    const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => addresses.resolve(info.port))
    const port = await addresses.promise
    const base = `http://127.0.0.1:${port}`
    const tokenEnv = process.env.A2A_TEST_TOKEN
    process.env.A2A_TEST_TOKEN = token
    const services: A2aService[] = []
    const clients: A2aClientTools[] = []
    const authenticate = a2aAuthenticator({ alice: 'TOKEN', bob: 'OTHER' }, { TOKEN: token, OTHER: otherToken })
    registerGatewayRoutes(app, [], {
      launchCredential: 'synthetic-admin',
      authorizeClient: request => !!a2aRequestProject(request) && !!authenticate(request),
    })
    app.get('/api/admin-fixture', c => c.json({ admin: true }))
    try {
      for (const projectId of ['p', 'q']) {
        const scoped = new Hono()
        const store = new A2aStore(join(root, projectId)); store.init()
        const config = serverConfig(`${base}/projects/${projectId}/a2a`)
        const runner: A2aRunner = {
          run: async (_record, message) => ({ status: 'completed', content: `${projectId}: ${message.parts[0].content?.value}` }),
        }
        const service = new A2aService(projectId, config, store, runner)
        services.push(service)
        registerA2aRoutes(scoped, service, authenticate)
        app.route(`/projects/${projectId}`, scoped)
        const target = projectId === 'p' ? 'q' : 'p'
        const remoteConfig = A2aConfigSchema.parse({ agents: { peer: {
          cardUrl: `${base}/projects/${target}/a2a/.well-known/agent-card.json`,
          endpointUrl: `${base}/projects/${target}/a2a`, tokenEnv: 'A2A_TEST_TOKEN',
        } } })
        clients.push(new A2aClientTools(projectId, remoteConfig, store))
      }
      const url = `${base}/projects/p/a2a`
      assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401)
      assert.equal((await fetch(`${base}/api/admin-fixture`, { headers: { Authorization: `Bearer ${token}` } })).status, 401)
      const fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}` } })
      const factory = new ClientFactory({
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      })
      const client = await factory.createFromUrl(`${url}/.well-known/agent-card.json`, '')
      const cardResponse = await fetchImpl(`${url}/.well-known/agent-card.json`)
      const card = AgentCard.fromJSON(await cardResponse.json())
      assert.equal(card.securitySchemes.bearer.scheme?.$case, 'httpAuthSecurityScheme')
      const received = []
      for await (const event of client.sendMessageStream(request())) received.push(event)
      assert.equal(received[0].payload?.$case, 'task')
      const first = received[0].payload
      assert.equal(first?.$case, 'task')
      if (first?.$case !== 'task') throw new Error('Missing initial task')
      const final = await client.getTask(GetTaskRequest.fromJSON({ id: first.value.id }))
      assert.equal(final.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.equal(final.artifacts[0].parts[0].content?.value, 'p: hello')
      const replay = []
      for await (const event of client.resubscribeTask({ id: final.id, tenant: '' })) replay.push(event)
      assert.equal(replay[0].payload?.$case, 'task')
      for (const [index, projectId] of ['p', 'q'].entries()) {
        const context: ExecutionContext = {
          projectId, sessionId: 'web:test', physicalSessionId: 'test_0', messageId: 'input',
          channel: 'web', chatId: 'test', senderId: 'human', signal: new AbortController().signal,
          toolCallId: 'call1', tools: new SessionTools(new Tools(root), root),
        }
        const tools = clients[index].tools()
        const send = tools.find(tool => tool.name === 'a2a_send')!
        const get = tools.find(tool => tool.name === 'a2a_get')!
        const submitted = JSON.parse(await send.execute({ agent: 'peer', message: 'roundtrip' }, context))
        const duplicate = JSON.parse(await send.execute({ agent: 'peer', message: 'roundtrip' }, context))
        assert.equal(submitted.handle, duplicate.handle)
        let result = JSON.parse(await get.execute({ handle: submitted.handle }, context))
        if (result.status !== 'completed') {
          await wait(services[1 - index], submitted.taskId)
          result = JSON.parse(await get.execute({ handle: submitted.handle }, context))
        }
        assert.equal(result.status, 'completed')
        assert.equal(result.result.artifacts[0].parts[0].text, `${projectId === 'p' ? 'q' : 'p'}: roundtrip`)
        await assert.rejects(get.execute({ handle: submitted.handle }, { ...context, sessionId: 'web:other' }), /Unknown A2A call/)
        await assert.rejects(send.execute({ agent: 'peer', message: 'changed' }, context), /different arguments/)
      }
      const response = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: final.id, tenant: 'q' } }),
      })
      assert((await response.json()).error)
      const noVersion = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(noVersion.status, 400)
      const tooLarge = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: ' '.repeat(100_000) })
      assert.equal(tooLarge.status, 413)
      const malformed = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'malformed', method: 'SendMessage',
          params: { message: { messageId: 'numeric-text', role: 'ROLE_USER', parts: [{ text: 42 }] } } }),
      })
      assert.equal((await malformed.json()).error.code, -32602)
    } finally {
      if (tokenEnv === undefined) delete process.env.A2A_TEST_TOKEN
      else process.env.A2A_TEST_TOKEN = tokenEnv
      for (const client of clients) await client.close()
      for (const service of services) await service.close()
      http.close()
      await once(http, 'close')
    }
  })

})

test('outbound journal preserves uncertain submissions across restart and exposes remote failure', async t => {
  await withTempWorkspace(async root => {
    const config = A2aConfigSchema.parse({ agents: { peer: {
      cardUrl: 'https://peer.invalid/card', endpointUrl: 'https://peer.invalid/a2a',
    } } })
    const taskId = randomUUID()
    const contextId = randomUUID()
    let deliveryFails = true
    let sends = 0
    t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
      if (url.href.endsWith('/card')) return Response.json({
        name: 'Peer', supportedInterfaces: [{ url: 'https://peer.invalid/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], capabilities: {},
      })
      const rpc = JSON.parse(String(options.body))
      sends++
      if (deliveryFails) throw new Error('Synthetic lost response after acceptance')
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { task: {
        id: taskId, contextId, status: { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString() },
      } } })
    })
    const store = new A2aStore(join(root, 'tasks')); store.init()
    const context: ExecutionContext = {
      projectId: 'p', sessionId: 'web:test', physicalSessionId: 'test_0', messageId: 'input',
      channel: 'web', chatId: 'test', senderId: 'human', signal: new AbortController().signal,
      toolCallId: 'call1', tools: new SessionTools(new Tools(root), root),
    }
    const client = new A2aClientTools('p', config, store)
    try {
      await assert.rejects(client.tools().find(tool => tool.name === 'a2a_send')!.execute({ agent: 'peer', message: 'work' }, context), /unknown.*handle/i)
      const uncertain = [...store.outbound.values()][0]
      assert.equal(uncertain.status, 'uncertain')
      await client.close()
      const restoredStore = new A2aStore(join(root, 'tasks')); restoredStore.init()
      const restored = new A2aClientTools('p', config, restoredStore)
      try {
        const send = restored.tools().find(tool => tool.name === 'a2a_send')!
        const retry = JSON.parse(await send.execute({ agent: 'peer', message: 'work' }, context))
        assert.equal(retry.status, 'uncertain')
        assert.equal(sends, 1, 'Restart and duplicate admission must not repeat a possibly accepted call')
        deliveryFails = false
        const failed = JSON.parse(await send.execute({ agent: 'peer', message: 'different task' }, { ...context, toolCallId: 'call2' }))
        assert.equal(failed.status, 'failed')
        assert.equal(sends, 2)
      } finally { await restored.close() }
    } finally { await client.close() }
  })
})

test('outbound fetch never follows a card-selected endpoint or redirects', async () => {
  const safeFetch = a2aFetch({ cardUrl: 'https://example.invalid/card', endpointUrl: 'https://example.invalid/a2a' }, new AbortController().signal)
  await assert.rejects(safeFetch('https://other.invalid/a2a', { method: 'POST' }), /unapproved/)
  await assert.rejects(safeFetch('https://example.invalid/a2a?token=secret', { method: 'POST' }), /unapproved/)
  await assert.rejects(safeFetch('https://example.invalid/card', { method: 'POST' }), /unapproved/)
})
