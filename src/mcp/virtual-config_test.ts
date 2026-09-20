import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ReadTool, WriteTool } from '../tools/filesystem.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createMcpConfigHandler } from './virtual-config.ts'
import { McpConnection } from './client.ts'

const path = 'v:config/mcp.json'
const initialMcp = {
  local: {
    command: 'synthetic-nonexistent-command',
    args: ['first', 'first'],
    env: { TOKEN: 'synthetic-env-secret', EMPTY: '' },
  },
  remote: {
    type: 'streamable-http',
    url: 'https://synthetic.invalid/mcp?key=synthetic-url-secret',
    headers: { Authorization: 'Bearer synthetic-header-secret', 'X-Custom': 'synthetic-custom-header' },
  },
}

async function fixture(t: TestContext, mcp: Record<string, unknown> = initialMcp) {
  t.mock.method(McpConnection.prototype, 'connect', async () => {})
  t.mock.method(McpConnection.prototype, 'listTools', async () => [])
  t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  const root = await createTempWorkspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'project.json')
  const shared = ConfigSchema.parse({ providers: { openai: { apiKey: 'synthetic-shared-secret' } } })
  await writeFile(configPath, JSON.stringify({ mcp, agent: { workspace: root }, learning: { enabled: false } }) + '\n')
  let activations = 0
  let activationError: Error | undefined
  const store = new ProjectConfigStore({
    configPath, home: root, getSharedConfig: () => shared,
    onChanged: () => {
      activations++
      if (activationError) throw activationError
    },
  })
  await store.init()
  const vfs = new VirtualFs()
  const handlers = createMcpConfigHandler({
    projectId: 'project-a', configStore: store, isReservedName: name => name === 'builtin',
  })
  vfs.mount('v:config', 'Project MCP configuration', handlers.read, undefined, handlers.write)
  const context: ExecutionContext = {
    projectId: 'project-a', channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn',
    sessionId: 'session', physicalSessionId: 'session-0',
    signal: new AbortController().signal, tools: new SessionTools(new Tools(root), root),
  }
  const reader = new ReadTool(root, vfs)
  const writer = new WriteTool(root, undefined, false, vfs)
  const read = () => reader.execute({ path }, context)
  const overwrite = (document: unknown, ctx = context) =>
    writer.execute({ path, content: JSON.stringify(document) }, ctx)
  const saved = async () => JSON.parse(await readFile(configPath, 'utf8'))
  return {
    root, store, vfs, context, reader, writer, handlers, read, overwrite, saved, configPath,
    activations: () => activations,
    failActivation: (error: Error) => { activationError = error },
  }
}

test('virtual read and indexed overwrite roundtrip secrets and preserve Project settings', async t => {
  const f = await fixture(t)
  const before = await f.read()
  for (const secret of ['synthetic-env-secret', 'synthetic-url-secret', 'synthetic-header-secret', 'synthetic-custom-header', 'synthetic-shared-secret']) {
    assert.ok(!before.includes(secret))
  }
  assert.equal(before, await f.read(), 'Redacted placeholders and revision are stable')
  const document = JSON.parse(before)
  document.mcpServers.local.command = 'different-synthetic-command'
  const result = await f.overwrite(document)
  assert.match(result, /config saved; catalog updated/)
  assert.match(result, /tool indexes ready/)
  assert.match(result, /No MCP tools were executed/)
  assert.ok(!result.includes('synthetic-'), 'Write receipt contains no content preview')
  const saved = await f.saved()
  assert.equal(saved.mcp.local.env.TOKEN, initialMcp.local.env.TOKEN)
  assert.equal(saved.mcp.remote.url, initialMcp.remote.url)
  assert.deepEqual(saved.mcp.remote.headers, initialMcp.remote.headers)
  assert.equal(saved.mcp.local.command, 'different-synthetic-command')
  assert.equal(saved.learning.enabled, false)
  assert.equal(saved.agent.workspace, f.root)
  assert.equal(saved.providers, undefined)
  assert.equal(f.store.current().providers.openai.apiKey, 'synthetic-shared-secret')
  assert.equal(f.activations(), 1, 'Only the normal configuration activation callback ran')
})

