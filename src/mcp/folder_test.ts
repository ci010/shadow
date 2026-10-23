import { FolderRegistry } from '../folders/registry.ts'
import { UseProjectTool } from '../tools/use-project.ts'
import { toolResultText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from '../testing/workspace.ts'
import { discoverFolderMcp } from './folder.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { McpConnection } from './client.ts'

test('folder declarations: search is offline; lazy invocation and A/B isolation', async t => {
  const home = await createTempWorkspace()
  t.after(() => rm(home, { recursive: true, force: true }))
  for (const id of ['a', 'b']) {
    await mkdir(join(home, id))
    await writeFile(join(home, id, '.mcp.json'), JSON.stringify({ mcpServers: { same: { command: 'synthetic', env: { TOKEN: 'private-value' } } } }))
  }
  const cwds: string[] = []
  const connect = t.mock.method(McpConnection.prototype, 'connect', async function(this: McpConnection) { cwds.push((this as unknown as { cwd: string }).cwd) })
  const call = t.mock.method(McpConnection.prototype, 'callTool', async function(this: McpConnection) { return 'called:' + this.config.name })
  const disconnect = t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  t.mock.method(McpConnection.prototype, 'listTools', async () => [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }])
  const importer = new ImportTool(new Map([['same', { config: { name: 'same', transport: 'stdio', command: 'project-synthetic' } }]]), home, undefined, undefined, undefined, undefined, id => ({ id, path: join(home, id) }))
  const invoke = new InvokeTool(importer)
  const base = new Tools(home)
  base.register(new InvokeTool(importer))
  base.register({ name: 'read', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' })
  const tools = new SessionTools(base, home)
  t.after(() => tools.resetDynamicAndWait())
  const context = { tools, signal: new AbortController().signal, folderId: 'a', cwd: join(home, 'a') } as ExecutionContext
  const entries = await importer.virtualEntries(context)
  assert.equal(connect.mock.callCount(), 0)
  assert.match(entries.find(entry => entry.name.startsWith('folder-'))!.content, /not indexed/)
  assert.ok(!JSON.stringify(entries).includes('private-value'))
  const name = entries.find(entry => entry.name.startsWith('folder-'))!.name
  assert.match(toolResultText(await invoke.execute({ name, args: { unexpected: true } }, context)), /requires args/ )
  assert.equal(connect.mock.callCount(), 0)
  const contracts = toolResultText(await invoke.execute({ name, args: {} }, context))
  assert.match(contracts, /no tool executed/)
  assert.ok(contracts.includes(name + '__ping'))
  assert.equal(call.mock.callCount(), 0)
  assert.equal(cwds[0], join(home, 'a'))
  assert.equal(toolResultText(await invoke.execute({ name: name + '__ping', args: {} }, context)), 'called:' + name)
  assert.equal(toolResultText(await invoke.execute({ name: 'same__ping', args: {} }, context)), 'called:same')
  assert.equal(connect.mock.callCount(), 2)
  assert.ok(tools.hasDynamic(`${name}__ping`))
  const child = tools.snapshot()
  const registry = new FolderRegistry(home)
  await registry.init()
  const target = await registry.register(join(home, 'b'))
  const switcher = new UseProjectTool({ projectId: 'fixture', folders: registry, switched: ctx => importer.clearFolderMcpTools(ctx.tools) })
  await switcher.execute({ folder: target.id }, { ...context, projectId: 'fixture', toolCallName: 'use_project', switchProjectFolder: async () => 'committed' })
  assert.ok(!tools.hasDynamic(name + '__ping'), 'switch hook removes names immediately')
  assert.equal(disconnect.mock.callCount(), 0, 'switch preserves borrowed connections')
  const b = await importer.virtualEntries({ ...context, folderId: 'b', cwd: join(home, 'b') })
  assert.ok(!b.some(entry => entry.name === name))
  assert.ok(b.some(entry => entry.name === 'same'))
  assert.ok(child.hasDynamic(`${name}__ping`))
  assert.equal(toolResultText(await invoke.execute({ name: name + '__ping', args: {} }, { ...context, tools: child })), 'called:' + name)
  await importer.importForInvocation(`${name}__ping`, child, context.signal, context.cwd, 'a')
  assert.ok(child.hasDynamic(`${name}__ping`))
  assert.ok(!tools.hasDynamic(`${name}__ping`))
  const current = { ...context, folderId: 'b', cwd: join(home, 'b') }
  assert.match(toolResultText(await invoke.execute({ name: name + '__ping', args: {} }, current)), /Error:/)
  assert.equal(toolResultText(await invoke.execute({ name: 'same__ping', args: {} }, current)), 'called:same')
  const next = b.find(entry => entry.name.startsWith('folder-'))!.name
  await invoke.execute({ name: next, args: {} }, current)
  assert.equal(cwds.at(-1), join(home, 'b'))
  assert.equal(toolResultText(await invoke.execute({ name: next + '__ping', args: {} }, current)), 'called:' + next)
  assert.equal(connect.mock.callCount(), 3)
})

test('bad folder JSON with secrets fails closed without echoing values', async t => {
  const home = await createTempWorkspace()
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, '.mcp.json'), '{"private-value": invalid}')
  await assert.rejects(discoverFolderMcp({ id: 'a', path: home }), error => error instanceof Error && /Invalid folder MCP/.test(error.message) && !error.message.includes('private-value'))
})

test('explicit VS Code convention uses a separate namespace and local cwd', async t => {
  const home = await createTempWorkspace()
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.vscode'))
  await writeFile(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { same: { command: './fixture' } } }))
  await writeFile(join(home, '.vscode', 'mcp.json'), JSON.stringify({ servers: { same: { type: 'http', url: 'https://example.test/mcp' } } }))
  const sources = await discoverFolderMcp({ id: 'a', path: home })
  assert.equal(sources.length, 2)
  assert.notEqual(sources[0].config.name, sources[1].config.name)
  assert.equal(sources[0].cwd, home)
  assert.equal(sources[1].config.transport, 'streamable-http')
})

test('empty server maps are valid while invalid map structures fail closed', async t => {
  const home = await createTempWorkspace()
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.vscode'))
  for (const [file, key] of [['.mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'servers']]) {
    await writeFile(join(home, file), JSON.stringify({ [key]: {} }))
  }
  assert.deepEqual(await discoverFolderMcp({ id: 'a', path: home }), [])
  for (const value of [[], null, 'invalid', 3]) {
    await writeFile(join(home, '.vscode/mcp.json'), JSON.stringify({ servers: value }))
    await assert.rejects(discoverFolderMcp({ id: 'a', path: home }), /Invalid folder MCP/)
  }
})
