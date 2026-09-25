import { requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { ConfigSchema } from '../config/schema.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { SearchTool } from '../tools/search.ts'
import { McpConnection } from './client.ts'
import { createMcpConfigHandler } from './virtual-config.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'

const contracts = ['find', 'list', 'describe'].map(name => ({
  name, description: 'Inventory item operation',
  inputSchema: { type: 'object', properties: {} },
}))

function session(home: string, importer: ImportTool) {
  const base = new Tools(home)
  const vfs = new VirtualFs()
  vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, opts) => importer.virtualEntries(ctx, opts))
  base.register(new SearchTool(home, undefined, vfs))
  base.register(new ReadTool(home, vfs))
  base.register(new InvokeTool(importer))
  const tools = new SessionTools(base, home)
  const context: ExecutionContext = {
    tools, signal: new AbortController().signal, projectId: 'fixture',
    channel: 'test', chatId: 'test', senderId: 'test', messageId: 'test',
    sessionId: 'test', physicalSessionId: 'test-0',
  }
  return { tools, context }
}

async function fixture(t: TestContext) {
  const home = await createTempWorkspace()
  const importer = new ImportTool(new Map(), home)
  const { tools, context } = session(home, importer)
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => contracts)
  const disconnect = t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  const call = t.mock.method(McpConnection.prototype, 'callTool', async () => { throw new Error('Indexing/search must never execute tools') })
  const configPath = join(home, 'project.json')
  const store = new ProjectConfigStore({
    home, configPath, getSharedConfig: () => ConfigSchema.parse({}),
    onChanged: config => importer.updateMcpServers(config.mcp.servers),
  })
  await store.init()
  const handlers = createMcpConfigHandler({
    projectId: 'fixture', configStore: store, isReservedName: name => importer.isBuiltinName(name),
  })
  t.after(async () => {
    tools.resetDynamic()
    await rm(home, { recursive: true, force: true })
  })
  const save = async (mcpServers: Record<string, unknown>) => {
    const document = JSON.parse(await handlers.read('mcp.json', context))
    return handlers.write('mcp.json', { content: JSON.stringify({ ...document, mcpServers }) }, context)
  }
  return { home, configPath, importer, tools, context, store, connect, list, disconnect, call, save }
}

test('100 installed MCPs remain searchable after restart with zero search connections or RPCs', async t => {
  const f = await fixture(t)
  let live = 0
  let maxLive = 0
  f.connect.mock.mockImplementation(async () => { maxLive = Math.max(maxLive, ++live) })
  f.list.mock.mockImplementation(async () => { await setImmediate(); return contracts })
  f.disconnect.mock.mockImplementation(async () => { live-- })
  const servers = Object.fromEntries(Array.from({ length: 100 }, (_, i) =>
    [`inventory-${String(i).padStart(3, '0')}`, { command: 'synthetic-never-run' }]))
  assert.match(String(await f.save(servers)), /tool indexes ready/)
  assert.equal(f.connect.mock.callCount(), 100)
  assert.equal(f.list.mock.callCount(), 100)
  assert.equal(f.disconnect.mock.callCount(), 100)
  assert.equal(live, 0)
  assert.ok(maxLive <= 3, 'Indexing must bound simultaneous discovery connections')
  await f.save(servers)
  assert.equal(f.connect.mock.callCount(), 100, 'Unchanged indexes must be reused')

  const restored = new ProjectConfigStore({
    home: f.home, configPath: f.configPath, getSharedConfig: () => ConfigSchema.parse({}),
  })
  const config = await restored.init()
  const importer = new ImportTool(new Map(), f.home)
  await importer.updateMcpServers(config.mcp.servers)
  const fresh = session(f.home, importer)
  t.after(() => fresh.tools.resetDynamic())
  for (const space of ['glob:v:tools', 'glob:v:tools/inventory-042']) {
    const result = requireToolText(await fresh.tools.execute('search', { space, query: '*__*', limit: 3 }, fresh.context))
    const paths = result.split('\n').filter(line => line.startsWith('v:'))
    assert.equal(paths.length, 3)
    if (space === 'glob:v:tools') assert.match(result, /of 300 results/)
    assert.doesNotMatch(result, /Warning:/)
    for (const path of paths) {
      const tool = JSON.parse(requireToolText(await fresh.tools.execute('read', { path }, fresh.context)))
      assert.equal(typeof tool.indexedAt, 'string')
    }
  }
  assert.equal(f.connect.mock.callCount(), 100)
  assert.equal(f.list.mock.callCount(), 100)
  assert.equal(f.disconnect.mock.callCount(), 100)
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(fresh.tools.activeDynamicTools().length, 0)
})

