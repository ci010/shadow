import { requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpConnection } from './client.ts'
import { McpError } from './errors.ts'
import { McpToolAdapter } from './adapter.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { pngFixture } from '../testing/image.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'

async function connected(t: TestContext): Promise<McpConnection> {
  t.mock.method(Client.prototype, 'connect', async () => {})
  const connection = new McpConnection({ name: 'fixture', transport: 'stdio', command: 'node' })
  t.after(() => connection.disconnect())
  await connection.connect()
  return connection
}

test('MCP roots are explicit canonical local file URIs, not an implicit grant of the server cwd', async () => withTempWorkspace(async home => {
  const workdir = join(home, 'session # alpha')
  await mkdir(workdir)
  const script = join(home, 'roots-server.mjs')
  await writeFile(script, `
    import {Server} from '@modelcontextprotocol/sdk/server/index.js';
    import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
    import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
    const server=new Server({name:'roots-fixture',version:'1'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>{
      const result=server.getClientCapabilities()?.roots?await server.listRoots():{roots:[]};
      return {tools:[{name:'inspect_roots',description:JSON.stringify(result.roots),inputSchema:{type:'object'}}]};
    });
    await server.connect(new StdioServerTransport());
  `)
  for (const root of [workdir, undefined]) {
    const connection = new McpConnection({ name: 'roots-fixture', transport: 'stdio', command: process.execPath, args: [script] }, home, root)
    try {
      const pending = connection.connect(AbortSignal.timeout(10_000))
      await assert.rejects(connection.connect(), /already connected or connecting/)
      await pending
      const tools = await connection.listTools()
      assert.deepEqual(JSON.parse(tools[0].description), root ? [{ uri: pathToFileURL(workdir).href, name: 'Session workdir' }] : [])
    } finally { await connection.disconnect() }
  }
  const invalid = new McpConnection({ name: 'roots-fixture', transport: 'stdio', command: process.execPath }, home, 'relative')
  await assert.rejects(invalid.connect(), /resolved local directories/)
}))

test('MCP selects all native SDK transports without starting real services', async (t) => {
  const transports: Transport[] = []
  t.mock.method(Client.prototype, 'connect', async (transport: Transport) => { transports.push(transport) })
  for (const transport of ['stdio', 'sse', 'streamable-http'] as const) {
    const connection = new McpConnection({
      name: 'fixture', transport, command: 'node', url: 'https://example.invalid/mcp',
      headers: { Authorization: 'synthetic' },
    })
    await connection.connect()
    await connection.disconnect()
  }
  assert.ok(transports[0] instanceof StdioClientTransport)
  assert.ok(transports[1] instanceof SSEClientTransport)
  assert.ok(transports[2] instanceof StreamableHTTPClientTransport)
  for (const transport of transports.slice(1)) {
    assert.deepEqual(Reflect.get(transport, '_requestInit'), { headers: { Authorization: 'synthetic' } })
    assert.equal(Reflect.get(transport, '_authProvider'), undefined)
  }
})

