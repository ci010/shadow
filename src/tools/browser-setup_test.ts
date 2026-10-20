import { requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { ChromeManager, ChromePortAllocator, type ChromeRuntimeOperations } from '../browser/chrome-manager.ts'
import { McpConnection } from '../mcp/client.ts'
import { CallTools } from '../sessions/call-tools.ts'
import { withTempWorkspace as withBaseWorkspace } from '../testing/workspace.ts'

// Resource cleanup must precede deleting the now-persistent slot metadata.
const workspaceCleanups = new Map<string, Array<() => Promise<void>>>()
async function withTempWorkspace(fn: (home: string) => Promise<void>): Promise<void> {
  await withBaseWorkspace(async home => {
    workspaceCleanups.set(home, [])
    try { await fn(home) } finally {
      try { for (const cleanup of workspaceCleanups.get(home)!) await cleanup() }
      finally { workspaceCleanups.delete(home) }
    }
  })
}
import type { ExecutionContext } from './context.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SearchTool } from './search.ts'
import { SessionTools, Tools } from './registry.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { ReadTool } from './read.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { WorkTool } from './work.ts'
import { BrowserSetupTool } from './browser-setup.ts'

function fixture(t: TestContext, home: string) {
  const config = { executablePath: 'project-default', basePort: 9322 }
  const live = new Map<number, { pid: number; path: string }>()
  const terminated: number[] = []
  const profiles: string[] = []
  let pid = 100
  const runtime: ChromeRuntimeOperations = {
      getUserDataDir: () => null,
    detectChrome: async (path, browser) => path ?? browser ?? 'default',
    isDebugPortActive: async port => live.has(port),
    isProcessAlive: id => [...live.values()].some(value => value.pid === id),
    launchChrome: async (path, port, profile) => {
      profiles.push(profile)
      live.set(port, { pid: ++pid, path })
      return { pid }
    },
    terminateChrome: id => {
      terminated.push(id)
      for (const [port, value] of live) if (value.pid === id) live.delete(port)
    },
  }
  const manager = new ChromeManager(home, () => config, {
    projectId: 'project', runtime, portAllocator: new ChromePortAllocator(async port => !live.has(port)),
  })
  const loadable = new Map<string, LoadableEntry>([['chrome-devtools', {
    config: { name: 'chrome-devtools', transport: 'stdio', command: 'synthetic-never-run', args: ['chrome-devtools-mcp@latest'] },
    chromeManager: manager,
  }]])
  const importer = new ImportTool(loadable, home, manager)
  const base = new Tools(home)
  const vfs = new VirtualFs()
  vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, options) => importer.virtualEntries(ctx, options))
  base.register(new InvokeTool(importer))
  base.register(new SearchTool(home, undefined, vfs))
  base.register(new ReadTool(home, vfs))
  const sessions: SessionTools[] = []
  const session = (blocked?: string[]) => {
    const tools = new SessionTools(base, home, undefined, blocked)
    sessions.push(tools)
    return { tools, projectId: 'project', sessionId: crypto.randomUUID(), signal: new AbortController().signal } as ExecutionContext
  }
  const browser = (conn: McpConnection) => {
    const endpoint = conn.config.args?.find(arg => /^--(?:browserUrl|wsEndpoint)=/.test(arg))?.split('=').slice(1).join('=')
    assert.ok(endpoint)
    return live.get(Number(new URL(endpoint).port))?.path ?? 'attached'
  }
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  const disconnect = t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  const changed = new Map<string, () => void>()
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', function (this: McpConnection, handler: () => void) {
    changed.set(browser(this), handler)
  })
  const list = t.mock.method(McpConnection.prototype, 'listTools', async function (this: McpConnection) {
    return [{
      name: 'inspect', description: 'Inspect selected browser',
      inputSchema: {
        type: 'object', properties: { value: { type: browser(this) === 'brave' ? 'number' : 'string' } },
        required: ['value'], additionalProperties: false,
      },
    }]
  })
  const call = t.mock.method(McpConnection.prototype, 'callTool', async function (this: McpConnection, _name: string, args: Record<string, unknown>) {
    return JSON.stringify({ browser: browser(this), args })
  })
  const invoke = (context: ExecutionContext, args: Record<string, unknown>, instance?: string) =>
    context.tools.execute('invoke_tool', { name: 'chrome-devtools__inspect', args, instance }, context)
  const setup = (context: ExecutionContext, args: Record<string, unknown>) =>
    context.tools.execute('invoke_tool', { name: 'browser_setup', args }, context)
  const search = async (context: ExecutionContext, args: Record<string, unknown> = {}) => {
    const path = `v:tools/chrome-devtools${args.instance ? `/${args.instance}` : ''}`
    const result = requireToolText(await context.tools.execute('search', { handler: 'glob', path: path, query: '*__inspect' }, context))
    if (result.startsWith('Error') || result.includes('Warning:')) return result
    const paths = result.split('\n').filter(line => line.startsWith('v:'))
    const tools = await Promise.all(paths.map(async path =>
      JSON.parse(requireToolText(await context.tools.execute('read', { path }, context)))))
    return JSON.stringify({ tools })
  }
  workspaceCleanups.get(home)!.push(async () => {
    for (const tools of sessions) await tools.resetDynamicAndWait()
    await manager.releaseAll()
  })
  return { session, importer, base, manager, config, live, profiles, terminated, connect, disconnect, call, list, changed, invoke, setup, search }
}

