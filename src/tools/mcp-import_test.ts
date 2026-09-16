import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type { McpServerConfig } from '../config/schema.ts'
import { McpConnection, type McpToolInfo } from '../mcp/client.ts'
import { McpManager } from '../mcp/manager.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'

const server: McpServerConfig = {
  name: 'fixture', transport: 'stdio', command: 'synthetic-never-run',
  description: 'Synthetic task capabilities',
}
const echo: McpToolInfo = {
  name: 'echo', description: 'Return a string',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
}

async function setup(t: TestContext) {
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp', 'mcp-import-'))
  const base = new Tools(home)
  const catalog = new Map<string, LoadableEntry>()
  const importer = new ImportTool(catalog, home)
  base.register(importer)
  base.register(new InvokeTool(importer))
  const session = new SessionTools(base, home)
  const context = { tools: session, signal: new AbortController().signal } as ExecutionContext
  const manager = new McpManager(servers => importer.updateMcpServers(servers), [server])
  const handlers = new Map<McpConnection, () => void>()
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  const disconnect = t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => [echo])
  const call = t.mock.method(McpConnection.prototype, 'callTool', async (_name: string, args: Record<string, unknown>) => String(args.value))
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', function (this: McpConnection, handler: () => void) {
    handlers.set(this, handler)
  })
  t.after(async () => {
    session.resetDynamic()
    await manager.stopWatching()
    await rm(home, { recursive: true, force: true })
  })
  await manager.ensureLoaded()
  const invoke = (name = 'fixture__echo', value = 'answer') =>
    session.execute('invoke_tool', { name, args: { value } }, context)
  const importServer = () => session.execute('import_tool', { source: 'v:tools/fixture' }, context)
  return { home, base, catalog, importer, session, context, manager, handlers, connect, disconnect, list, call, invoke, importServer }
}

test('catalog discovery and config reload never connect or expose raw MCP function definitions', async t => {
  const f = await setup(t)
  await f.manager.load([{ ...server, env: { PRIVATE_VALUE: 'synthetic-hidden-value' } }])
  assert.equal(f.connect.mock.callCount(), 0)
  assert.deepEqual(f.session.names(), ['import_tool', 'invoke_tool'])
  assert.match(f.importer.readCatalog('', f.session), /Synthetic task capabilities/)
  assert.doesNotMatch(f.importer.readCatalog('', f.session), /synthetic-hidden-value|synthetic-never-run/)
  assert.equal(await f.invoke(), 'answer')
  assert.equal(f.call.mock.callCount(), 1)
  assert.equal(await f.invoke(), 'answer')
  assert.equal(f.call.mock.callCount(), 2)
  assert.equal(f.session.getDefinitions().some(def => def.function.name === 'fixture__echo'), false)
  assert.match(await f.session.execute('fixture__echo', { value: 'direct' }, f.context), /unknown tool/)
})

test('legacy explicit imports return complete contracts and valid invocations execute immediately', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => [{ ...echo, description: 'schema description '.repeat(1000) }])
  const contract = await f.importServer()
  assert.match(contract, /"parameters"/)
  assert.doesNotMatch(contract, /\.\.\.\[truncated/)
  assert.equal(await f.invoke(), 'answer')
  assert.equal(f.call.mock.callCount(), 1)
})

test('preloading and concurrent lazy invocations reuse a connection and execute each requested operation once', async t => {
  const f = await setup(t)
  const results = await Promise.all([f.invoke(), f.invoke()])
  assert.deepEqual(results, ['answer', 'answer'])
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 2)
  assert.equal(await f.invoke(), 'answer')
  f.session.resetDynamic()
  await f.importer.importSource({ source: 'v:tools/fixture' }, f.session)
  assert.equal(await f.invoke(), 'answer')
})

test('changed and removed catalog entries invalidate sessions and borrowed snapshots, while unchanged entries reuse connections', async t => {
  const f = await setup(t)
  await f.importServer()
  const borrowed = f.session.snapshot()
  t.after(() => borrowed.resetDynamic())
  assert.equal(borrowed.hasDynamic('fixture__echo'), true)
  await f.manager.load([{ ...server }])
  assert.equal(f.disconnect.mock.callCount(), 0)
  await f.manager.load([{ ...server, args: ['changed'] }])
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.equal(f.session.hasDynamic('fixture__echo'), false)
  assert.equal(borrowed.hasDynamic('fixture__echo'), false)
  assert.equal(await f.invoke(), 'answer')
  assert.equal(f.connect.mock.callCount(), 2)
  assert.equal(await f.invoke(), 'answer')
  await f.manager.load([])
  assert.match(await f.invoke(), /could not be imported/)
  assert.equal(f.call.mock.callCount(), 2)
  assert.equal(f.importer.catalogEntries(f.session).length, 0)
})

test('server tool-list notifications invalidate adapters and remove missing tools on lazy discovery', async t => {
  const f = await setup(t)
  await f.importServer()
  const conn = f.session.getMcpConn('fixture')!.conn
  f.list.mock.mockImplementation(async () => [{ ...echo, name: 'replacement' }])
  f.handlers.get(conn)!()
  assert.equal(f.session.hasDynamic('fixture__echo'), false)
  assert.match(await f.invoke(), /not advertised/)
  assert.equal(await f.invoke('fixture__replacement'), 'answer')
  assert.equal(await f.invoke('fixture__replacement'), 'answer')
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 2)
})