test('stdio retains cwd and config > process > workspace environment priority', async (t) => {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
  const cwd = await mkdtemp(join(process.cwd(), '.tmp', 'mcp-client-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, '.env'), 'SHADOW_MCP_FIXTURE=workspace\nSHADOW_MCP_ONLY_FILE=file\n')
  const old = process.env.SHADOW_MCP_FIXTURE
  process.env.SHADOW_MCP_FIXTURE = 'process'
  t.after(() => {
    if (old === undefined) delete process.env.SHADOW_MCP_FIXTURE
    else process.env.SHADOW_MCP_FIXTURE = old
  })
  const environments: Record<string, string>[] = []
  t.mock.method(Client.prototype, 'connect', async (transport: Transport) => {
    const parameters = Reflect.get(transport, '_serverParams')
    assert.equal(parameters.cwd, cwd)
    assert.deepEqual(parameters.args, ['fixture.js'])
    environments.push(parameters.env)
  })
  for (const env of [undefined, { SHADOW_MCP_FIXTURE: 'config' }]) {
    const connection = new McpConnection({ name: 'fixture', transport: 'stdio', command: 'node', args: ['fixture.js'], env }, cwd)
    await connection.connect()
    await connection.disconnect()
  }
  assert.equal(environments[0].SHADOW_MCP_FIXTURE, 'process')
  assert.equal(environments[1].SHADOW_MCP_FIXTURE, 'config')
  assert.equal(environments[0].SHADOW_MCP_ONLY_FILE, 'file')
})

test('listTools follows all pages including empty cursor and guards cursor cycles', async (t) => {
  const connection = await connected(t)
  const controller = new AbortController()
  const cursors: unknown[] = []
  const list = t.mock.method(Client.prototype, 'listTools', async (...[params, options]: Parameters<Client['listTools']>) => {
    assert.equal(options?.signal, controller.signal)
    cursors.push(params?.cursor)
    return {
      tools: [{ name: `tool${cursors.length}`, inputSchema: { type: 'object' } }],
      nextCursor: cursors.length === 1 ? '' : cursors.length === 2 ? 'next' : undefined,
    }
  })

  const tools = await connection.listTools(controller.signal)
  assert.deepEqual(cursors, [undefined, '', 'next'])
  assert.deepEqual(tools.map((tool) => tool.name), ['tool1', 'tool2', 'tool3'])
  assert.equal(tools[0].description, '')
  list.mock.mockImplementation(async () => ({ tools: [], nextCursor: 'loop' }))
  await assert.rejects(connection.listTools(), /repeated pagination cursor/)
})

test('MCP discovery preserves readonly hints and advertised server versions without inventing defaults', async t => {
  const connection = await connected(t)
  t.mock.method(Client.prototype, 'getServerVersion', () => ({ name: 'fixture', version: '2' }))
  t.mock.method(Client.prototype, 'listTools', async () => ({ tools: [
    { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'unknown', inputSchema: { type: 'object' } },
  ] }))
  const tools = await connection.listTools()
  assert.deepEqual(tools.map(tool => tool.readOnlyHint), [true, false, undefined])
  assert.equal(Object.hasOwn(tools[2], 'readOnlyHint'), false)
  assert.deepEqual(tools.map(tool => tool.serverVersion), Array(3).fill({ name: 'fixture', version: '2' }))
})

test('text compatibility, tool errors, structured/media content and private metadata', async (t) => {
  const connection = await connected(t)
  const replies = [
    { content: [{ type: 'text', text: 'one' }, { type: 'text', text: '' }, { type: 'text', text: 'two' }] },
    { isError: true, content: [{ type: 'text', text: 'failed', _meta: { secret: true }, privateField: 'hidden' }], _meta: { secret: true }, privateField: 'hidden' },
    {
      structuredContent: { answer: 42 },
      content: [
        { type: 'image', data: 'aGk=', mimeType: 'image/png', _meta: { secret: true } },
        { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'fixture:///text', text: 'embedded', _meta: { secret: true }, privateField: 'hidden' } },
        { type: 'resource', resource: { uri: 'fixture:///blob', blob: 'aGk=', mimeType: 'application/octet-stream' } },
        { type: 'resource_link', uri: 'fixture:///link', name: 'link', description: 'resource' },
      ],
    },
    { structuredContent: { answer: 42 } },
  ]
  t.mock.method(Client.prototype, 'callTool', async () => replies.shift())
  assert.equal(await connection.callTool('fixture', {}), 'one\ntwo')
  assert.deepEqual(JSON.parse(requireToolText(await connection.callTool('fixture', {}))), {
    isError: true, content: [{ type: 'text', text: 'failed' }],
  })
  const media = await connection.callTool('fixture', {})
  assert.notEqual(typeof media, 'string')
  if (typeof media === 'string') throw new Error('Expected multimodal MCP output')
  assert.equal(media.isError, false)
  assert.equal(media.content.length, 6)
  assert.deepEqual(media.content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=', detail: 'auto' } })
  assert.deepEqual(media.content[2], { type: 'text', text: JSON.stringify({ type: 'resource', resource: { uri: 'fixture:///text', text: 'embedded' } }) })
  assert.deepEqual(media.content[5], { type: 'text', text: JSON.stringify({ structuredContent: { answer: 42 } }) })
  assert.equal(JSON.stringify(media).includes('_meta'), false)
  assert.deepEqual(JSON.parse(requireToolText(await connection.callTool('fixture', {}))), { isError: false, content: [], structuredContent: { answer: 42 } })
})

test('malformed tool results fail explicitly', async (t) => {
  const connection = await connected(t)
  let reply: unknown
  t.mock.method(Client.prototype, 'callTool', async () => reply)
  for (const result of [null, { content: 'bad' }, { isError: 'yes', content: [] }, { content: [{ type: 'text' }] }, { content: [{ type: 'image', data: '%%%', mimeType: 'image/png' }] }, { content: [{ type: 'unsupported' }] }]) {
    reply = result
    await assert.rejects(connection.callTool('fixture', {}), /Malformed MCP tool result/)
  }
})

test('MCP image output reaches the registry as validated visual content, retaining errors and mixed text', async t => {
  const connection = await connected(t)
  await withTempWorkspace(async home => {
    const base = new Tools(home)
    const adapter = new McpToolAdapter(connection, { name: 'screenshot', description: '', inputSchema: { type: 'object', properties: {} } })
    base.register(adapter)
    const tools = new SessionTools(base, home)
    const context: ExecutionContext = {
      sessionId: 'mcp-images', physicalSessionId: 'mcp-images-0', channel: 'web', chatId: 'fixture',
      senderId: 'fixture', messageId: 'fixture', tools, signal: new AbortController().signal,
    }
    let data = pngFixture().toString('base64')
    let isError = false
    t.mock.method(Client.prototype, 'callTool', async () => ({
      isError, content: [{ type: 'text', text: 'Screenshot evidence' }, { type: 'image', data, mimeType: 'image/png' }],
    }))
    for (const failed of [false, true]) {
      isError = failed
      const result = await tools.execute(adapter.name, {}, context)
      assert(typeof result !== 'string')
      assert.equal(result.isError === true, failed)
      assert(result.content.some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${data}`))
      assert(result.content.some(part => part.type === 'text' && part.text.includes('Screenshot evidence')))
    }
    data = 'aGk='
    assert.match(requireToolText(await tools.execute(adapter.name, {}, context)), /Invalid image header/)
  })
})

test('aborting startup closes stalled SDK transport and permits reconnect', async (t) => {
  const controller = new AbortController()
  let started!: () => void
  const starting = new Promise<void>((resolve) => { started = resolve })
  const close = t.mock.method(SSEClientTransport.prototype, 'close', async () => {})
  const connect = t.mock.method(Client.prototype, 'connect', async (...[_transport, options]: Parameters<Client['connect']>) => {
    assert.ok(options?.signal)
    started()
    await new Promise<void>(() => {})
  })
  const connection = new McpConnection({ name: 'fixture', transport: 'sse', url: 'https://example.invalid' })
  const pending = connection.connect(controller.signal)
  await starting
  const reason = new Error('cancel startup')
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(close.mock.callCount(), 1)
  connect.mock.mockImplementation(async () => {})
  await connection.connect()
  await connection.disconnect()
  assert.equal(close.mock.callCount(), 2)
})

test('failed connect and disconnect during startup clean transport exactly once', async (t) => {
  const close = t.mock.method(StdioClientTransport.prototype, 'close', async () => {})
  const connect = t.mock.method(Client.prototype, 'connect', async (transport: Transport) => {
    await transport.close()
    throw new Error('initialize failed')
  })
  const connection = new McpConnection({ name: 'fixture', transport: 'stdio', command: 'node' })
  await assert.rejects(connection.connect(), /initialize failed/)
  assert.equal(close.mock.callCount(), 1)
  let started!: () => void
  const starting = new Promise<void>((resolve) => { started = resolve })
  connect.mock.mockImplementation(async () => { started(); await new Promise<void>(() => {}) })
  const pending = connection.connect()
  await starting
  await connection.disconnect()
  await assert.rejects(pending, /disconnected/)
  assert.equal(close.mock.callCount(), 2)
})

test('pre-aborted operations do not start SDK work', async (t) => {
  const controller = new AbortController()
  controller.abort(new Error('already cancelled'))
  const connect = t.mock.method(Client.prototype, 'connect', async () => {})
  const call = t.mock.method(Client.prototype, 'callTool', async () => ({ content: [] }))
  const list = t.mock.method(Client.prototype, 'listTools', async () => ({ tools: [] }))
  const connection = new McpConnection({ name: 'fixture', transport: 'stdio', command: 'node' })
  await assert.rejects(connection.connect(controller.signal), /already cancelled/)
  await assert.rejects(connection.listTools(controller.signal), /already cancelled/)
  await assert.rejects(connection.callTool('fixture', {}, controller.signal), /already cancelled/)
  assert.equal(connect.mock.callCount() + call.mock.callCount() + list.mock.callCount(), 0)
})

test('real HTTP SDK startup cancellation aborts transport fetch and retains auth headers', async (t) => {
  let fetched!: () => void
  let requestSignal: AbortSignal | null | undefined
  t.mock.method(globalThis, 'fetch', async (...[_input, init]: Parameters<typeof fetch>) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'synthetic')
    requestSignal = init?.signal
    assert.ok(requestSignal)
    fetched()
    return await new Promise<Response>((_, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  for (const transport of ['sse', 'streamable-http'] as const) {
    const started = new Promise<void>((resolve) => { fetched = resolve })
    const controller = new AbortController()
    const connection = new McpConnection({
      name: 'fixture', transport, url: 'https://example.invalid/mcp',
      headers: { Authorization: 'synthetic' },
    })
    t.after(() => connection.disconnect())
    const pending = connection.connect(controller.signal)
    await started
    controller.abort(new Error('cancel HTTP startup'))
    await assert.rejects(pending, /cancel HTTP startup/)
    assert.equal(requestSignal?.aborted, true)
  }
})

test('failed connection reports transport cleanup failures', async (t) => {
  t.mock.method(Client.prototype, 'connect', async () => { throw new Error('initialize failed') })
  t.mock.method(StdioClientTransport.prototype, 'close', async () => { throw new Error('cleanup failed') })
  const connection = new McpConnection({ name: 'fixture', transport: 'stdio', command: 'node' })
  await assert.rejects(connection.connect(), (error) => {
    assert.ok(error instanceof McpError)
    assert.equal(error.diagnostic.message, 'initialize failed')
    assert.equal(error.diagnostic.cleanupFailure?.message, 'cleanup failed')
    return true
  })
})

test('authenticated SDK failures preserve sanitized diagnostics, not credentials or arbitrary fields', async (t) => {
  const secret = 'synthetic-private-credential'
  const remoteError = Object.assign(new Error(`Remote response echoed ${secret}`, {
    cause: new Error(secret),
  }), { code: 401, _meta: { secret }, headers: { Authorization: secret } })
  let connectFails = true
  let closeFails = false
  t.mock.method(Client.prototype, 'connect', async () => {
    if (connectFails) throw remoteError
  })
  const close = t.mock.method(SSEClientTransport.prototype, 'close', async () => {
    if (closeFails) throw remoteError
  })
  t.mock.method(Client.prototype, 'listTools', async () => { throw remoteError })
  t.mock.method(Client.prototype, 'callTool', async () => { throw remoteError })
  const connection = new McpConnection({
    name: 'fixture', transport: 'sse', url: 'https://example.invalid/mcp',
    headers: { Authorization: secret },
  })
  const safe = (error: unknown): boolean => {
    assert.ok(error instanceof Error)
    assert.equal(inspect(error).includes(secret), false)
    assert.equal(inspect(error).includes('_meta'), false)
    assert.equal('cause' in error, false)
    assert.ok(error instanceof McpError)
    assert.equal(error.diagnostic.httpStatus, 401)
    assert.equal(error.diagnostic.category, 'authentication_required')
    assert.match(error.diagnostic.message, /Remote response echoed/)
    return true
  }
  await assert.rejects(connection.connect(), safe)
  closeFails = true
  await assert.rejects(connection.connect(), (error) => {
    assert.ok(error instanceof McpError)
    assert.equal(error.diagnostic.cleanupFailure?.httpStatus, 401)
    return safe(error)
  })
  connectFails = false
  closeFails = false
  await connection.connect()
  await assert.rejects(connection.listTools(), safe)
  await assert.rejects(connection.callTool('fixture', {}), safe)
  closeFails = true
  await assert.rejects(connection.disconnect(), safe)
  await connection.disconnect()
  assert.equal(close.mock.callCount(), 3)
})

test('real stdio startup failures include bounded sanitized stderr', async () => {
  const connection = new McpConnection({
    name: 'fixture', transport: 'stdio', command: process.execPath,
    args: ['-e', 'process.stderr.write("Missing required setting; API_KEY=" + process.env.API_KEY + "\\n"); process.exit(1)'],
    env: { API_KEY: 'synthetic-private-credential' },
  })
  try {
    await assert.rejects(connection.connect(AbortSignal.timeout(10_000)), (error) => {
      assert.ok(error instanceof McpError)
      assert.equal(error.diagnostic.phase, 'connect')
      assert.match(error.diagnostic.stderr ?? '', /Missing required setting/)
      assert.doesNotMatch(inspect(error), /synthetic-private-credential/)
      return true
    })
  } finally {
    await connection.disconnect()
  }
})

test('real HTTP SDK failures disclose response status and sanitized server explanation', async t => {
  const secret = 'synthetic-private-credential'
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(`Access denied for folder; echoed ${secret}`, { status: 403 }))
  const connection = new McpConnection({
    name: 'fixture', transport: 'streamable-http', url: 'https://example.invalid/mcp',
    headers: { Authorization: `Bearer ${secret}` },
  })

  try {
    await assert.rejects(connection.connect(AbortSignal.timeout(10_000)), error => {
      assert.ok(error instanceof McpError)
      assert.equal(error.diagnostic.httpStatus, 403)
      assert.equal(error.diagnostic.category, 'permission_denied')
      assert.match(error.diagnostic.message, /Access denied for folder/)
      assert.doesNotMatch(inspect(error), /synthetic-private-credential/)
      return true
    })
  } finally {
    await connection.disconnect()
  }
})

test('a missing stdio executable preserves native ENOENT or Windows shell diagnostics without inventing a code', async () => {
  const connection = new McpConnection({
    name: 'fixture', transport: 'stdio',
    command: join(process.cwd(), '.tmp', `missing-mcp-${crypto.randomUUID()}.exe`),
  })
  try {
    await assert.rejects(connection.connect(AbortSignal.timeout(10_000)), error => {
      assert.ok(error instanceof McpError)
      if (process.platform === 'win32') {
        assert.match(error.diagnostic.stderr ?? '', /not recognized as an internal or external command/)
        assert.equal(error.diagnostic.rpcCode, -32000)
      } else {
        assert.equal(error.diagnostic.systemCode, 'ENOENT', error.message)
      }
      assert.equal(error.diagnostic.category, 'executable_not_found')
      return true
    })
  } finally {
    await connection.disconnect()
  }
})

test('invalid stdio JSON retains the transport parse error behind connection closure', async () => {
  const connection = new McpConnection({
    name: 'fixture', transport: 'stdio', command: process.execPath,
    args: ['-e', 'process.stdout.write("not-json\\n"); process.exit(1)'],
  })
  try {
    await assert.rejects(connection.connect(AbortSignal.timeout(10_000)), error => {
      assert.ok(error instanceof McpError)
      assert.equal(error.diagnostic.category, 'protocol_error', error.message)
      assert.match(error.diagnostic.causes?.join('\n') ?? '', /JSON|Unexpected token/)
      return true
    })
  } finally {
    await connection.disconnect()
  }
})

test('real SDK RPC cancellation and tool-list notifications preserve connection lifecycle', async (t) => {
  const messages: { method?: string }[] = []
  let transport!: StdioClientTransport
  t.mock.method(StdioClientTransport.prototype, 'start', async function (this: StdioClientTransport) { transport = this })
  t.mock.method(StdioClientTransport.prototype, 'close', async function (this: StdioClientTransport) { this.onclose?.() })
  t.mock.method(StdioClientTransport.prototype, 'send', async function (this: StdioClientTransport, message: Parameters<StdioClientTransport['send']>[0]) {
    if (!('method' in message)) return
    messages.push(message)
    if (message.method === 'initialize' && 'id' in message) {
      this.onmessage?.({
        jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
      })
    }
  })
  const connection = new McpConnection({ name: 'fixture', transport: 'stdio', command: 'node' })
  t.after(() => connection.disconnect())
  await connection.connect()
  let changes = 0
  connection.setToolsChangedHandler(() => { changes++ })
  transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  await setImmediate()
  assert.equal(changes, 1)
  for (const operation of ['list', 'call']) {
    const controller = new AbortController()
    const pending = operation === 'list'
      ? connection.listTools(controller.signal)
      : connection.callTool('fixture', {}, controller.signal)
    controller.abort(new Error('cancel RPC'))
    await assert.rejects(pending, /cancel RPC/)
  }
  assert.equal(messages.filter((message) => message.method === 'tools/list').length, 1)
  assert.equal(messages.filter((message) => message.method === 'tools/call').length, 1)
  assert.equal(messages.filter((message) => message.method === 'notifications/cancelled').length, 2)
  await connection.disconnect()
  transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  await setImmediate()
  assert.equal(changes, 1)
})