test('private app handoff uses a fresh owned browser and never returns the launch credential', async t => withTempWorkspace(async home => {
  const f = fixture(t, home)
  f.list.mock.mockImplementation(async () => [
    { name: 'new_page', description: '', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'evaluate_script', description: '', inputSchema: { type: 'object', properties: { function: { type: 'string' }, pageId: { type: 'number' } }, required: ['function', 'pageId'] } },
  ])
  f.call.mock.mockImplementation(async (name: string) => name === 'new_page'
    ? '## Pages\n1: about:blank\n7: App fixture (http://127.0.0.1:1234/) [selected]'
    : '{"connected":true}')
  const context = f.session()
  await f.setup(context, { action: 'attach', endpoint: 'http://127.0.0.1:9555' })
  const secret = 'private-ticket-must-not-reach-model'
  const identity = { id: crypto.randomUUID(), revision: 'a'.repeat(64) }
  const receipt = await f.importer.openApp(context, identity, async () => ({ url: `http://127.0.0.1:1234/#shadow_ticket=${secret}` }))
  assert.equal(receipt.mode, 'launch')
  assert.equal(receipt.owned, true)
  assert.equal(receipt.pageId, 7)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret))
  assert.equal(f.call.mock.callCount(), 2)
  assert.ok(JSON.stringify(f.call.mock.calls[0].arguments).includes(secret))
  assert.ok(JSON.stringify(f.call.mock.calls[1].arguments).includes('sdk.status()'))
  assert.equal(f.call.mock.calls[1].arguments[1].pageId, 7)
  assert.equal(f.profiles.length, 1, 'Never attach to or navigate the existing external browser')
  f.call.mock.mockImplementation(async () => { throw new Error(`Navigation failed: ${secret}`) })
  await assert.rejects(f.importer.openApp(context, identity, async () => ({ url: `http://127.0.0.1:1234/#shadow_ticket=${secret}` })),
    error => error instanceof Error && /private app navigation/.test(error.message) && !error.message.includes(secret))
  assert.equal(f.terminated.length, 1)
  for (const pages of [
    '## Pages\n7: http://127.0.0.1:9999/ [selected]',
    '## Pages\n7: http://127.0.0.1:1234/ [selected]\n8: http://127.0.0.1:1234/ [selected]',
    '## Pages\n7: http://127.0.0.1:1234/',
  ]) {
    f.call.mock.mockImplementation(async () => pages)
    const before = f.call.mock.callCount()
    await assert.rejects(f.importer.openApp(context, identity, async () => ({ url: `http://127.0.0.1:1234/#shadow_ticket=${secret}` })), /private app navigation/)
    assert.equal(f.call.mock.callCount(), before + 1, 'Do not evaluate an unidentified or foreign page')
  }
  for (const blocked of ['browser_setup', 'chrome-devtools__new_page', 'chrome-devtools__evaluate_script']) {
    await assert.rejects(f.importer.openApp(f.session([blocked]), identity, async () => { assert.fail('Must not issue a ticket') }), /enabled/)
  }
  await assert.rejects(f.importer.openApp({ ...context, projectId: 'foreign' }, identity, async () => { assert.fail('Must not issue a ticket') }), /mismatch/)
  const leaf = new CallTools(context.tools, home)
  leaf.setExecutionScope('call', [])
  await assert.rejects(f.importer.openApp({ ...context, tools: leaf }, identity, async () => { assert.fail('Must not issue a ticket') }), /owner-held/)
}))

