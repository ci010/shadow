import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { createOrganizationScope, getOrganizationScope } from '../organizations/scope.ts'
import { EvalBridgeRuntime, registerEvalBridgeRoute, startToolBridge } from './bridge.ts'

test('eval bridges dispatch identical session/tool names only within the bound runtime and injected gateway', async () => {
  const scopes = [createOrganizationScope('org-a'), createOrganizationScope('org-b')]
  const runtimes = scopes.map((scope) => new EvalBridgeRuntime({
    organizationId: scope.organizationId, scope,
    gatewayBaseUrl: `http://127.0.0.1:4321/api/organizations/${scope.organizationId}`,
  }))
  const apps = runtimes.map((runtime) => {
    const app = new Hono()
    registerEvalBridgeRoute(app, runtime)
    return app
  })
  const seen: string[] = []
  const contexts = scopes.map((scope, i) => {
    const tools = new Tools('.')
    tools.register({
      name: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        await new Promise<void>((resolve) => setTimeout(resolve, i === 0 ? 10 : 1))
        assert.equal(getOrganizationScope(), scope)
        assert.equal(ctx.sessionId, 'same-session')
        seen.push(scope.organizationId)
        return scope.organizationId
      },
    })
    return {
      organizationId: scope.organizationId, evalBridge: runtimes[i],
      sessionId: 'same-session', physicalSessionId: 'same-physical', channel: 'test',
      chatId: 'same-chat', senderId: 'same-user', messageId: 'same-input',
      tools: new SessionTools(tools, '.'), signal: new AbortController().signal,
    } satisfies ExecutionContext & { organizationId: string; evalBridge: EvalBridgeRuntime }
  })
  const bridges = contexts.map((ctx) => startToolBridge(ctx.tools, ctx))
  const paths = bridges.map((bridge, i) => new URL(bridge.url).pathname.replace(`/api/organizations/${scopes[i].organizationId}`, ''))
  const request = (app: Hono, path: string, body: unknown = { name: 'fixture' }) => app.request(`${path}/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const results = await Promise.all(apps.map(async (app, i) => {
      assert.match(bridges[i].url, new RegExp(`:4321/api/organizations/${scopes[i].organizationId}/eval/`))
      assert.equal((await request(app, paths[1 - i])).status, 404)
      assert.equal((await app.request(`${paths[1 - i]}/tools`)).status, 404)
      const response = await request(app, paths[i])
      return response.json()
    }))
    assert.deepEqual(results, [{ ok: true, result: 'org-a' }, { ok: true, result: 'org-b' }])
    assert.deepEqual(seen.sort(), ['org-a', 'org-b'])
    for (const body of [null, [], { name: 'fixture', args: [] }, { name: 'fixture', args: null }]) {
      assert.equal((await request(apps[0], paths[0], body)).status, 400)
    }
    assert.throws(() => runtimes[0].startToolBridge(contexts[1].tools, contexts[1]), /binding mismatch/)
    assert.throws(() => runtimes[0].startToolBridge(contexts[1].tools, contexts[0]), /tools must belong/)
    assert.throws(() => scopes[1].run(() => startToolBridge(contexts[0].tools, contexts[0])), /binding mismatch/)
    const unbound = { ...contexts[0], evalBridge: undefined }
    assert.throws(() => startToolBridge(contexts[0].tools, unbound), /injected eval bridge/)
    assert.throws(() => runtimes[0].setGatewayBaseUrl('http://localhost:1234'), /bridges are active/)
    const concurrent = startToolBridge(contexts[0].tools, contexts[0])
    bridges[0].cleanup()
    bridges[0].cleanup()
    assert.equal((await request(apps[0], paths[0])).status, 404)
    const concurrentPath = new URL(concurrent.url).pathname.replace('/api/organizations/org-a', '')
    assert.equal((await request(apps[0], concurrentPath)).status, 200)
    await runtimes[0].shutdown()
    assert.equal((await request(apps[0], concurrentPath)).status, 404)
    assert.throws(() => startToolBridge(contexts[0].tools, contexts[0]), /closed/)
    assert.deepEqual(await (await request(apps[1], paths[1])).json(), { ok: true, result: 'org-b' })
    concurrent.cleanup()
  } finally {
    bridges.forEach((bridge) => bridge.cleanup())
    await Promise.all(runtimes.map((runtime) => runtime.shutdown()))
    scopes.forEach((scope) => scope.close())
  }
})

test('organization eval bindings reject invalid gateway bases and legacy dispatch', () => {
  const scope = createOrganizationScope('org')
  for (const gatewayBaseUrl of ['file:///local', 'http://user:password@localhost', 'http://localhost?x=1']) {
    assert.throws(() => new EvalBridgeRuntime({ scope, organizationId: 'org', gatewayBaseUrl }))
  }
  assert.throws(() => new EvalBridgeRuntime({ scope, organizationId: 'other', gatewayBaseUrl: 'http://localhost' }), /matching live/)
  scope.close()
  assert.throws(() => new EvalBridgeRuntime({ scope, organizationId: 'org', gatewayBaseUrl: 'http://localhost' }), /matching live/)
})

test('eval runtime teardown aborts and drains accepted tool calls and retires their registrations', async () => {
  const scope = createOrganizationScope('org')
  const runtime = new EvalBridgeRuntime({ organizationId: 'org', scope, gatewayBaseUrl: 'http://localhost:4321' })
  const app = new Hono()
  registerEvalBridgeRoute(app, runtime)
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const tools = new Tools('.')
  tools.register({
    name: 'pending', description: '', parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      entered.resolve(ctx.signal)
      await release.promise
      ctx.signal.throwIfAborted()
      return 'must not succeed'
    },
  })
  const ctx = {
    organizationId: 'org', evalBridge: runtime, sessionId: 'same', physicalSessionId: 'same-1',
    channel: 'test', chatId: 'same', senderId: 'user', messageId: 'input',
    tools: new SessionTools(tools, '.'), signal: new AbortController().signal,
  } satisfies ExecutionContext & { organizationId: string; evalBridge: EvalBridgeRuntime }
  const bridge = startToolBridge(ctx.tools, ctx)
  const path = new URL(bridge.url).pathname
  const pending = app.request(`${path}/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pending' }),
  })
  try {
    const signal = await entered.promise
    let closed = false
    const stopping = runtime.shutdown().then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(signal.aborted, true)
    assert.equal(closed, false)
    assert.equal((await app.request(`${path}/tools`)).status, 404)
    release.resolve()
    await stopping
    const result = await (await pending).json()
    assert.match(JSON.stringify(result), /Eval runtime stopped/)
    assert.doesNotMatch(JSON.stringify(result), /must not succeed/)
  } finally {
    release.resolve()
    await pending
    bridge.cleanup()
    await runtime.shutdown()
    scope.close()
  }
})

test('legacy bridge compatibility accepts only unowned contexts and cannot dispatch from an organization scope', async () => {
  const app = new Hono()
  registerEvalBridgeRoute(app)
  const ctx: ExecutionContext = {
    sessionId: 'legacy', physicalSessionId: 'legacy-1', channel: 'test', chatId: 'legacy',
    senderId: 'user', messageId: 'input', signal: new AbortController().signal,
    tools: new SessionTools(new Tools('.'), '.'),
  }
  const bridge = startToolBridge(ctx.tools, ctx)
  const path = new URL(bridge.url).pathname
  const scope = createOrganizationScope('org')
  try {
    assert.deepEqual(await (await app.request(`${path}/tools`)).json(), [])
    assert.throws(() => scope.run(() => startToolBridge(ctx.tools, ctx)), /injected eval bridge/)
    const scoped = await scope.run(() => app.request(`${path}/tools`))
    assert.equal(scoped.status, 403)
    assert.match(JSON.stringify(await scoped.json()), /Legacy eval bridge cannot run/)
    bridge.cleanup()
    assert.equal((await app.request(`${path}/tools`)).status, 404)
  } finally {
    bridge.cleanup()
    scope.close()
  }
})
