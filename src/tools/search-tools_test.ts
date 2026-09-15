import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import { McpConnection, type McpToolInfo } from '../mcp/client.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { SearchTool } from './search.ts'
import type { Tool } from './tool.ts'

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 1, maximum: 10 },
  },
  required: ['query'], additionalProperties: false,
}
const messageTool: McpToolInfo = { name: 'SearchMessages', description: 'Search messages by subject and sender.', inputSchema: schema }

async function setup(t: TestContext, builtins = new Map<string, LoadableEntry>()) {
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp', 'tool-search-'))
  const importer = new ImportTool(builtins, home)
  const base = new Tools(home)
  base.register(importer)
  base.register(new InvokeTool(importer))
  base.register(new SearchTool(home, undefined, undefined, importer))
  const tools = new SessionTools(base, home)
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', () => {})
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => [
    messageTool,
    ...Array.from({ length: 12 }, (_, i) => ({ name: `Unrelated${i}`, description: 'Other operation.', inputSchema: { type: 'object' } })),
  ])
  const call = t.mock.method(McpConnection.prototype, 'callTool', async () => 'success')
  await importer.updateMcpServers([{ name: 'mail', transport: 'stdio', command: 'synthetic-never-run' }])
  t.after(async () => {
    tools.resetDynamic()
    await rm(home, { recursive: true, force: true })
  })
  const search = (args: Record<string, unknown>) => tools.execute('search', { space: 'tools:', ...args }, context)
  const invoke = (args: Record<string, unknown>, name = 'mail__SearchMessages') =>
    tools.execute('invoke_tool', { name, args }, context)
  return { home, importer, base, tools, context, connect, list, call, search, invoke }
}

test('search returns only matching exact contracts and performs no tool RPC; invoke needs no import step', async t => {
  const f = await setup(t)
  const result = JSON.parse(await f.search({ query: 'search subject', limit: 1 }))
  assert.deepEqual(result.tools.map((tool: { name: string }) => tool.name), ['mail__SearchMessages'])
  assert.deepEqual(result.tools[0].parameters, schema)
  assert.match(result.tools[0].description, /Search messages by subject/)
  assert.equal(result.tools[0].source, 'v:tools/mail')
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(await f.invoke({ query: 'hello' }), 'success')
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 1)
  assert(!f.tools.getDefinitions().some(tool => tool.function.name === 'mail__SearchMessages'))
})

test('known IDs execute lazily on first use, but invalid arguments never reach MCP', async t => {
  const f = await setup(t)
  for (const args of [{}, { query: 5 }, { query: '' }, { query: 'test', count: 11 }, { query: 'test', unknown: 1 }]) {
    const invalid = await f.invoke(args)
    assert.match(invalid, /invalid arguments/)
    assert.match(invalid, /no tool was executed/)
    assert.match(invalid, /"parameters"/)
  }
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(await f.invoke({ query: 'test', count: 2 }), 'success')
  assert.equal(f.call.mock.callCount(), 1)
  assert.equal(f.connect.mock.callCount(), 1)
})

test('limits bound returned tools, never truncate an individual contract, and exact IDs rank first', async t => {
  const f = await setup(t)
  const description = 'Search messages with the exact subject. '.repeat(500)
  f.list.mock.mockImplementation(async () => [
    { ...messageTool, description },
    { ...messageTool, name: 'FindMessages' },
  ])
  const text = await f.search({ query: 'mail__SearchMessages', limit: 1 })
  const result = JSON.parse(text)
  assert.equal(result.tools.length, 1)
  assert.equal(result.tools[0].description, `[MCP:mail] ${description}`)
  assert(!text.includes('[truncated:'))
  const broad = JSON.parse(await f.search({ query: 'messages', limit: 1 }))
  assert.equal(broad.totalMatches, 2)
  assert.equal(broad.hasMore, true)
})

