import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { rm } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { McpConnection } from '../mcp/client.ts'
import { McpToolIndex } from '../mcp/tool-index.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { registerCronTools } from './cron.ts'
import type { CronService } from '../cron/service.ts'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'
import { Tools, SessionTools } from './registry.ts'
import { requireToolText, type Tool } from './tool.ts'

const schema = {
  type: 'object', properties: { query: { type: 'string', minLength: 1 }, count: { type: 'integer', maximum: 10 } },
  required: ['query'], additionalProperties: false,
}
const config = { name: 'mail', transport: 'stdio' as const, command: 'synthetic-never-run' }
const advertised = [{ name: 'SearchMessages', description: 'Search messages by subject and sender.', inputSchema: schema }]

async function setup(t: TestContext, builtins = new Map<string, LoadableEntry>()) {
  const home = await createTempWorkspace()
  const index = new McpToolIndex(home)
  const importer = new ImportTool(builtins, home, undefined, undefined, index)
  const vfs = new VirtualFs()
  vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, opts) => importer.virtualEntries(ctx, opts))
  const base = new Tools(home)
  base.register(new SearchTool(home, undefined, vfs))
  base.register(new ReadTool(home, vfs))
  base.register(new InvokeTool(importer))
  const tools = new SessionTools(base, home)
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', () => {})
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => advertised)
  const call = t.mock.method(McpConnection.prototype, 'callTool', async () => 'success')
  await importer.updateMcpServers([config])
  await index.store(config, advertised)
  t.after(async () => {
    await tools.resetDynamicAndWait()
    await rm(home, { recursive: true, force: true })
  })
  const search = async (args: Record<string, unknown>, ctx = context) =>
    requireToolText(await ctx.tools.execute('search', { handler: 'grep', path: 'v:tools', query: 'subject', ...args }, ctx))
  const read = async (path = 'v:tools/mail/mail__SearchMessages', ctx = context) =>
    requireToolText(await ctx.tools.execute('read', { path }, ctx))
  const invoke = (args: Record<string, unknown>) => tools.execute('invoke_tool', { name: 'mail__SearchMessages', args }, context)
  return { home, index, importer, base, tools, context, connect, list, call, search, read, invoke }
}

test('VFS searches names, descriptions and full schemas; read returns exact contracts without connecting', async t => {
  const f = await setup(t)
  assert.equal(await f.search({ handler: 'glob', path: 'v:tools/mail', query: '*__*' }), 'v:tools/mail/mail__SearchMessages')
  for (const query of ['subject', '"query"', '"maximum": 10']) {
    assert.match(await f.search({ query }), /v:tools\/mail__SearchMessages/)
  }
  assert.deepEqual(JSON.parse(await f.read()).parameters, schema)
  assert.equal(JSON.parse(await f.read()).name, 'mail__SearchMessages')
  assert.equal(typeof JSON.parse(await f.read()).indexedAt, 'string')
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(f.tools.activeDynamicTools().length, 0)
  assert.equal(await f.invoke({ query: 'hello' }), 'success')
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 1)
  assert(!f.tools.getDefinitions().some(tool => tool.function.name === 'mail__SearchMessages'))
})

test('indexed tool reads expose readonly review identity offline and refresh from live metadata', async t => {
  const f = await setup(t)
  const initial = JSON.parse(await f.read()).readOnlyPolicy
  assert.equal(initial.readOnly, null)
  assert.equal(initial.source, 'unknown')
  assert.match(initial.fingerprint, /^[a-f0-9]{64}$/)
  const trusted = { ...config, trustReadOnlyHints: true }
  const tool = { ...advertised[0], readOnlyHint: true, serverVersion: { name: 'fixture', version: '1' } }
  await f.importer.updateMcpServers([trusted])
  await f.index.store(trusted, [tool])
  const indexed = JSON.parse(await f.read()).readOnlyPolicy
  assert.equal(indexed.readOnly, true)
  assert.equal(indexed.source, 'trusted-hint')
  assert.notEqual(indexed.fingerprint, initial.fingerprint)
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
  f.list.mock.mockImplementation(async () => [{ ...tool, readOnlyHint: false }])
  assert.equal(await f.invoke({ query: 'read' }), 'success')
  const live = JSON.parse(await f.read()).readOnlyPolicy
  assert.equal(live.readOnly, false)
  assert.equal(live.source, 'trusted-hint')
  assert.notEqual(live.fingerprint, indexed.fingerprint)
})