test('exact contextual and global edits use a session read and reject fuzzy or ambiguous matches', async t => {
  const f = await fixture(t)
  await assert.rejects(f.writer.execute({ path, match: 'first', content: 'second' }, f.context), /Read v:config/)
  await f.read()
  await assert.rejects(f.writer.execute({ path, match: 'first', content: 'second' }, f.context), /ambiguous/)
  await assert.rejects(f.writer.execute({ path, match: '\t"command": "synthetic-nonexistent-command"', content: '' }, f.context), /Exact match string not found/)
  await f.writer.execute({
    path, match: '"command": "synthetic-nonexistent-command"', content: '"command": "edited-command"',
  }, f.context)
  assert.equal((await f.saved()).mcp.local.command, 'edited-command')
  await f.read()
  await f.writer.execute({ path, match: '"first"', content: '"$&"', flag: 'g' }, f.context)
  assert.deepEqual((await f.saved()).mcp.local.args, ['$&', '$&'], 'Replacement text is literal')
})

test('serialized revision checks reject stale overwrites and edits including secret-only changes', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  await f.store.update(raw => {
    const mcp = raw.mcp as typeof initialMcp
    mcp.local.env.TOKEN = 'synthetic-rotated-secret'
    return raw
  })
  await assert.rejects(f.overwrite(document), /revision conflict/)
  await assert.rejects(f.writer.execute({
    path, match: 'synthetic-nonexistent-command', content: 'stale-command',
  }, f.context), /revision conflict/)
  assert.equal((await f.saved()).mcp.local.env.TOKEN, 'synthetic-rotated-secret')
  const fresh = JSON.parse(await f.read())
  assert.notEqual(fresh.revision, document.revision)
  assert.equal(fresh.mcpServers.local.env.TOKEN, document.mcpServers.local.env.TOKEN)
  const results = await Promise.allSettled([
    f.overwrite({ ...fresh, mcpServers: { one: { command: 'first-command' } } }),
    f.overwrite({ ...fresh, mcpServers: { two: { command: 'second-command' } } }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.match(rejected.reason.message, /revision conflict/)
})

test('invalid JSON, schema, reserved names, and batches leave disk and catalog unchanged', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  const before = await readFile(f.configPath, 'utf8')
  await assert.rejects(
    f.writer.execute({ path, content: '{"synthetic-secret-in-invalid-json":' }, f.context),
    error => error instanceof Error && /Invalid JSON/.test(error.message) && !error.message.includes('synthetic-secret'),
  )
  for (const mcpServers of [
    { good: { command: 'unused-command' }, bad: { transport: 'stdio' } },
    { bad: { command: 'unused-command', args: [42] } },
    { bad: { type: 'streamable-http', url: 'file:///synthetic-secret' } },
    { builtin: { command: 'unused-command' } },
  ]) await assert.rejects(f.overwrite({ ...document, mcpServers }), /Invalid MCP|reserved/)
  await assert.rejects(f.overwrite({ ...document, extra: {} }), /must contain only/)
  assert.equal(await readFile(f.configPath, 'utf8'), before)
  assert.equal(f.activations(), 0)
})

test('unsupported server properties reject the whole batch without leaking keys or values', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  const before = await readFile(f.configPath, 'utf8')
  for (const extra of [
    { disabled: true },
    { timeout: 1000 },
    { oauth: { clientSecret: 'synthetic-unsupported-secret' } },
    { 'synthetic-private-key-name': 'synthetic-unsupported-secret' },
  ]) {
    await assert.rejects(f.overwrite({
      ...document,
      mcpServers: {
        good: { command: 'unused-command' },
        bad: { command: 'unused-command', ...extra },
      },
    }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Unsupported MCP server configuration properties/)
      assert.ok(!error.message.includes('synthetic-'))
      return true
    })
  }
  assert.equal(await readFile(f.configPath, 'utf8'), before)
  assert.equal(f.activations(), 0)
})