test('browser cleanup classification is strict and distinct from read-only metadata', () => {
  const tool = new BrowserSetupTool(async () => 'unused')
  assert.equal(tool.readonly({ action: 'list' }), true)
  assert.equal(tool.readonly({ action: 'close', instance: 'owned' }), false)
  assert.equal(tool.workAdmission({ action: 'close', instance: 'owned' }), 'cleanup')
  for (const args of [
    { action: 'launch' }, { action: 'attach', endpoint: 'http://127.0.0.1:9222' }, { action: 'list' },
    { action: 'close' }, { action: 'close', instance: '' }, { action: 'close', instance: 42 },
    { action: 'close', instance: 'owned', endpoint: 'http://127.0.0.1:9222' },
  ]) assert.equal(tool.workAdmission(args), undefined)
})

test('Work fences new browser work but not owner-scoped inspection and cleanup', async t => {
  for (const state of ['blocked', 'paused', 'done', 'cancelled', 'stale', 'unknown'] as const) {
    await t.test(state, async t => withTempWorkspace(async home => {
      const f = fixture(t, home)
      const owner = f.session(), peer = f.session()
      const owned = JSON.parse(requireToolText(await f.setup(owner, { action: 'launch', browser: 'edge' })))
      const attached = JSON.parse(requireToolText(await f.setup(owner, { action: 'attach', endpoint: 'http://127.0.0.1:9555' })))
      const foreign = JSON.parse(requireToolText(await f.setup(peer, { action: 'launch', browser: 'brave' })))
      const store = new InitiativeStore(home, { isSessionKnown: id => [owner.sessionId, peer.sessionId].includes(id) })
      const alignment = new WorkAlignment(store, {
        state: id => [owner.sessionId, peer.sessionId].includes(id) ? { sessionId: id, mode: 'session', segmentIndex: 0 } : undefined,
        evidence: async () => { throw new Error('No acceptance evidence is provided by this fixture') },
        changed: async () => {}, fresh: async () => {}, successor: async () => undefined,
      })
      const actor = { kind: 'session' as const, sessionId: owner.sessionId }
      try {
        f.base.setWorkGuard(alignment)
        f.base.register(new WorkTool(alignment))
        const record = await alignment.execute(actor, 'create', undefined, undefined, {
          title: 'Browser acceptance', reason: 'Synthetic request',
          definition: { objective: 'Inspect then release the owned browser', acceptance: ['Owner review remains required'], boundaries: ['No extra authority'], evidence: [] },
        }) as WorkRecord
        await alignment.execute(actor, 'adopt', record.key, record.revision,
          { understanding: 'Inspect then clean up', stop: [], retain: [], next: ['Inspect browser'] })
        owner.workStamps = alignment.snapshot(owner.sessionId)
        const current = alignment.get(record.key)
        if (state === 'blocked' || state === 'cancelled') {
          await alignment.execute(actor, 'progress', record.key, record.revision, {
            expectedSequence: current.sequence, status: state,
            ...(state === 'blocked' ? { blockedReason: 'Waiting for exact owner approval', blockedScope: 'work' } : {}),
          })
        } else if (state === 'unknown') {
          store.startWorkEffect('uncertain-browser-operation', owner.sessionId, 'fixture_write', owner.workStamps)
          store.finishWorkEffect('uncertain-browser-operation', true)
        } else {
          store.saveWork({
            ...current, sequence: current.sequence + 1,
            ...(state === 'paused' ? { paused: true } : state === 'stale' ? { adoption: undefined }
              : { workflow: { ...current.workflow!, status: 'done' } }),
          }, current.sequence, owner.sessionId, 'fixture')
        }
        const before = alignment.get(record.key), effects = store.workEffects()
        const connections = f.connect.mock.callCount()
        assert.match(requireToolText(await f.setup(owner, { action: 'launch', browser: 'edge' })), /^Error/)
        assert.match(requireToolText(await f.setup(owner, { action: 'attach', endpoint: 'http://127.0.0.1:9556' })), /^Error/)
        assert.match(requireToolText(await f.invoke(owner, { value: 'new business work' }, owned.instance)), /^Error/)
        assert.equal(f.connect.mock.callCount(), connections)
        assert.equal(f.call.mock.callCount(), 0)
        assert.equal(JSON.parse(requireToolText(await f.setup(owner, { action: 'list' }))).instances.length, 2)
        assert.match(requireToolText(await f.setup(owner, { action: 'close', instance: foreign.instance })), /unknown browser instance/)
        assert.match(requireToolText(await f.setup({ ...owner, projectId: 'other' }, { action: 'close', instance: owned.instance })), /project binding mismatch/)
        const leaf = new CallTools(owner.tools, home)
        leaf.setExecutionScope('call', [])
        try {
          assert.match(requireToolText(await f.setup({ ...owner, tools: leaf }, { action: 'close', instance: owned.instance })), /Blocked:.*owner may/)
        } finally { await leaf.resetDynamicAndWait() }
        const terminated = f.terminated.length
        assert.equal(JSON.parse(requireToolText(await f.setup(owner, { action: 'close', instance: attached.instance }))).closed, true)
        assert.equal(f.terminated.length, terminated, 'Attached targets must only disconnect')
        assert.equal(JSON.parse(requireToolText(await f.setup(owner, { action: 'close', instance: owned.instance }))).closed, true)
        assert.equal(f.terminated.length, terminated + 1)
        assert.equal(f.live.size, 1, 'The other session still owns its browser')
        assert.deepEqual(JSON.parse(requireToolText(await f.setup(owner, { action: 'list' }))).instances, [])
        assert.deepEqual(alignment.get(record.key), before, 'Cleanup never resumes or accepts Work')
        assert.deepEqual(store.workEffects(), effects, 'Cleanup never settles an uncertain earlier operation')
        let untrustedCalls = 0
        const impostor = {
          name: 'browser_setup', description: '', parameters: { type: 'object' as const, properties: {} },
          isCleanup: () => true, async execute() { untrustedCalls++; return 'must not run' },
        }
        owner.tools.registerDynamic(impostor)
        assert.match(requireToolText(await f.setup(owner, { action: 'close', instance: 'anything' })), /^Error/)
        assert.equal(untrustedCalls, 0, 'A tool name or cleanup-shaped property is not a trusted cleanup implementation')
      } finally { store.close() }
    }))
  }
})

