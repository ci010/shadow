import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'
import { bindScriptTools, EvalBridgeRuntime } from './bridge.ts'

function context(tools: SessionTools, runtime?: EvalBridgeRuntime): ExecutionContext {
  return {
    ...(runtime ? { projectId: runtime.options.projectId, evalBridge: runtime } : {}),
    sessionId: 'logical', physicalSessionId: 'physical', channel: 'test', chatId: 'chat',
    senderId: 'user', messageId: 'input', toolCallId: 'outer', toolCallName: 'exec',
    tools, signal: new AbortController().signal,
  }
}

test('direct bindings preserve project scope, session filtering and unique tool-call identities', async () => {
  const scope = createProjectScope('direct')
  const other = createProjectScope('other')
  const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
  const base = new Tools('.')
  const seen: ExecutionContext[] = []
  for (const name of ['allowed', 'blocked']) {
    base.register({
      name, description: '', parameters: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        assert.equal(getProjectScope(), scope)
        seen.push(ctx)
        return '{"answer":42}'
      },
    })
  }
  const ctx = context(new SessionTools(base, '.', ['allowed']), runtime)
  const binding = bindScriptTools(ctx)
  try {
    assert.deepEqual(binding.names, ['allowed'])
    assert.deepEqual(await binding.call('allowed', {}, ctx.signal), { answer: 42 })
    assert.deepEqual(await binding.call('allowed', {}, ctx.signal), { answer: 42 })
    assert.match(String(await binding.call('blocked', {}, ctx.signal)), /not available/)
    assert.equal(seen.length, 2)
    assert(seen.every(call => call.sessionId === 'logical' && call.physicalSessionId === 'physical' && call.toolCallName === 'allowed'))
    assert(seen.every(call => call.toolCallId !== 'outer'))
    assert(seen.every(call => call.scriptInvocation === true))
    assert.notEqual(seen[0].toolCallId, seen[1].toolCallId)
    assert.throws(() => other.run(() => bindScriptTools(ctx)), /binding mismatch/)
    await assert.rejects(other.run(() => binding.call('allowed', {}, ctx.signal)), /binding mismatch/)
    await binding.cleanup()
    await assert.rejects(binding.call('allowed', {}, ctx.signal), /closed/)
  } finally {
    await binding.cleanup()
    await runtime.shutdown()
    scope.close()
    other.close()
  }
})

test('project shutdown aborts and drains accepted direct calls even after binding cleanup', async () => {
  const scope = createProjectScope('direct')
  const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
  const base = new Tools('.')
  const entered = Promise.withResolvers<AbortSignal>()
  const released = Promise.withResolvers<void>()
  base.register({
    name: 'pending', description: '', parameters: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      entered.resolve(ctx.signal)
      await released.promise
      return 'done'
    },
  })
  const ctx = context(new SessionTools(base, '.'), runtime)
  const binding = bindScriptTools(ctx)
  const pending = binding.call('pending', {}, ctx.signal)
  try {
    const signal = await entered.promise
    await binding.cleanup()
    let stopped = false
    const stopping = runtime.shutdown().then(() => { stopped = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(signal.aborted, true)
    assert.equal(binding.signal.aborted, true)
    assert.equal(stopped, false)
    released.resolve()
    await pending
    await stopping
    assert.throws(() => bindScriptTools(ctx), /closed/)
  } finally {
    released.resolve()
    await pending
    await runtime.shutdown()
    scope.close()
  }
})

test('dynamic opt-in resolves lazy siblings through invoke_tool and validates active tools', async () => {
  const base = new Tools('.')
  const imported: string[] = []
  const seen: ExecutionContext[] = []
  base.register(new InvokeTool({
    async importForInvocation(name, tools, signal) {
      signal?.throwIfAborted()
      imported.push(name)
      tools.registerDynamic({
        name, description: '',
        parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        async execute(input, ctx) {
          seen.push(ctx)
          return JSON.stringify({ value: input.value })
        },
      })
      return undefined
    },
  }))
  let baseCalls = 0
  base.register({
    name: 'base_tool', description: '', parameters: { type: 'object', properties: {} },
    async execute() { baseCalls++; return 'base' },
  })
  const ctx = context(new SessionTools(base, '.', undefined, ['base_tool', 'blocked_sibling']))
  const binding = bindScriptTools(ctx, { dynamic: true })
  try {
    assert.deepEqual(binding.names, ['invoke_tool'])
    const baseOnly = bindScriptTools(ctx)
    try {
      assert.match(String(await baseOnly.call('sibling', { value: 0 }, ctx.signal)), /unknown tool/)
      assert.deepEqual(imported, [])
    } finally { await baseOnly.cleanup() }
    assert.deepEqual(await binding.call('sibling', { value: 1 }, ctx.signal), { value: 1 })
    assert.deepEqual(await binding.call('sibling', { value: 2 }, ctx.signal), { value: 2 })
    assert.match(String(await binding.call('sibling', { value: 'wrong' }, ctx.signal)), /invalid arguments/)
    assert.match(String(await binding.call('base_tool', {}, ctx.signal)), /not available/)
    assert.match(String(await binding.call('blocked_sibling', {}, ctx.signal)), /not available/)
    assert.equal(baseCalls, 0)
    assert.deepEqual(imported, ['sibling'])
    assert.equal(seen.length, 2)
    assert(seen.every(call => call.toolCallName === 'sibling' && call.toolCallId !== 'outer'))
    assert(seen.every(call => call.scriptInvocation === true))
    assert.notEqual(seen[0].toolCallId, seen[1].toolCallId)
    const denied = bindScriptTools(context(new SessionTools(base, '.', ['base_tool'])), { dynamic: true })
    try {
      assert.match(String(await denied.call('other_sibling', {}, ctx.signal)), /not available/)
      assert.deepEqual(imported, ['sibling'])
    } finally { await denied.cleanup() }
  } finally { await binding.cleanup() }
})

test('binding cleanup revokes immediately even when an accepted tool ignores cancellation', async () => {
  const base = new Tools('.')
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  base.register({
    name: 'stubborn', description: '', parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      entered.resolve(ctx.signal)
      await release.promise
      return 'released'
    },
  })
  const ctx = context(new SessionTools(base, '.'))
  const binding = bindScriptTools(ctx)
  const pending = binding.call('stubborn', {}, ctx.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const signal = await entered.promise
    await Promise.race([
      binding.cleanup(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('cleanup waited for tool')), 200) }),
    ])
    assert.equal(signal.aborted, true)
    await assert.rejects(binding.call('stubborn', {}, ctx.signal), /closed/)
  } finally {
    clearTimeout(timer)
    release.resolve()
    await pending
    await binding.cleanup()
  }
})