test('failed batch indexing leaves configuration and catalog unchanged and does not publish staged sources', async t => {
  const f = await fixture(t)
  const original = { existing: { command: 'synthetic-existing' } }
  await f.save(original)
  const before = await readFile(f.configPath, 'utf8')
  f.list.mock.mockImplementation(async function (this: McpConnection) {
    if (this.config.name === 'broken') throw new Error('Index failure: synthetic-new-secret')
    return contracts
  })
  await assert.rejects(f.save({
    ...original,
    staged: { command: 'synthetic-staged' },
    broken: { command: 'synthetic-broken', env: { TOKEN: 'synthetic-new-secret' } },
  }), error => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /synthetic-new-secret/)
    assert.match(error.message, /list_tools/)
    return true
  })
  assert.equal(await readFile(f.configPath, 'utf8'), before)
  assert.deepEqual(f.store.current().mcp.servers.map(server => server.name), ['existing'])
  const result = requireToolText(await f.tools.execute('search', { space: 'glob:v:tools/existing', query: '*__*' }, f.context))
  assert.equal(result.split('\n').length, 3)
  assert.doesNotMatch(result, /Warning:/)
  assert.equal(f.tools.activeDynamicTools().length, 0)
  assert.equal(f.call.mock.callCount(), 0)
  f.connect.mock.mockImplementation(async () => { throw new Error('Removing a server must not connect') })
  await f.save({})
  assert.deepEqual(f.store.current().mcp.servers, [])
  assert.equal(f.importer.catalogEntries(f.tools).length, 0)
})

test('legacy config loads without connecting and a no-op save builds its missing index', async t => {
  const f = await fixture(t)
  const config = ConfigSchema.parse({ mcp: { legacy: { command: 'synthetic-legacy' } } })
  const legacyPath = join(f.home, 'legacy.json')
  const legacy = new ProjectConfigStore({
    home: f.home, configPath: legacyPath, getSharedConfig: () => ConfigSchema.parse({}),
    onChanged: changed => f.importer.updateMcpServers(changed.mcp.servers),
  })
  await legacy.init(config)
  await f.importer.updateMcpServers(legacy.current().mcp.servers)
  const missing = requireToolText(await f.tools.execute('search', { space: 'glob:v:tools', query: '*__*' }, f.context))
  assert.match(missing, /No files found/)
  assert.match(missing, /Warning:.*not indexed/)
  assert.equal(f.connect.mock.callCount(), 0)
  await legacy.update(raw => raw)
  const indexed = requireToolText(await f.tools.execute('search', { space: 'glob:v:tools', query: '*__*' }, f.context))
  assert.equal(indexed.split('\n').length, 3)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.disconnect.mock.callCount(), 1)
})

test('failed replacement preserves the previous index and its live session connection', async t => {
  const f = await fixture(t)
  await f.save({ existing: { command: 'synthetic-old' } })
  await f.importer.importForInvocation('existing__find', f.tools)
  const previousConnection = f.tools.getMcpConn('existing')?.conn
  assert.ok(previousConnection)
  const before = await readFile(f.configPath, 'utf8')
  f.list.mock.mockImplementation(async function (this: McpConnection) {
    if (this.config.command === 'synthetic-new') throw new Error('New server cannot list tools')
    return contracts
  })
  await assert.rejects(f.save({ existing: { command: 'synthetic-new' } }), /list_tools/)
  assert.equal(await readFile(f.configPath, 'utf8'), before)
  assert.equal(f.tools.getMcpConn('existing')?.conn, previousConnection)
  assert.equal(f.tools.hasDynamic('existing__find'), true)
  const connections = f.connect.mock.callCount()
  const result = requireToolText(await f.tools.execute('search', { space: 'glob:v:tools/existing', query: '*__*' }, f.context))
  assert.equal(result.split('\n').length, 3)
  assert.doesNotMatch(result, /Warning:/)
  assert.equal(f.connect.mock.callCount(), connections)
})