test('search reports failed sources and defers browser/factory initialization unless explicitly selected', async t => {
  let factories = 0
  const tool: Tool = { name: 'fixture', description: 'Fixture browser tool', parameters: { type: 'object', properties: {} }, execute: async () => 'not called' }
  const f = await setup(t, new Map([['browser', { factory: async () => { factories++; return tool } }]]))
  await f.importer.updateMcpServers([
    { name: 'mail', transport: 'stdio', command: 'synthetic' },
    { name: 'unavailable', transport: 'stdio', command: 'synthetic' },
  ])
  f.connect.mock.mockImplementation(async function (this: McpConnection) {
    if (this.config.name === 'unavailable') throw Object.assign(new Error('authentication required'), { code: 401 })
  })
  const partial = JSON.parse(await f.search({ query: 'messages' }))
  assert.equal(partial.tools.length, 1)
  assert.equal(partial.errors.length, 1)
  assert.match(partial.errors[0].message, /"httpStatus":401/)
  assert.deepEqual(partial.deferredSources, ['v:tools/browser'])
  assert.equal(factories, 0)
  const explicit = JSON.parse(await f.search({ query: 'browser', space: 'tools:browser' }))
  assert.equal(explicit.tools[0].name, 'fixture')
  assert.equal(factories, 1)
  assert.equal(f.call.mock.callCount(), 0)
})

test('sleep and config changes do not require disclosure flags; current schema still governs invocation', async t => {
  const f = await setup(t)
  await f.search({ query: 'messages' })
  f.tools.resetDynamic()
  assert.equal(await f.invoke({ query: 'after sleep' }), 'success')
  assert.equal(f.connect.mock.callCount(), 2)
  await f.importer.updateMcpServers([{ name: 'mail', transport: 'stdio', command: 'synthetic-changed' }])
  f.list.mock.mockImplementation(async () => [{
    ...messageTool,
    inputSchema: { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'], additionalProperties: false },
  }])
  assert.match(await f.invoke({ query: 'obsolete arguments' }), /invalid arguments/)
  assert.equal(f.call.mock.callCount(), 1)
  assert.equal(await f.invoke({ folder: 'inbox' }), 'success')
  assert.equal(f.call.mock.callCount(), 2)
})

test('invalid schemas fail closed and schema IDs cannot alias across tool versions', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => [{
    ...messageTool, inputSchema: { ...schema, $ref: '#/missing' },
  }])
  assert.match(await f.invoke({ query: 'test' }), /invalid or unsupported input schema/)
  assert.equal(f.call.mock.callCount(), 0)
  f.tools.resetDynamic()
  f.list.mock.mockImplementation(async () => [{ ...messageTool, inputSchema: { ...schema, $id: 'fixture-contract' } }])
  assert.equal(await f.invoke({ query: 'old version' }), 'success')
  await f.importer.updateMcpServers([{ name: 'mail', transport: 'stdio', command: 'new-version' }])
  f.list.mock.mockImplementation(async () => [{
    ...messageTool, inputSchema: {
      $id: 'fixture-contract', type: 'object',
      properties: { folder: { type: 'string' } }, required: ['folder'], additionalProperties: false,
    },
  }])
  assert.match(await f.invoke({ query: 'old version' }), /invalid arguments/)
  assert.equal(f.call.mock.callCount(), 1)
  assert.equal(await f.invoke({ folder: 'new version' }), 'success')
})