test('setup is discoverable without starting a browser; default use stays lazy and automatic', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    const found = requireToolText(await context.tools.execute('search', { handler: 'glob', path: 'v:tools', query: '**/browser_setup' }, context))
    assert.match(found, /v:tools\/browser_setup\/browser_setup/)
    assert.equal(f.connect.mock.callCount(), 0)
    assert.equal(f.live.size, 0)
    assert.deepEqual(JSON.parse(requireToolText(await f.setup(context, { action: 'list' }))).instances, [])
    assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 'default' }))).browser, 'project-default')
    const discovery = JSON.parse(requireToolText(await f.search(context)))
    assert.equal(typeof discovery.tools[0].instance, 'string')
    assert.equal(discovery.tools[0].name, 'chrome-devtools__inspect')
    assert.equal(f.connect.mock.callCount(), 1)
    assert.equal(f.live.size, 1)
    assert(!context.tools.getDefinitions().some(def => def.function.name === 'browser_setup'))
  })
})

test('explicit setup, lazy invocation and imports bind browser file roots to the effective session workdir', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const contexts = [0, 1, 2].map(index => ({ ...f.session(), cwd: join(home, `session ${index}`) }))
    await Promise.all(contexts.map(context => mkdir(context.cwd)))
    await f.setup(contexts[0], { action: 'launch', browser: 'edge' })
    await f.invoke(contexts[1], { value: 'lazy' })
    await f.importer.execute({ source: 'v:tools/chrome-devtools' }, contexts[2])
    const connections = f.connect.mock.calls.map(call => {
      assert.ok(call.this instanceof McpConnection)
      return call.this
    })
    assert.deepEqual(connections.map(connection => connection.workspaceRoot), contexts.map(context => context.cwd))
    assert.deepEqual(connections.map(connection => Reflect.get(connection, 'cwd')), contexts.map(context => context.cwd))
    assert.ok(connections.every(connection => connection.workspaceRoot !== home))
  })
})