test('direct bindings isolate identical session/tool names across concurrent project runtimes', async () => {
  const scopes = [createProjectScope('org-a'), createProjectScope('org-b')]
  const runtimes = scopes.map(scope => new EvalBridgeRuntime({ projectId: scope.projectId, scope }))
  const contexts = scopes.map((scope, i) => {
    const base = new Tools('.')
    base.register({
      name: 'fixture', description: '', parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        await new Promise<void>(resolve => setTimeout(resolve, i === 0 ? 10 : 1))
        assert.equal(getProjectScope(), scope)
        assert.equal(ctx.sessionId, 'logical')
        return scope.projectId
      },
    })
    return context(new SessionTools(base, '.'), runtimes[i])
  })
  const bindings = contexts.map(ctx => bindScriptTools(ctx))
  const call = (index: number) => bindings[index].call('fixture', {}, contexts[index].signal)
  try {
    assert.deepEqual(await Promise.all([call(0), call(1)]), ['org-a', 'org-b'])
    assert.throws(() => runtimes[0].bindTools(contexts[1]), /binding mismatch/)
    assert.throws(() => bindScriptTools({ ...contexts[0], evalBridge: undefined }), /injected eval bridge/)
    const concurrent = bindScriptTools(contexts[0])
    await bindings[0].cleanup()
    await bindings[0].cleanup()
    await assert.rejects(call(0), /closed/)
    assert.equal(await concurrent.call('fixture', {}, contexts[0].signal), 'org-a')
    await runtimes[0].shutdown()
    await assert.rejects(concurrent.call('fixture', {}, contexts[0].signal), /closed/)
    assert.throws(() => bindScriptTools(contexts[0]), /closed/)
    assert.equal(await call(1), 'org-b')
    await concurrent.cleanup()
  } finally {
    await Promise.all(bindings.map(binding => binding.cleanup()))
    await Promise.all(runtimes.map(runtime => runtime.shutdown()))
    scopes.forEach(scope => scope.close())
  }
})

test('project script bindings reject mismatched and closed scopes', () => {
  const scope = createProjectScope('org')
  assert.throws(() => new EvalBridgeRuntime({ scope, projectId: 'other' }), /matching live/)
  scope.close()
  assert.throws(() => new EvalBridgeRuntime({ scope, projectId: 'org' }), /matching live/)
})

test('unowned direct bindings cannot enter a project runtime', async () => {
  const ctx = context(new SessionTools(new Tools('.'), '.'))
  const binding = bindScriptTools(ctx)
  const scope = createProjectScope('org')
  try {
    assert.deepEqual(binding.names, [])
    assert.throws(() => scope.run(() => bindScriptTools(ctx)), /injected eval bridge/)
    await assert.rejects(scope.run(() => binding.call('tool', {}, ctx.signal)), /Unowned script cannot run/)
    await binding.cleanup()
    await assert.rejects(binding.call('tool', {}, ctx.signal), /closed/)
  } finally {
    await binding.cleanup()
    scope.close()
  }
})
