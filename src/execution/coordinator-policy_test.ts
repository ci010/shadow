import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CoordinatorExecutionPolicy } from './coordinator-policy.ts'
import type { Executor } from './executor.ts'
import type { ProcessManager } from './processes/manager.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { ImportTool, type LoadableEntry } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { ExecTool } from '../tools/shell.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { requireToolText, type Tool } from '../tools/tool.ts'

function fixture() {
  const policy = new CoordinatorExecutionPolicy()
  const base = new Tools(process.cwd())
  base.setExecutionPolicy(policy.check)
  const tools = new SessionTools(base, process.cwd())
  const context = { sessionId: 'session', physicalSessionId: 'physical', messageId: 'turn',
    signal: new AbortController().signal, tools } as ExecutionContext
  return { policy, base, tools, context }
}

function tool(name: string, execute: Tool['execute']): Tool {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute }
}

test('coordinator policy allows exact reviewed objects; unknown and name-spoofed tools fail before effects, including snapshots', async () => {
  const { policy, base, tools, context } = fixture()
  const read = tool('read', async () => 'stored data')
  policy.allow(read)
  base.register(read)
  base.register(tool('custom', async () => assert.fail('unreviewed tool ran')))
  for (const overlay of [tools, tools.snapshot(), tools.createIsolated()]) {
    assert.equal(await overlay.execute('read', {}, { ...context, tools: overlay }), 'stored data')
    assert.match(requireToolText(await overlay.execute('custom', {}, { ...context, tools: overlay })), /local executor is disabled/)
    overlay.registerDynamic(tool('read', async () => assert.fail('spoofed tool ran')))
    assert.match(requireToolText(await overlay.executeDynamic('read', {}, { ...context, tools: overlay })), /local executor is disabled/)
  }
})

test('coordinator exec denies foreground, background and inline Node locally; remote dispatch works and failures never fall back', async () => {
  const { policy, base, tools, context } = fixture()
  const exec = new ExecTool(process.cwd(), 1000, new CommandHandlerManager(), {
    spawn: () => assert.fail('Main spawn'),
  } as unknown as ProcessManager, 'node', {} as BackgroundTaskManager, {
    startProcess: async () => assert.fail('Main executor'),
  })
  base.register(exec)
  policy.allowRemoteShell(exec)
  for (const args of [{ script: 'forbidden' }, { script: 'forbidden', timeout_ms: 0 }, { script: 'forbidden', shell: 'node' }]) {
    assert.match(requireToolText(await tools.execute('exec', args, context)), /local executor is disabled/)
  }
  let dispatched = 0
  let offline = false
  const executor: Executor = {
    async *execute(request) {
      dispatched++
      if (offline) throw new Error('Child offline')
      assert.equal(request.nodeId, 'child')
      assert.deepEqual(request.args, { script: 'pwd' })
      yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: 'completed',
        receipt: { version: 1, jobId: request.jobId, nodeId: 'child', state: 'completed', exitCode: 0, finishedAt: new Date().toISOString() } }
    },
    getStatus: async () => null,
    cancel: async () => { throw new Error('unexpected cancel') },
  }
  const remote = { ...context, remoteWorkdir: { nodeId: 'child', workdirId: 'opaque', executor } }
  for (const mode of ['session', 'task'] as const) {
    tools.setExecutionScope(mode, [])
    assert.equal(await tools.execute('exec', { script: 'pwd' }, remote), '(no output, exit code 0)')
  }
  assert.equal(dispatched, 2)
  assert.match(requireToolText(await tools.execute('exec', { script: 'pwd', shell: 'node' }, remote)), /not supported on remote/)
  tools.setExecutionScope('call', [])
  assert.match(requireToolText(await tools.execute('exec', { script: 'pwd' }, remote)), /remote workdirs/)
  assert.equal(dispatched, 2)
  tools.setExecutionScope('task', [])
  offline = true
  assert.match(requireToolText(await tools.execute('exec', { script: 'pwd' }, remote)), /Child offline/)
  assert.equal(dispatched, 3)
})

test('coordinator import gate precedes factory, MCP, JSON config loading and invoke_tool auto-import; reviewed builtins still work', async () => {
  const { policy, base, tools, context } = fixture()
  const safe = tool('coordinate', async () => 'coordinated')
  const entries = new Map<string, LoadableEntry>([
    ['coordinate', safe],
    ['custom_factory', { factory: async () => assert.fail('factory initialized') }],
    ['host_mcp', { config: { name: 'host_mcp', transport: 'stdio', command: 'must-never-launch' } }],
    ['host_builtin', tool('host_builtin', async () => assert.fail('host builtin executed'))],
  ])
  const importer = new ImportTool(entries, process.cwd(), undefined, undefined, undefined, policy.canImport)
  const invoke = new InvokeTool(importer)
  base.register(invoke)
  policy.allow(invoke)
  policy.allow(safe)
  // The startup/config-refresh catalog path must remain metadata-only while OFF.
  await importer.updateMcpServers([{ name: 'configured_mcp', transport: 'stdio', command: 'must-never-launch' }])
  for (const name of ['custom_factory', 'host_mcp', 'host_builtin', 'configured_mcp']) {
    assert.match(await importer.importSource({ source: `v:tools/${name}` }, tools), /local executor is disabled/)
    assert.match(requireToolText(await tools.execute('invoke_tool', { name, args: {} }, context)), /local executor is disabled/)
  }
  assert.match(await importer.importSource({ source: 'does-not-exist.json' }, tools), /local executor is disabled/)
  assert.equal(await tools.execute('invoke_tool', { name: 'coordinate', args: {} }, context), 'coordinated')
})

test('legacy registries and loaders without coordinator policy remain enabled', async () => {
  const base = new Tools(process.cwd())
  const safe = tool('legacy', async () => 'enabled')
  base.register(safe)
  const tools = new SessionTools(base, process.cwd())
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  assert.equal(await tools.execute('legacy', {}, context), 'enabled')
  let initialized = false
  const importer = new ImportTool(new Map([['factory', { factory: async () => { initialized = true; return safe } }]]), process.cwd())
  await importer.importSource({ source: 'v:tools/factory' }, tools)
  assert.equal(initialized, true)
})


test('coordinator refuses virtual MCP configuration writes before executable indexing, including VFS aliases', async () => {
  const { policy, base, tools, context } = fixture()
  const writer = tool('write', async () => 'file stored')
  base.register(writer)
  policy.allow(writer)
  for (const path of ['v:config/mcp.json', '/v:config/mcp.json', '\\v:config\\mcp.json', 'V:CONFIG/mcp.json']) {
    assert.match(requireToolText(await tools.execute('write', { path, content: '{}' }, context)), /MCP configuration writes are unavailable/)
  }
  assert.equal(await tools.execute('write', { path: 'notes.md', content: 'retained' }, context), 'file stored')
})