test('role restrictions and search input validation do not reveal or execute prohibited tools', async t => {
  const f = await setup(t)
  for (const args of [
    { query: null }, { query: 1 }, { query: 'x'.repeat(501) }, { query: 'mail', limit: 0 },
    { query: 'mail', space: 'tools:absent' }, { limit: null }, { offset: null },
    { offset: -1 }, { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.match(await f.search(args), /^Error:/)
  }
  assert.equal(f.connect.mock.callCount(), 0)
  const restricted = new SessionTools(f.base, f.home, ['search'])
  t.after(() => restricted.resetDynamic())
  assert.match(await restricted.execute('search', { space: 'tools:', query: 'mail' }, { ...f.context, tools: restricted }), /not available/)
  assert.equal(f.connect.mock.callCount(), 0)
  const hidden = new SessionTools(f.base, f.home, undefined, ['mail__SearchMessages'])
  t.after(() => hidden.resetDynamic())
  const result = JSON.parse(await hidden.execute('search', { space: 'tools:', query: 'subject' }, { ...f.context, tools: hidden }))
  assert.equal(result.tools.length, 0)
  assert.equal(f.call.mock.callCount(), 0)
})

test('cancelled parallel discovery waits for all cleanup before releasing the import queue', async t => {
  const f = await setup(t)
  await f.importer.updateMcpServers([
    { name: 'mail', transport: 'stdio', command: 'synthetic' },
    { name: 'second', transport: 'stdio', command: 'synthetic' },
  ])
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let starts = 0
  f.connect.mock.mockImplementation(async (signal?: AbortSignal) => {
    if (++starts === 2) entered.resolve()
    await new Promise<void>((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  })
  t.mock.method(McpConnection.prototype, 'disconnect', async function (this: McpConnection) {
    if (this.config.name === 'second') await release.promise
  })
  const controller = new AbortController()
  let settled = false
  const pending = f.tools.execute('search', { space: 'tools:', query: 'messages' }, { ...f.context, signal: controller.signal })
    .finally(() => { settled = true })
  await entered.promise
  controller.abort()
  await setImmediate()
  assert.equal(settled, false)
  release.resolve()
  assert.match(await pending, /aborted/)
  assert.equal(f.tools.activeDynamicTools().length, 0)
})

test('empty, whitespace and omitted tool queries list complete contracts with deterministic pagination', async t => {
  const f = await setup(t)
  const first = JSON.parse(await f.search({ query: '', space: 'tools:mail', limit: 5 }))
  assert.equal(first.tools.length, 5)
  assert.equal(first.totalMatches, 13)
  assert.equal(first.nextOffset, 5)
  assert.equal(first.hasMore, true)
  assert.deepEqual(first, JSON.parse(await f.search({ query: ' \n\t ', space: 'tools:mail', limit: 5 })))
  assert.deepEqual(first, JSON.parse(await f.search({ space: 'tools:mail', limit: 5 })))
  const second = JSON.parse(await f.search({ space: 'tools:mail', limit: 5, offset: first.nextOffset }))
  const last = JSON.parse(await f.search({ space: 'tools:mail', limit: 5, offset: second.nextOffset }))
  const names = [...first.tools, ...second.tools, ...last.tools].map((tool: { name: string }) => tool.name)
  assert.equal(new Set(names).size, 13)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')))
  assert.equal(last.tools.length, 3)
  assert.equal(last.nextOffset, null)
  assert.equal(last.hasMore, false)
  const beyond = JSON.parse(await f.search({ offset: 100 }))
  assert.deepEqual(beyond.tools, [])
  assert.equal(beyond.hasMore, false)
  assert.equal(beyond.nextOffset, null)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 0)
  assert(!f.tools.getDefinitions().some(tool => tool.function.name === 'search_tools'))
})

test('empty discovery preserves role and remote workdir restrictions', async t => {
  const f = await setup(t)
  const restricted = new SessionTools(f.base, f.home, undefined, ['invoke_tool'])
  t.after(() => restricted.resetDynamic())
  assert.match(await restricted.execute('search', { space: 'tools:' }, { ...f.context, tools: restricted }), /not available/)
  assert.equal(f.connect.mock.callCount(), 0)
  const remote = {
    nodeId: 'remote', capabilityId: 'workdir',
    executor: {
      execute: () => { throw new Error('Remote execution must not start') },
      getStatus: async () => { throw new Error('Remote execution must not start') },
      cancel: async () => { throw new Error('Remote execution must not start') },
    },
  }
  assert.match(await f.tools.execute('search', { space: 'tools:' }, {
    ...f.context, remoteWorkdir: remote,
  }), /does not support remote workdirs/)
  assert.equal(f.connect.mock.callCount(), 0)
})