test('invalid arguments never execute and live schemas replace stale indexed metadata', async t => {
  const f = await setup(t)
  for (const args of [{}, { query: 5 }, { query: '' }, { query: 'test', count: 11 }, { query: 'test', extra: 1 }]) {
    assert.match(requireToolText(await f.invoke(args)), /invalid arguments/)
  }
  assert.equal(f.call.mock.callCount(), 0)
  f.tools.resetDynamic()
  const current = { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'], additionalProperties: false }
  f.list.mock.mockImplementation(async () => [{ ...advertised[0], inputSchema: current }])
  assert.match(requireToolText(await f.invoke({ query: 'old' })), /invalid arguments/)
  assert.deepEqual(JSON.parse(await f.read()).parameters, current)
  assert.equal(await f.invoke({ folder: 'inbox' }), 'success')
  f.tools.resetDynamic()
  f.list.mock.mockImplementation(async () => [])
  assert.match(requireToolText(await f.invoke({ folder: 'inbox' })), /not advertised/)
  assert.equal(await f.search({ handler: 'glob', path: 'v:tools/mail', query: '*__*' }), 'No files found')
})

test('uninitialized factories stay deferred, static contracts work, and warnings survive no-match queries', async t => {
  let factories = 0
  const tool: Tool = { name: 'fixture', description: 'Static capability', parameters: { type: 'object', properties: {} }, execute: async () => 'unused' }
  const f = await setup(t, new Map<string, LoadableEntry>([
    ['group', { contracts: [tool], factory: async () => { factories++; return tool } }],
    ['deferred', { factory: async () => { factories++; return tool } }],
  ]))
  assert.match(await f.search({ query: 'Static capability' }), /v:tools\/fixture/)
  const missing = await f.search({ query: 'never matches' })
  assert.match(missing, /No matches found/)
  assert.match(missing, /Warning: v:tools\/@sources__\/deferred:.*does not initialize/)
  assert.match(await f.search({ handler: 'grep', path: 'v:tools/deferred/unknown', query: 'never' }), /Warning:/)
  assert.equal(factories, 0)
  assert.equal(f.connect.mock.callCount(), 0)
})

test('missing or malformed MCP indexes report incomplete coverage without fallback connections', async t => {
  const f = await setup(t)
  await f.importer.updateMcpServers([config, { name: 'missing', transport: 'stdio', command: 'never' }])
  assert.match(await f.search({ query: 'no matches' }), /Warning: v:tools\/@sources__\/missing:.*not indexed/)
  t.mock.method(f.index, 'read', async () => { throw new Error('Malformed tool index') })
  assert.match(await f.search({ handler: 'grep', path: 'v:tools/mail', query: 'nothing' }), /Warning:.*Malformed tool index/)
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
})

test('VFS tool listing is deterministic and paginated; encoded tool names round-trip through read', async t => {
  const f = await setup(t)
  await f.index.store(config, ['a', 'b', 'slash/name%', 'z'].map(name => ({ ...advertised[0], name })))
  const first = await f.search({ handler: 'glob', path: 'v:tools/mail', query: '*__*', limit: 2 })
  assert.equal(first, 'v:tools/mail/mail__a\nv:tools/mail/mail__b\n(Showing 2 of 4 results; continue with offset: 2.)')
  const last = await f.search({ handler: 'glob', path: 'v:tools/mail', query: '*__*', limit: 2, offset: 2 })
  assert.equal(last, 'v:tools/mail/mail__slash%2Fname%25\nv:tools/mail/mail__z')
  assert.equal(JSON.parse(await f.read('v:tools/mail/mail__slash%2Fname%25')).name, 'mail__slash/name%')
  assert.equal(f.connect.mock.callCount(), 0)
})

test('complete schema reads are not truncated and virtual grep retains coverage warnings', async t => {
  const f = await setup(t)
  const description = 'Detailed metadata. '.repeat(1000)
  await f.index.store(config, [{ ...advertised[0], description }])
  assert.equal(JSON.parse(await f.read()).description, `[MCP:mail] ${description}`)
  assert.doesNotMatch(await f.read(), /\[truncated:/)
})

test('role and remote-workdir restrictions apply equally to virtual grep, glob and contract reads', async t => {
  const f = await setup(t)
  const restricted = new SessionTools(f.base, f.home, ['search', 'read'])
  const ctx = { ...f.context, tools: restricted }
  assert.match(await f.search({}, ctx), /not available/)
  assert.match(await f.read(undefined, ctx), /not available/)
  const hidden = new SessionTools(f.base, f.home, undefined, ['mail__SearchMessages'])
  assert.equal(await f.search({}, { ...f.context, tools: hidden }), 'No matches found')
  assert.match(await f.read(undefined, { ...f.context, tools: hidden }), /Unknown or unavailable/)
  const remote = { ...f.context, remoteWorkdir: {
    nodeId: 'remote', workdirId: 'opaque', get executor(): never { throw new Error('Must not use remote executor') },
  } }
  assert.match(await f.search({}, remote), /only v:sessions searches/)
  assert.equal(f.connect.mock.callCount(), 0)
})

test('cancelled virtual index searches wait for pending reads and never connect or register', async t => {
  const f = await setup(t)
  const indexed = await f.index.read(config)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  t.mock.method(f.index, 'read', async () => { entered.resolve(); await release.promise; return indexed })
  const controller = new AbortController()
  let settled = false
  const pending = f.search({}, { ...f.context, signal: controller.signal }).finally(() => { settled = true })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise
  controller.abort()
  await setImmediate()
  assert.equal(settled, false)
  release.resolve()
  await rejected
  assert.equal(f.connect.mock.callCount(), 0)
})

test('configuration changes and invalid schema references still fail before execution', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => [{ ...advertised[0], inputSchema: { ...schema, $ref: '#/missing' } }])
  assert.match(requireToolText(await f.invoke({ query: 'x' })), /invalid or unsupported input schema/)
  assert.equal(f.call.mock.callCount(), 0)
  f.tools.resetDynamic()
  f.list.mock.mockImplementation(async () => advertised)
  assert.equal(await f.invoke({ query: 'old' }), 'success')
  await f.importer.updateMcpServers([{ ...config, command: 'changed' }])
  assert.match(await f.search({}), /not indexed/)
  assert.equal(await f.invoke({ query: 'new' }), 'success')
  assert.equal(f.call.mock.callCount(), 2)
})