test('all supported server fields roundtrip with transport aliases normalized to type', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  const config = {
    command: 'synthetic-supported-command',
    args: ['--option', 'value'],
    env: { API_KEY: 'synthetic-supported-env', EMPTY: '' },
    url: 'https://synthetic.invalid/mcp',
    headers: { Authorization: 'synthetic-supported-header' },
    description: 'Supported server fields',
  }
  document.mcpServers = {
    both: { name: 'both', type: 'stdio', transport: 'stdio', ...config },
    alias: { transport: 'sse', url: config.url, description: 'Transport alias' },
    typeOnly: { type: 'streamable-http', url: config.url },
  }
  await f.overwrite(document)
  const expected = {
    both: { type: 'stdio', ...config },
    alias: { type: 'sse', url: config.url, description: 'Transport alias' },
    typeOnly: { type: 'streamable-http', url: config.url },
  }
  assert.deepEqual((await f.saved()).mcp, expected)
  const reread = JSON.parse(await f.read())
  assert.equal(reread.mcpServers.both.command, config.command)
  assert.deepEqual(reread.mcpServers.both.args, config.args)
  assert.equal(reread.mcpServers.both.url, config.url)
  assert.equal(reread.mcpServers.both.description, config.description)
  assert.notEqual(reread.mcpServers.both.env.API_KEY, config.env.API_KEY)
  assert.notEqual(reread.mcpServers.both.headers.Authorization, config.headers.Authorization)
  await f.overwrite(reread)
  assert.deepEqual((await f.saved()).mcp, expected, 'Redacted read/write preserves all supported values')
})

test('placeholders are bound to their field and explicit empty values clear credentials', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  const invalid = structuredClone(document)
  invalid.mcpServers.local.env.OTHER = invalid.mcpServers.local.env.TOKEN
  await assert.rejects(f.overwrite(invalid), /Unknown credential placeholder/)
  const unknown = structuredClone(document)
  unknown.mcpServers.local.env.TOKEN = '__SHADOW_MCP_REDACTED__:unknown'
  await assert.rejects(f.overwrite(unknown), /Unknown credential placeholder/)
  document.mcpServers.local.env.TOKEN = ''
  document.mcpServers.remote.headers = {}
  await f.overwrite(document)
  assert.equal((await f.saved()).mcp.local.env.TOKEN, '')
  assert.deepEqual((await f.saved()).mcp.remote.headers, {})
  const clear = JSON.parse(await f.read())
  clear.mcpServers.local.env = {}
  await f.overwrite(clear)
  assert.deepEqual((await f.saved()).mcp.local.env, {})
})

test('removing all servers also removes server names resembling credential fields', async t => {
  const f = await fixture(t, {
    ...initialMcp, token: { command: 'synthetic-command' }, apiKey: { command: 'synthetic-command' },
  })
  const document = JSON.parse(await f.read())
  document.mcpServers = {}
  await f.overwrite(document)
  assert.deepEqual((await f.saved()).mcp, {})
  assert.deepEqual(f.store.current().mcp.servers, [])
})

test('legacy reserved entries can roundtrip or be deleted, but cannot be modified or recreated', async t => {
  const builtin = { command: 'synthetic-legacy-command', env: { TOKEN: 'synthetic-legacy-secret' } }
  const f = await fixture(t, { ...initialMcp, builtin })
  const document = JSON.parse(await f.read())
  document.mcpServers.local.description = 'Unrelated change'
  document.mcpServers.builtin.transport = document.mcpServers.builtin.type
  delete document.mcpServers.builtin.type
  await f.overwrite(document)
  assert.deepEqual((await f.saved()).mcp.builtin, { ...builtin, type: 'stdio' })
  assert.equal((await f.saved()).mcp.local.description, 'Unrelated change')

  const fresh = JSON.parse(await f.read())
  const before = await readFile(f.configPath, 'utf8')
  for (const change of [
    { command: 'synthetic-replacement-command' },
    { env: { TOKEN: 'synthetic-replacement-secret' } },
    { description: 'Modified reserved entry' },
  ]) {
    await assert.rejects(f.overwrite({
      ...fresh,
      mcpServers: { ...fresh.mcpServers, builtin: { ...fresh.mcpServers.builtin, ...change } },
    }), /reserved by the runtime/)
  }
  assert.equal(await readFile(f.configPath, 'utf8'), before)
  assert.equal(f.activations(), 1)

  delete fresh.mcpServers.builtin
  await f.overwrite(fresh)
  assert.equal(Object.hasOwn((await f.saved()).mcp, 'builtin'), false)
  const removed = JSON.parse(await f.read())
  removed.mcpServers.builtin = builtin
  await assert.rejects(f.overwrite(removed), /reserved by the runtime/)
  assert.equal(f.activations(), 2)
})