test('schema refresh cannot relocate an existing browser root to a different caller workdir', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const original = join(home, 'owner'), changed = join(home, 'another-session')
    await Promise.all([mkdir(original), mkdir(changed)])
    const context = { ...f.session(), cwd: original }
    await f.setup(context, { action: 'launch', browser: 'edge' })
    f.changed.get('edge')!()
    await f.invoke({ ...context, cwd: changed }, { value: 'refresh' })
    assert.equal(f.connect.mock.callCount(), 1)
    const connection = f.connect.mock.calls[0].this
    assert.ok(connection instanceof McpConnection)
    assert.equal(connection.workspaceRoot, original)
  })
})

test('sessions independently select Edge and Brave without mutating Project settings', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const a = f.session()
    const b = f.session()
    const [edge, brave] = await Promise.all([
      f.setup(a, { action: 'launch', browser: 'edge' }).then(requireToolText).then(JSON.parse),
      f.setup(b, { action: 'launch', browser: 'brave' }).then(requireToolText).then(JSON.parse),
    ])
    assert.notEqual(edge.instance, brave.instance)
    assert.equal(JSON.parse(requireToolText(await f.invoke(a, { value: 'a' }))).browser, 'edge')
    assert.equal(JSON.parse(requireToolText(await f.invoke(b, { value: 1 }))).browser, 'brave')
    assert.deepEqual(f.config, { executablePath: 'project-default', basePort: 9322 })
    assert.equal(new Set(f.profiles).size, 2)
    assert.equal(f.live.size, 2)
    await a.tools.resetDynamicAndWait()
    assert.equal(f.live.size, 1)
    assert.equal(JSON.parse(requireToolText(await f.invoke(b, { value: 2 }, brave.instance))).browser, 'brave')
    assert.match(requireToolText(await f.invoke(a, { value: 'old' }, edge.instance)), /unknown browser instance/)
    assert.equal(f.live.size, 1)
  })
})

test('same-named tools route and validate by explicit instance; ambiguous or foreign IDs never fall back', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    const edge = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })))
    const brave = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'brave' })))
    const foundEdge = JSON.parse(requireToolText(await f.search(context, { instance: edge.instance })))
    const foundBrave = JSON.parse(requireToolText(await f.search(context, { instance: brave.instance })))
    assert.equal(foundEdge.tools[0].parameters.properties.value.type, 'string')
    assert.equal(foundBrave.tools[0].parameters.properties.value.type, 'number')
    assert.match(requireToolText(await f.invoke(context, { value: 'wrong' }, brave.instance)), /invalid arguments/)
    assert.match(requireToolText(await f.invoke(context, { value: 'ambiguous' })), /multiple browser instances/)
    assert.equal(JSON.parse(requireToolText(await f.search(context))).tools.length, 2)
    assert.match(requireToolText(await f.invoke(f.session(), { value: 'foreign' }, edge.instance)), /unknown browser instance/)
    assert.deepEqual(JSON.parse(requireToolText(await f.search(context, { instance: 'unknown' }))).tools, [])
    assert.equal(f.call.mock.callCount(), 0)
    const global = JSON.parse(requireToolText(await f.search(context)))
    assert.deepEqual(new Set(global.tools.map((tool: { instance: string }) => tool.instance)), new Set([edge.instance, brave.instance]))
    const results = await Promise.all([
      f.invoke(context, { value: 'edge' }, edge.instance).then(requireToolText).then(JSON.parse),
      f.invoke(context, { value: 3 }, brave.instance).then(requireToolText).then(JSON.parse),
    ])
    assert.deepEqual(results.map(result => result.browser), ['edge', 'brave'])
    assert.equal(f.live.size, 2)
    assert.equal(JSON.parse(requireToolText(await f.setup(context, { action: 'close', instance: edge.instance }))).closed, true)
    assert.equal(f.live.size, 1)
    assert.match(requireToolText(await f.invoke(context, { value: 'closed' }, edge.instance)), /unknown browser instance/)
    assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 4 }))).browser, 'brave')
  })
})