test('flattened factories resolve exact names, deduplicate aliases, and share lazy initialization', async t => {
  let initialized = 0
  let executed = 0
  const first: Tool = { name: 'first', description: 'First operation', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, execute: async () => { executed++; return 'first result' } }
  const second: Tool = { ...first, name: 'second', execute: async () => { executed++; return 'second result' } }
  const f = await setup(t, new Map<string, LoadableEntry>([
    ['bundle', { contracts: [first, second], factory: async () => { initialized++; return [first, second] } }],
    ['first', first],
  ]))
  const entries = await f.importer.virtualEntries(f.context)
  assert.deepEqual(entries.filter(entry => !entry.name.startsWith('mail')).map(entry => entry.name).sort(), ['first', 'second'])
  assert.equal(JSON.parse(await f.read('v:tools/second')).name, 'second')
  assert.equal(initialized, 0)
  const invoke = (args: Record<string, unknown>) => f.tools.execute('invoke_tool', { name: 'second', args }, f.context)
  const results = await Promise.all([invoke({ value: 'a' }), invoke({ value: 'b' })])
  assert.deepEqual(results, ['second result', 'second result'])
  assert.equal(initialized, 1)
  assert.equal(executed, 2)
  assert.equal(f.tools.hasDynamic('first'), true)
  assert.match(requireToolText(await invoke({})), /invalid arguments/)
  assert.equal(executed, 2)
  await f.tools.resetDynamicAndWait()
  assert.equal(await invoke({ value: 'again' }), 'second result')
  assert.equal(initialized, 2)
  assert.equal(f.connect.mock.callCount(), 0)
})