test('Project, call-mode, remote and unsupported virtual writes fail before execution', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  await assert.rejects(f.overwrite(document, { ...f.context, projectId: 'foreign' }), /different Project/)
  await assert.rejects(f.overwrite(document, { ...f.context, projectId: undefined }), /different Project/)
  await assert.rejects(f.reader.execute({ path }, { ...f.context, projectId: 'foreign' }), /different Project/)
  let remoteCalls = 0
  const remote = {
    ...f.context, remoteWorkdir: {
      nodeId: 'node', capabilityId: 'capability',
      executor: { execute: () => { remoteCalls++; throw new Error('must not execute') } } as never,
    },
  }
  await assert.rejects(f.overwrite(document, remote), /local workdir/)
  await assert.rejects(Promise.resolve().then(() => f.handlers.write('mcp.json', { content: '{}' }, remote)), /local workdir/)
  f.context.tools.setExecutionScope('call', [])
  await assert.rejects(f.overwrite(document), /call mode/)
  await assert.rejects(Promise.resolve().then(() => f.handlers.write('mcp.json', { content: '{}' }, f.context)), /call mode/)
  assert.match(await f.writer.execute({ path, content: '{}', flag: 'a' }, f.context), /append is unsupported/)
  assert.match(await f.writer.execute({ path, content: '{}', flag: 'x' }, f.context), /support overwrite or exact edit only/)
  assert.equal(remoteCalls, 0)
  assert.equal(f.activations(), 0)
})

test('unknown and read-only virtual paths do not fall through to physical or remote filesystems', async t => {
  const f = await fixture(t)
  f.vfs.mount('v:readonly', 'Read only', () => 'fixture')
  for (const unknown of ['v:unknown/item', 'v:config/missing', 'v:config/../mcp.json', 'v:config\\missing']) {
    await assert.rejects(f.writer.execute({ path: unknown, content: 'must-not-write' }, f.context), /Unknown virtual/)
  }
  await assert.rejects(f.writer.execute({ path: 'v:readonly/item', content: 'must-not-write' }, f.context), /read-only/)
  await assert.rejects(f.reader.execute({ path: 'v:unknown/item' }, f.context), /Unknown virtual/)
  assert.match(await new WriteTool(f.root).execute({ path, content: 'must-not-write' }, f.context), /unknown virtual/)
})

test('external edits are preserved and activation failures roll back without leaking credentials', async t => {
  const f = await fixture(t)
  const document = JSON.parse(await f.read())
  const before = await readFile(f.configPath, 'utf8')
  f.failActivation(new Error('synthetic activation failure: synthetic-env-secret; new-secret-for-failure'))
  document.mcpServers.local.env.TOKEN = 'new-secret-for-failure'
  await assert.rejects(f.overwrite(document), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /previous file was restored/)
    assert.match(error.message, /synthetic activation failure/)
    assert.ok(!error.message.includes('synthetic-env-secret'))
    assert.ok(!error.message.includes('new-secret-for-failure'))
    return true
  })
  assert.equal(await readFile(f.configPath, 'utf8'), before)
  assert.equal(f.store.current().mcp.servers[0].env?.TOKEN, 'synthetic-env-secret')
  const external = before + '\n'
  await writeFile(f.configPath, external)
  await assert.rejects(f.overwrite(document), /changed on disk/)
  assert.equal(await readFile(f.configPath, 'utf8'), external)
})