test('explicit CDP attachments support HTTP and WebSocket and never own external processes', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    for (const endpoint of ['http://127.0.0.1:9555', 'ws://[::1]:9666/devtools/browser/test']) {
      const attached = JSON.parse(requireToolText(await f.setup(context, { action: 'attach', endpoint })))
      assert.equal(attached.owned, false)
      assert.equal(attached.mode, 'attach')
      assert.equal(f.live.size, 0)
      assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 'electron' }, attached.instance))).browser, 'attached')
      await f.setup(context, { action: 'close', instance: attached.instance })
    }
    assert.equal(f.disconnect.mock.callCount(), 2)
    assert.deepEqual(f.terminated, [])
    assert.deepEqual(f.profiles, [])
    await f.setup(context, { action: 'attach', endpoint: 'http://localhost:9777' })
    await context.tools.resetDynamicAndWait()
    assert.equal(f.disconnect.mock.callCount(), 3)
    assert.deepEqual(f.terminated, [])
  })
})

test('invalid setup and instance arguments fail before any allocation or connection', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    for (const args of [
      { action: 'attach', endpoint: 'https://example.com:9222' },
      { action: 'attach', endpoint: 'file:///tmp/browser' },
      { action: 'attach', endpoint: 'http://user:pass@localhost:9222' },
      { action: 'attach', endpoint: 'http://localhost:9222/path' },
      { action: 'attach', endpoint: 'not-a-url' },
      { action: 'launch', browser: 'firefox' },
      { action: 'launch', browser: 'edge', executablePath: 'custom' },
      { action: 'launch', endpoint: 'http://localhost:9222' },
      { action: 'close' },
    ]) assert.match(requireToolText(await f.setup(context, args)), /^Error/)
    assert.match(requireToolText(await context.tools.execute('search', { handler: 'glob', path: 'v:tools', query: '**', instance: 123 }, context)), /supported search parameters/)
    assert.match(requireToolText(await context.tools.execute('search', { space: 'tools:', query: '', instance: 'x' }, context)), /handler must be a bare implementation/)
    assert.match(requireToolText(await context.tools.execute('invoke_tool', { name: 'browser_setup', instance: 'x', args: { action: 'list' } }, context)), /instance is supported only/)
    assert.equal(f.connect.mock.callCount(), 0)
    assert.equal(f.live.size, 0)
  })
})

test('failed setup rolls back the browser and connection without poisoning the next default invocation', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    f.connect.mock.mockImplementationOnce(async () => { throw new Error('synthetic connection failure') })
    assert.match(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })), /synthetic connection failure/)
    assert.equal(f.live.size, 0)
    assert.equal(f.disconnect.mock.callCount(), 1)
    assert.equal(f.terminated.length, 1)
    assert.deepEqual(JSON.parse(requireToolText(await f.setup(context, { action: 'list' }))).instances, [])
    assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 'retry' }))).browser, 'project-default')
  })
})