test('unknown MCP and opaque factory sources have explicit initialization separate from tool execution', async t => {
  let initialized = 0
  const tool: Tool = { name: 'opaque_action', description: 'Opaque operation', parameters: { type: 'object', properties: {} }, execute: async () => 'opaque result' }
  const f = await setup(t, new Map<string, LoadableEntry>([['opaque', { factory: async () => { initialized++; return tool } }]]))
  await f.importer.updateMcpServers([{ name: 'unknown', transport: 'stdio', command: 'synthetic-never-run' }])
  const metadata = JSON.parse(await f.read('v:tools/@sources__/unknown'))
  assert.deepEqual(metadata.initialize, { source: 'unknown', args: {} })
  assert.equal(metadata.kind, 'source')
  assert.equal(f.connect.mock.callCount(), 0)
  const invoke = (args: Record<string, unknown>) => f.tools.execute('invoke_tool', args, f.context)
  assert.match(requireToolText(await invoke({ source: 'unknown', name: 'unknown', args: {} })), /omit name/)
  assert.match(requireToolText(await invoke({ source: 'unknown', args: { query: 'x' } })), /requires args/)
  assert.equal(f.connect.mock.callCount(), 0)
  assert.match(requireToolText(await invoke(metadata.initialize)), /no tool executed/)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(JSON.parse(await f.read('v:tools/unknown__SearchMessages')).name, 'unknown__SearchMessages')
  assert.equal(await invoke({ name: 'unknown__SearchMessages', args: { query: 'x' } }), 'success')
  assert.match(requireToolText(await invoke({ source: 'opaque', args: {} })), /no tool executed/)
  assert.equal(initialized, 1)
  assert.equal(JSON.parse(await f.read('v:tools/opaque_action')).name, 'opaque_action')
  assert.equal(await invoke({ name: 'opaque_action', args: {} }), 'opaque result')
  // Legacy preload sources remain accepted; initialization never runs business tools.
  assert.match(await f.importer.importSource({ source: 'v:tools/opaque' }, f.tools), /opaque_action/)
  assert.match(requireToolText(await invoke({ name: 'unknown', args: {} })), /no tool executed/)
  assert.equal(f.call.mock.callCount(), 1)
})

test('a factory with a same-name contract reads as a tool and blocked names stay hidden', async t => {
  const tool: Tool = { name: 'same', description: 'Same-name operation', parameters: { type: 'object', properties: {} }, execute: async () => 'same result' }
  const f = await setup(t, new Map<string, LoadableEntry>([['same', { contracts: [tool], factory: async () => tool }]]))
  assert.equal(JSON.parse(await f.read('v:tools/same')).name, 'same')
  assert.equal(await f.tools.execute('invoke_tool', { name: 'same', args: {} }, f.context), 'same result')
  const restricted = new SessionTools(f.base, f.home, undefined, ['same'])
  assert.equal(await f.search({ query: 'Same-name' }, { ...f.context, tools: restricted }), 'No matches found')
  assert.match(requireToolText(await restricted.execute('invoke_tool', { name: 'same', args: {} }, { ...f.context, tools: restricted })), /could not be imported/)
})


test('concrete reads isolate owners and source metadata cannot shadow a tool or MCP named sources', async t => {
  const tool: Tool = { name: 'sources', description: 'Sources operation', parameters: { type: 'object', properties: {} }, execute: async () => 'result' }
  const f = await setup(t, new Map<string, LoadableEntry>([['sources', tool]]))
  const readIndex = t.mock.method(f.index, 'read', async () => { throw new Error('Unrelated index must not be read') })
  assert.equal(JSON.parse(await f.read('v:tools/sources')).name, 'sources')
  assert.equal(readIndex.mock.callCount(), 0)
  assert.match(await f.read('v:tools/@sources__/mail'), /Unrelated index/)
  readIndex.mock.restore()
  await f.importer.updateMcpServers([{ ...config, name: 'sources' }])
  await f.index.store({ ...config, name: 'sources' }, advertised)
  assert.equal(JSON.parse(await f.read('v:tools/sources/sources__SearchMessages')).name, 'sources__SearchMessages')
  assert.equal(JSON.parse(await f.read('v:tools/sources__SearchMessages')).name, 'sources__SearchMessages')
  assert.equal(f.connect.mock.callCount(), 0)
})