test('JSON imports all entries, supports named selection and extra arguments, and reuses unchanged connections', async t => {
  const f = await setup(t)
  const path = join(f.home, 'servers.json')
  await writeFile(path, JSON.stringify({ mcpServers: {
    one: { command: 'synthetic', args: ['base'] },
    two: { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
  } }))
  const all = await f.importer.execute({ source: path }, f.context)
  assert.match(all, /one__echo/)
  assert.match(all, /two__echo/)
  assert.equal(f.session.getMcpConn('two')!.conn.config.transport, 'streamable-http')
  await f.importer.execute({ source: path }, f.context)
  assert.equal(f.connect.mock.callCount(), 2)
  await f.importer.execute({ source: path, server: 'one', args: ['extra'] }, f.context)
  assert.deepEqual(f.session.getMcpConn('one')!.conn.config.args, ['base', 'extra'])
  assert.equal(f.connect.mock.callCount(), 3)
  assert.match(await f.importer.execute({ source: path, server: 'absent' }, f.context), /does not exist/)
  const before = f.connect.mock.callCount()
  await writeFile(path, JSON.stringify({ mcpServers: {
    valid: { command: 'synthetic' }, invalid: { type: 'streamable-http', url: 'not-a-url' },
  } }))
  assert.match(await f.importer.execute({ source: path }, f.context), /invalid MCP config/)
  assert.equal(f.connect.mock.callCount(), before, 'Validate the selected set before starting any servers')
})

test('reset cancels an in-flight import and cannot repopulate sleeping session tools', async t => {
  const f = await setup(t)
  const started = Promise.withResolvers<void>()
  f.connect.mock.mockImplementation(async signal => {
    assert.ok(signal)
    started.resolve()
    await new Promise<void>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const importing = f.importer.importSource({ source: 'v:tools/fixture' }, f.session)
  const rejected = assert.rejects(importing, { name: 'AbortError' })
  await started.promise
  f.session.resetDynamic()
  await rejected
  assert.equal(f.session.hasDynamic('fixture__echo'), false)
  assert.equal(f.session.getMcpConn('fixture'), undefined)
  assert.equal(f.disconnect.mock.callCount(), 1)
})

test('catalog changes during connection startup reject the obsolete import and release it', async t => {
  const f = await setup(t)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.connect.mock.mockImplementation(async () => { started.resolve(); await release.promise })
  const importing = f.importer.importSource({ source: 'v:tools/fixture' }, f.session)
  await started.promise
  await f.manager.load([])
  release.resolve()
  assert.match(await importing, /configuration changed during import/)
  assert.equal(f.session.hasDynamic('fixture__echo'), false)
  assert.equal(f.session.getMcpConn('fixture'), undefined)
  assert.equal(f.disconnect.mock.callCount(), 1)
})

test('failed discovery is disclosed without hidden retries; an executing tool is never automatically retried', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => { throw new Error('synthetic list failure') })
  assert.match(await f.importServer(), /synthetic list failure/)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.equal(f.session.getMcpConn('fixture'), undefined)
  f.list.mock.mockImplementation(async () => [echo])
  await f.importServer()
  f.call.mock.mockImplementation(async () => { throw new Error('synthetic execution failure') })
  assert.match(await f.invoke(), /synthetic execution failure/)
  assert.equal(f.call.mock.callCount(), 1)
})

test('implicit import preserves stage, HTTP code and user-action diagnostics rather than a generic inactive-tool error', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => { throw Object.assign(new Error('access expired'), { code: 401 }) })
  const result = await f.invoke()
  assert.match(result, /"phase":"list_tools"/)
  assert.match(result, /"httpStatus":401/)
  assert.match(result, /"needsUserAction":true/)
  assert.match(result, /access expired/)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 0)
})

test('import cleanup failure preserves the primary discovery failure', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => { throw Object.assign(new Error('discovery timeout'), { code: -32001 }) })
  f.disconnect.mock.mockImplementation(async () => { throw new Error('cleanup failed') })
  const result = await f.importServer()
  assert.match(result, /discovery timeout/)
  assert.match(result, /"rpcCode":-32001/)
  assert.match(result, /"cleanupFailure"/)
  assert.match(result, /cleanup failed/)
  assert.equal(f.session.getMcpConn('fixture'), undefined)
})

test('JSON imports distinguish filesystem and syntax failures without echoing credential excerpts', async t => {
  const f = await setup(t)
  const missing = await f.importer.importSource({ source: join(f.home, 'absent.json') }, f.session)
  assert.match(missing, /"phase":"read_config"/)
  assert.match(missing, /"systemCode":"ENOENT"/)
  const path = join(f.home, 'invalid.json')
  await writeFile(path, '{"token":"synthetic-private-value", invalid}')
  const invalid = await f.importer.importSource({ source: path }, f.session)
  assert.match(invalid, /"phase":"validate_config"/)
  assert.match(invalid, /Invalid JSON/)
  assert.doesNotMatch(invalid, /synthetic-private-value/)
})

test('restricted agents cannot discover or invoke forbidden MCP tools', async t => {
  const f = await setup(t)
  const restricted = new SessionTools(f.base, f.home, ['read'])
  const blocked = new SessionTools(f.base, f.home, undefined, ['fixture__echo'])
  t.after(() => { restricted.resetDynamic(); blocked.resetDynamic() })
  assert.deepEqual(f.importer.catalogEntries(restricted), [])
  assert.match(await restricted.execute('import_tool', { source: 'v:tools/fixture' },
    { ...f.context, tools: restricted }), /not available/)
  assert.match(await blocked.execute('invoke_tool', { name: 'fixture__echo', args: {} },
    { ...f.context, tools: blocked }), /could not be imported/)
  assert.equal(f.connect.mock.callCount(), 0)
})