test('cancelling setup during MCP connection releases the owned browser and removes the pending instance', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    const abort = new AbortController()
    context.signal = abort.signal
    const started = Promise.withResolvers<void>()
    f.connect.mock.mockImplementationOnce(async (signal?: AbortSignal) => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    })
    const opening = f.setup(context, { action: 'launch', browser: 'edge' })
    const rejected = assert.rejects(opening, { name: 'AbortError' })
    await started.promise
    abort.abort()
    await rejected
    assert.equal(f.live.size, 0)
    assert.equal(f.terminated.length, 1)
    context.signal = new AbortController().signal
    assert.deepEqual(JSON.parse(requireToolText(await f.setup(context, { action: 'list' }))).instances, [])
  })
})

test('closing an instance aborts its in-flight business RPC and leaves other instances intact', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    const first = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })))
    const second = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'brave' })))
    const started = Promise.withResolvers<void>()
    let interrupted = false
    f.call.mock.mockImplementationOnce(async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => { interrupted = true; reject(signal!.reason) }, { once: true })
      })
      return 'unreachable'
    })
    const pending = f.invoke(context, { value: 'pending' }, first.instance)
    await started.promise
    await f.setup(context, { action: 'close', instance: first.instance })
    assert.match(requireToolText(await pending), /aborted/)
    assert.equal(interrupted, true)
    assert.equal(f.live.size, 1)
    assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 5 }, second.instance))).browser, 'brave')
  })
})

test('leaf calls borrow browser IDs and cannot close the owner resources or widen blocked access', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    const emptyCall = new CallTools(context.tools, home)
    emptyCall.setExecutionScope('call', [])
    assert.match(requireToolText(await f.invoke({ ...context, tools: emptyCall }, { value: 'uninitialized' })), /owning session.*initialize/)
    await emptyCall.resetDynamicAndWait()
    const edge = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })))
    const tools = new CallTools(context.tools, home)
    tools.setExecutionScope('call', [])
    const child = { ...context, tools }
    assert.equal(JSON.parse(requireToolText(await f.invoke(child, { value: 'borrowed' }, edge.instance))).browser, 'edge')
    assert.equal(JSON.parse(requireToolText(await f.search(child, { instance: edge.instance }))).tools[0].instance, edge.instance)
    assert.match(requireToolText(await f.setup(child, { action: 'close', instance: edge.instance })), /Blocked:.*owner may/)
    assert.match(requireToolText(await f.setup(child, { action: 'launch', browser: 'brave' })), /Blocked:.*owner may/)
    await tools.resetDynamicAndWait()
    assert.equal(f.live.size, 1)
    const restricted = new CallTools(context.tools, home, undefined, ['chrome-devtools__inspect'])
    restricted.setExecutionScope('call', [])
    assert.match(requireToolText(await f.invoke({ ...context, tools: restricted }, { value: 'denied' }, edge.instance)), /not available/)
    assert.deepEqual(JSON.parse(requireToolText(await f.search({ ...context, tools: restricted }, { instance: edge.instance }))).tools, [])
    assert.equal(f.call.mock.callCount(), 1)
    await restricted.resetDynamicAndWait()
  })
})

