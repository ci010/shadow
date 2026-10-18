import assert from 'node:assert/strict'
import test from 'node:test'
import { DevelopmentRestartTool, developmentRestartAvailable, registerDevelopmentRestart } from './development-restart.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { SessionTools, Tools } from './registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

function fixture() {
  const sent: unknown[] = [], callbacks: Array<() => void> = [], timers: Array<() => void> = [], errors: unknown[] = []
  const runtime = { env: { SHADOW_DEV_RESTART_TOOL: '1', SHADOW_DESKTOP_DEV_IPC: '1' } as NodeJS.ProcessEnv,
    parentPort: { postMessage(message: unknown) { sent.push(message) } } }
  const tool = new DevelopmentRestartTool(runtime, (callback, delay) => { assert.equal(delay, 1500); timers.push(callback) }, error => errors.push(error))
  const context: ExecutionContext = { sessionId: 'web:fixture', physicalSessionId: 'fixture', channel: 'web', chatId: 'fixture',
    senderId: 'fixture', messageId: 'fixture', tools: new SessionTools(new Tools(process.cwd()), process.cwd()), admin: true, toolCallName: 'invoke_tool', signal: new AbortController().signal,
    afterToolResultPublished: (callback: () => void) => { callbacks.push(callback) } }
  return { runtime, tool, context, sent, callbacks, timers, errors }
}

test('production, disconnected and non-supervised runtimes cannot register or invoke restart', async () => {
  for (const patch of [{ NODE_ENV: 'production' }, { SHADOW_DEV_RESTART_TOOL: undefined }, { SHADOW_DESKTOP_DEV_IPC: undefined }]) {
    const f = fixture()
    Object.assign(f.runtime.env, patch)
    const names: string[] = []
    registerDevelopmentRestart({ registerBuiltin: name => { names.push(name) } }, f.runtime, f.tool)
    assert.deepEqual(names, [])
    assert.match(await f.tool.execute({}, f.context), /^Error:/)
    assert.equal(f.callbacks.length, 0)
  }
  assert.equal(developmentRestartAvailable({ env: { SHADOW_DEV_RESTART_TOOL: '1', SHADOW_DESKTOP_DEV_IPC: '1' } }), false)
})

test('execution boundary rejects unauthorized, remote, nested, recovered and unpublished calls', async () => {
  for (const patch of [{ admin: false }, { remoteWorkdir: {} }, { scriptInvocation: true }, { recoveringToolCall: true },
    { afterToolResultPublished: undefined }, { toolCallName: 'exec' }]) {
    const f = fixture()
    assert.match(await f.tool.execute({}, { ...f.context, ...patch } as ExecutionContext), /^Error:/)
    assert.equal(f.callbacks.length, 0)
  }
  const f = fixture()
  assert.match(await f.tool.execute({ unexpected: true }, f.context), /^Error:/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.tool.execute({}, { ...f.context, signal: controller.signal }), /abort/i)
})

test('receipt publication precedes delay; simultaneous Projects/calls request only one restart', async () => {
  const f = fixture()
  assert.match(await f.tool.execute({}, f.context), /receipt is saved and published/)
  await f.tool.execute({}, f.context)
  assert.equal(f.sent.length, 0)
  assert.equal(f.timers.length, 0)
  f.callbacks.forEach(callback => callback())
  assert.equal(f.sent.length, 0)
  assert.equal(f.timers.length, 1)
  f.timers[0]()
  assert.deepEqual(f.sent, [{ type: 'shadow:dev-restart' }])
  assert.match(await f.tool.execute({}, f.context), /already pending/)
})

test('revoked runtime and cancelled unpublished receipt never request restart; IPC errors allow retry', async () => {
  const f = fixture()
  await f.tool.execute({}, f.context)
  f.runtime.env.NODE_ENV = 'production'
  f.callbacks[0]()
  assert.equal(f.timers.length, 0)
  delete f.runtime.env.NODE_ENV
  const controller = new AbortController()
  await f.tool.execute({}, { ...f.context, signal: controller.signal })
  controller.abort(); f.callbacks[1]()
  assert.equal(f.timers.length, 0)
  await f.tool.execute({}, f.context); f.callbacks[2]()
  f.runtime.parentPort.postMessage = () => { throw new Error('closed') }
  f.timers[0]()
  assert.equal(f.errors.length, 1)
  assert.doesNotMatch(await f.tool.execute({}, f.context), /already pending/)
})

test('dev catalog is lazily invocable, production catalog is absent even on exact-name invocation', async () => withTempWorkspace(async home => {
  for (const enabled of [false, true]) {
    const f = fixture()
    if (!enabled) f.runtime.env.NODE_ENV = 'production'
    const importer = new ImportTool(new Map(), home)
    registerDevelopmentRestart(importer, f.runtime, f.tool)
    assert.equal(importer.isBuiltinName('development_restart'), enabled)
    const tools = new Tools(home)
    tools.register(new InvokeTool(importer))
    tools.register(new ReadTool(home))
    const sessionTools = new SessionTools(tools, home)
    const metadata = await importer.virtualEntries({ ...f.context, tools: sessionTools, cwd: home })
    assert.equal(metadata.some(entry => entry.name === 'development_restart'), enabled)
    assert.equal(importer.catalogEntries(sessionTools).some(entry => entry.name === 'development_restart'), enabled)
    const result = await new InvokeTool(importer).execute({ name: 'development_restart', args: {} }, { ...f.context, tools: sessionTools, cwd: home })
    assert.equal(typeof result, 'string')
    assert.match(result as string, enabled ? /Development restart requested/ : /^Error:/)
    assert.equal(sessionTools.hasDynamic('development_restart'), enabled)
    assert(!JSON.stringify(sessionTools.getDefinitions()).includes('development_restart'))
    assert.equal(f.sent.length, 0)
  }
}))