test('root reads list only name/description entries; opaque sources stay in the source directory', async t => {
  let initialized = 0
  const plain: Tool = { name: 'plain', description: 'Plain tool', parameters: { type: 'object', properties: { secretSchemaField: { type: 'string' } } }, execute: async () => 'unused' }
  const f = await setup(t, new Map<string, LoadableEntry>([
    ['plain', plain],
    ['layerfs', { factory: async () => { initialized++; return plain } }],
    ['chrome-devtools', { config: { name: 'chrome-devtools', transport: 'stdio', command: 'never-run' } }],
  ]))
  registerCronTools(f.importer, {} as CronService, {} as Parameters<typeof registerCronTools>[2], () => true, async () => { throw new Error('Discovery cannot execute') })
  const root = await f.read('v:tools')
  const entries = root.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['cron_add', 'cron_list', 'cron_remove', 'mail__SearchMessages', 'plain'])
  assert(entries.every(entry => Object.keys(entry).sort().join(',') === 'description,name'))
  assert.doesNotMatch(root, /"parameters"|"properties"|"kind"|"tools"|secretSchemaField|layerfs|chrome-devtools/)
  assert.match(root, /v:tools\/@sources__/)
  const listMode = requireToolText(await f.tools.execute('read', { path: 'v:tools', flag: 'l' }, f.context))
  assert.doesNotMatch(listMode, /"parameters"|secretSchemaField/)
  assert.doesNotMatch(f.importer.readCatalog('', f.tools), /"parameters"|secretSchemaField|"kind"/)
  assert.deepEqual(JSON.parse(await f.read('v:tools/plain')).parameters, plain.parameters)
  assert.deepEqual(JSON.parse(await f.read('v:tools/mail__SearchMessages')).parameters, schema)
  assert.match(await f.search({ path: 'v:tools/plain', query: 'secretSchemaField' }), /v:tools\/plain/)
  assert.match(await f.search({ query: 'secretSchemaField' }), /v:tools\/plain/)
  assert.match(await f.search({ handler: 'glob', path: 'v:tools/@sources__', query: '*' }), /@sources__\/layerfs/)
  const sources = await f.read('v:tools/@sources__')
  assert.match(sources, /layerfs/)
  assert.match(sources, /chrome-devtools/)
  assert.doesNotMatch(sources, /"parameters"|secretSchemaField/)
  assert.deepEqual(JSON.parse(await f.read('v:tools/@sources__/layerfs')).initialize, { source: 'layerfs', args: {} })
  // Legacy source-scoped metadata remains schema-free; exact children keep contracts.
  assert.doesNotMatch(await f.read('v:tools/cron'), /"parameters"/)
  assert.equal(JSON.parse(await f.read('v:tools/cron/cron_add')).name, 'cron_add')
  assert.equal(initialized, 0)
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
  assert.equal(f.call.mock.callCount(), 0)
  assert.deepEqual(f.tools.activeDynamicTools(), [])
  f.tools.registerDynamic({ ...plain, name: 'imported_sibling' })
  const activeRoot = await f.read('v:tools')
  assert.match(activeRoot, /"name":"imported_sibling"/)
  assert.doesNotMatch(activeRoot, /"parameters"|secretSchemaField/)
  assert.deepEqual(JSON.parse(await f.read('v:tools/imported_sibling')).parameters, plain.parameters)
})


test('LayerFS contracts are flat and offline; exact invocation lazily loads from a LayerFS workspace', async t => {
  const { layerFSToolContracts } = await import('./layerfs.ts')
  const contracts = layerFSToolContracts()
  let initialized = 0
  const f = await setup(t, new Map<string, LoadableEntry>([['layerfs', {
    contracts,
    factory: async () => { initialized++; return contracts.map(contract => ({ ...contract, execute: async () => 'fixture-only' })) },
  }]]))
  assert.match(await f.read('v:tools'), /"name":"layerfs_connect"/)
  assert.match(await f.search({ query: 'layerfs_history' }), /v:tools\/layerfs_history/)
  assert.equal(JSON.parse(await f.read('v:tools/layerfs_connect')).name, 'layerfs_connect')
  assert.equal(initialized, 0)
  assert.equal(f.tools.activeDynamicTools().length, 0)
  assert.equal(f.importer.canInvokeFromLayerFS('layerfs_connect'), true)
  assert.equal(f.importer.canInvokeFromLayerFS('mail__SearchMessages'), false)
  const ctx = { ...f.context, layerfsWorkdir: { workspace: 'layerfs:fixture' } }
  assert.equal(await f.tools.execute('invoke_tool', { name: 'layerfs_connect', args: {} }, ctx), 'fixture-only')
  assert.equal(initialized, 1)
  assert.equal(f.connect.mock.callCount(), 0)
})

test('LayerFS factory routing refuses unmarked or ambiguous advertised tools', async t => {
  const parameters = { ...schema, type: 'object' as const }
  const marked = { name: 'marked', description: 'fixture', parameters, supportsLayerFSWorkdir: true }
  const unmarked = { name: 'unmarked', description: 'fixture', parameters }
  const factory = async () => ({ ...marked, execute: async () => 'unused' })
  const f = await setup(t, new Map<string, LoadableEntry>([
    ['one', { contracts: [marked, unmarked], factory }],
    ['two', { contracts: [marked], factory }],
  ]))
  assert.equal(f.importer.canInvokeFromLayerFS('marked'), false)
  assert.equal(f.importer.canInvokeFromLayerFS('unmarked'), false)
})