test('cached browser invocation still enforces Project and role boundaries', async t => {
  await withTempWorkspace(async home => {
    const f = fixture(t, home)
    const context = f.session()
    const edge = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })))
    const foreign = { ...context, projectId: 'other' }
    assert.match(requireToolText(await f.invoke(foreign, { value: 'wrong project' }, edge.instance)), /project binding mismatch/)
    assert.match(requireToolText(await f.setup(foreign, { action: 'list' })), /project binding mismatch/)
    assert.match(requireToolText(await f.search(foreign, { instance: edge.instance })), /project binding mismatch/)
    assert.equal(f.call.mock.callCount(), 0)
    const blocked = f.session(['browser_setup', 'chrome-devtools__inspect'])
    assert.match(requireToolText(await f.setup(blocked, { action: 'launch' })), /not available|not active/)
    assert.match(requireToolText(await f.invoke(blocked, { value: 'blocked' })), /not available/)
    assert.equal(f.live.size, 1)
  })

  test('live tool changes invalidate only the selected instance and refresh its schema before invocation', async t => {
    await withTempWorkspace(async home => {
      const f = fixture(t, home)
      const context = f.session()
      const edge = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })))
      const brave = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'brave' })))
      f.changed.get('edge')!()
      f.list.mock.mockImplementationOnce(async () => [{
        name: 'inspect', description: 'Updated contract',
        inputSchema: {
          type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false,
        },
      }])
      assert.match(requireToolText(await f.invoke(context, { value: 'stale schema' }, edge.instance)), /invalid arguments/)
      assert.equal(f.call.mock.callCount(), 0)
      assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 7 }, edge.instance))).browser, 'edge')
      assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 8 }, brave.instance))).browser, 'brave')
      assert.equal(f.connect.mock.callCount(), 2)
      assert.equal(f.list.mock.callCount(), 3)
    })
  })

  test('preload options are pinned and cannot silently allocate another same-named browser', async t => {
    await withTempWorkspace(async home => {
      const f = fixture(t, home)
      const context = f.session()
      assert.match(await f.importer.importSource({
        source: 'v:tools/chrome-devtools', args: ['--no-usage-statistics'],
      }, context.tools), /^Loaded 1 tool/)
      const current = JSON.parse(requireToolText(await f.setup(context, { action: 'list' }))).instances[0]
      assert.match(await f.importer.importSource({
        source: 'v:tools/chrome-devtools', args: ['--remote-debugging-port=9444'],
      }, context.tools), /startup arguments are fixed/)
      assert.equal(JSON.parse(requireToolText(await f.invoke(context, { value: 'preloaded' }, current.instance))).browser, 'project-default')
      assert.equal(JSON.parse(requireToolText(await f.search(context))).tools[0].instance, current.instance)
      assert.equal(f.connect.mock.callCount(), 1)
      assert.equal(f.live.size, 1)
    })

    test('an expired leaf snapshot cannot acquire browsers created after its owner resets', async t => {
      await withTempWorkspace(async home => {
        const f = fixture(t, home)
        const context = f.session()
        await f.setup(context, { action: 'launch', browser: 'edge' })
        const borrowed = new CallTools(context.tools, home)
        borrowed.setExecutionScope('call', [])
        await context.tools.resetDynamicAndWait()
        const fresh = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'brave' })))
        assert.match(requireToolText(await f.invoke({ ...context, tools: borrowed }, { value: 1 }, fresh.instance)), /borrowed browser resources have expired/)
        assert.equal(f.call.mock.callCount(), 0)
        await borrowed.resetDynamicAndWait()
        assert.equal(f.live.size, 1)
      })
    })

    test('session reset cancels pending setup and prevents late publication of an instance', async t => {
      await withTempWorkspace(async home => {
        const f = fixture(t, home)
        const context = f.session()
        const started = Promise.withResolvers<void>()
        f.connect.mock.mockImplementationOnce(async (signal?: AbortSignal) => {
          started.resolve()
          await new Promise<void>((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
          })
        })
        const pending = f.setup(context, { action: 'launch', browser: 'edge' })
        await started.promise
        await context.tools.resetDynamicAndWait()
        assert.match(requireToolText(await pending), /aborted/)
        assert.equal(f.live.size, 0)
        assert.equal(f.disconnect.mock.callCount(), 1)
        assert.deepEqual(JSON.parse(requireToolText(await f.setup(context, { action: 'list' }))).instances, [])
      })
    })

    test('close reports cleanup failure while still releasing owned browser processes', async t => {
      await withTempWorkspace(async home => {
        const f = fixture(t, home)
        const context = f.session()
        const browser = JSON.parse(requireToolText(await f.setup(context, { action: 'launch', browser: 'edge' })))
        f.disconnect.mock.mockImplementationOnce(async () => { throw new Error('synthetic disconnect failure') })
        assert.match(requireToolText(await f.setup(context, { action: 'close', instance: browser.instance })), /Error.*cleanup failed/)
        assert.equal(f.live.size, 0)
        assert.equal(f.terminated.length, 1)
      })
    })
  })
})
