import { requireToolText } from './tool.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { WorkTool } from './work.ts'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { McpConnection } from '../mcp/client.ts'
import { CallTools } from '../sessions/call-tools.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { SearchTool } from './search.ts'
import { BrowserSetupTool } from './browser-setup.ts'
import { CHROME_MCP_PACKAGE } from '../browser/chrome-contract.ts'
import { attachmentTarget } from '../browser/session-browsers.ts'
import { SharedChrome } from '../browser/shared-chrome.ts'
import { join } from 'node:path'
import { ChromeToolSchema } from '../config/schema.ts'

function fixture(t: TestContext, home: string) {
  t.mock.method(BrowserSetupTool.prototype, 'discover', async () => []) // never inspect real profiles in tests
  const importer = new ImportTool(new Map<string, LoadableEntry>([['chrome-devtools', {
    config: { name: 'chrome-devtools', transport: 'stdio', command: 'npx', args: [CHROME_MCP_PACKAGE] },
  }]]), home, 'project')
  const base = new Tools(home)
  base.register(new InvokeTool(importer))
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  const disconnect = t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', () => {})
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => [
    { name: 'list_pages', description: '', inputSchema: { type: 'object', properties: {} } },
    { name: 'select_page', description: '', inputSchema: { type: 'object', properties: { pageId: { type: 'number' } }, required: ['pageId'] } },
    { name: 'evaluate_script', description: '', inputSchema: { type: 'object', properties: { pageId: { type: 'number' }, function: { type: 'string' } }, required: ['pageId', 'function'] } },
  ])
  const pages = new Map([[1, 'A'], [2, 'B']])
  const call = t.mock.method(McpConnection.prototype, 'callTool', async (_name: string, args: Record<string, unknown>) => {
    if (_name === 'list_pages') return '1: A\n2: B'
    if (!pages.has(args.pageId as number)) throw new Error('Unknown pageId')
    await Promise.resolve()
    return pages.get(args.pageId as number)!
  })
  const sessions: SessionTools[] = []
  const session = (blocked?: string[]) => {
    const tools = new SessionTools(base, home, undefined, blocked)
    sessions.push(tools)
    return { tools, projectId: 'project', sessionId: crypto.randomUUID(), signal: new AbortController().signal } as ExecutionContext
  }
  t.after(async () => { for (const tools of sessions) await tools.resetDynamicAndWait() })
  const setup = (ctx: ExecutionContext, args: Record<string, unknown>) => ctx.tools.execute('invoke_tool', { name: 'browser_setup', args }, ctx)
  const invoke = (ctx: ExecutionContext, args: Record<string, unknown>, instance?: string, name = 'evaluate_script') =>
    ctx.tools.execute('invoke_tool', { name: `chrome-devtools__${name}`, args, instance }, ctx)
  return { base, importer, connect, disconnect, list, call, session, setup, invoke }
}

test('discovery and absent binding never connect; removed launch and legacy settings fail', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  assert.match(String(await f.setup(ctx, { action: 'discover' })), /Chrome 144\+/)
  assert.match(String(await f.invoke(ctx, { pageId: 1, function: '() => 1' })), /no browser binding/)
  assert.match(String(await f.setup(ctx, { action: 'launch' })), /invalid (?:browser_setup )?arguments/)
  assert.equal(f.connect.mock.callCount(), 0)
  for (const config of [{ slotCount: 3 }, { basePort: 9222 }, { executablePath: 'browser' }]) assert.equal(ChromeToolSchema.safeParse(config).success, false)
}))

test('explicit binding, page interleaving, select hidden and invalid IDs never fallback', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  const receipt = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://127.0.0.1:9555' })))
  assert.equal(receipt.owned, false)
  assert.match(receipt.scope, /not profile isolation/)
  const config = (f.connect.mock.calls[0].this as McpConnection).config
  assert.deepEqual(config.args, [CHROME_MCP_PACKAGE, '--page-id-routing', '--browserUrl=http://127.0.0.1:9555/'])
  assert.match(String(await f.invoke(ctx, { function: '() => 1' })), /pageId/)
  assert.equal(f.call.mock.callCount(), 0)
  assert.match(String(await f.invoke(ctx, { pageId: 1 }, receipt.instance, 'select_page')), /not advertised|not found|unavailable|Unknown|not available/)
  assert.equal(f.call.mock.callCount(), 0)
  assert.deepEqual(await Promise.all([1, 2, 1, 2].map(pageId => f.invoke(ctx, { pageId, function: '() => 1' }))), ['A', 'B', 'A', 'B'])
  const bad = await f.invoke(ctx, { pageId: 999, function: '() => 1' })
  assert.match(String(bad), /Unknown pageId/)
  assert.equal(f.call.mock.calls.at(-1)!.arguments[1].pageId, 999)
  assert.equal(f.connect.mock.callCount(), 1)
}))

test('bindings are owner-local, explicit when multiple, forgotten on reset; disconnect only closes MCP', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session(), peer = f.session()
  const first = JSON.parse(String(await f.setup(ctx, { action: 'autoConnect', channel: 'stable' })))
  const second = JSON.parse(String(await f.setup(ctx, { action: 'autoConnect', channel: 'canary', userDataDir: home })))
  assert.deepEqual((f.connect.mock.calls[1].this as McpConnection).config.args, [CHROME_MCP_PACKAGE, '--page-id-routing', '--auto-connect', '--channel=canary', `--user-data-dir=${home}`])
  assert.match(String(await f.invoke(ctx, { pageId: 1, function: '() => 1' })), /multiple browser/)
  assert.equal(await f.invoke(ctx, { pageId: 2, function: '() => 1' }, second.instance), 'B')
  assert.match(String(await f.setup(peer, { action: 'close', instance: first.instance })), /unknown browser instance/)
  const leaf = new CallTools(ctx.tools, home)
  leaf.setExecutionScope('call', [])
  assert.match(String(await f.setup({ ...ctx, tools: leaf }, { action: 'attach', endpoint: 'http://localhost:9555' })), /only their owner/)
  await f.setup(ctx, { action: 'close', instance: first.instance })
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.equal(JSON.parse(String(await f.setup(ctx, { action: 'list' }))).instances.length, 1)
  await ctx.tools.resetDynamicAndWait()
  assert.equal(f.disconnect.mock.callCount(), 2)
  assert.deepEqual(JSON.parse(String(await f.setup(ctx, { action: 'list' }))).instances, [])
  assert.match(String(await f.invoke(ctx, { pageId: 1, function: '() => 1' })), /no browser binding/)
  assert.equal(f.connect.mock.callCount(), 2)
}))

test('incompatible live page schemas fail connection import and are disconnected', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  f.list.mock.mockImplementation(async () => [{ name: 'evaluate_script', description: '', inputSchema: { type: 'object', properties: {} } }])
  assert.match(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })), /required pageId is missing/)
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.deepEqual(JSON.parse(String(await f.setup(ctx, { action: 'list' }))).instances, [])
}))

test('connection URLs and cleanup admission are strict', () => {
  for (const endpoint of ['http://example.com:9222', 'http://user@localhost:9222', 'http://localhost:9222/path', 'http://localhost:9222/#x']) assert.throws(() => attachmentTarget(endpoint))
  assert.equal(attachmentTarget('ws://127.0.0.1:9222/devtools/browser/id').mode, 'attach')
  const setup = new BrowserSetupTool(async () => 'unused')
  assert.equal(setup.workAdmission({ action: 'close', instance: 'id' }), 'cleanup')
  assert.equal(setup.workAdmission({ action: 'close', instance: 'id', endpoint: 'x' }), undefined)
  assert.equal(setup.readonly({ action: 'discover' }), true)
})


test('owner-scoped cleanup does not mutate shared Work notes in any state', async t => {
  for (const state of ['blocked', 'paused', 'done', 'cancelled', 'stale', 'unknown'] as const) {
    await t.test(state, async t => withTempWorkspace(async home => {
      const f = fixture(t, home)
      const owner = f.session(), peer = f.session()
      const owned = JSON.parse(requireToolText(await f.setup(owner, { action: 'autoConnect', channel: 'stable' })))
      const attached = JSON.parse(requireToolText(await f.setup(owner, { action: 'attach', endpoint: 'http://127.0.0.1:9555' })))
      const foreign = JSON.parse(requireToolText(await f.setup(peer, { action: 'autoConnect', channel: 'canary' })))
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
        // WorkAlignment.before is intentionally non-gating: Work is a shared notebook.
        // Permission/lifecycle boundaries below remain enforced independently.
        assert.equal(JSON.parse(requireToolText(await f.setup(owner, { action: 'list' }))).instances.length, 2)
        assert.match(requireToolText(await f.setup(owner, { action: 'close', instance: foreign.instance })), /unknown browser instance/)
        assert.match(requireToolText(await f.setup({ ...owner, projectId: 'other' }, { action: 'close', instance: owned.instance })), /project binding mismatch/)
        const leaf = new CallTools(owner.tools, home)
        leaf.setExecutionScope('call', [])
        try {
          assert.match(requireToolText(await f.setup({ ...owner, tools: leaf }, { action: 'close', instance: owned.instance })), /Blocked:.*owner may/)
        } finally { await leaf.resetDynamicAndWait() }
        const disconnected = f.disconnect.mock.callCount()
        assert.equal(JSON.parse(requireToolText(await f.setup(owner, { action: 'close', instance: attached.instance }))).closed, true)
        assert.equal(f.disconnect.mock.callCount(), disconnected + 1)
        assert.equal(JSON.parse(requireToolText(await f.setup(owner, { action: 'close', instance: owned.instance }))).closed, true)
        assert.equal(f.disconnect.mock.callCount(), disconnected + 2)
        assert.equal(JSON.parse(requireToolText(await f.setup(peer, { action: 'list' }))).instances.length, 1)
        assert.deepEqual(JSON.parse(requireToolText(await f.setup(owner, { action: 'list' }))).instances, [])
        assert.deepEqual(alignment.get(record.key), before, 'Cleanup never resumes or accepts Work')
        assert.deepEqual(store.workEffects(), effects, 'Cleanup never settles an uncertain earlier operation')
      } finally { store.close() }
    }))
  }
})


test('leaf borrow, blocked tools, foreign projects and expired snapshots cannot widen access', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  const receipt = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })))
  const leaf = new CallTools(ctx.tools, home)
  leaf.setExecutionScope('call', [])
  assert.equal(await f.invoke({ ...ctx, tools: leaf }, { pageId: 1, function: '() => 1' }, receipt.instance), 'A')
  const restricted = new CallTools(ctx.tools, home, undefined, ['chrome-devtools__evaluate_script'])
  restricted.setExecutionScope('call', [])
  assert.match(String(await f.invoke({ ...ctx, tools: restricted }, { pageId: 1, function: '() => 1' }, receipt.instance)), /not available/)
  assert.match(String(await f.invoke({ ...ctx, projectId: 'foreign' }, { pageId: 1, function: '() => 1' }, receipt.instance)), /project binding mismatch/)
  const blocked = f.session(['browser_setup', 'chrome-devtools__evaluate_script'])
  assert.match(String(await f.setup(blocked, { action: 'autoConnect', channel: 'stable' })), /not available|not active/)
  assert.equal(f.call.mock.callCount(), 1)
  await restricted.resetDynamicAndWait()
  assert.equal(f.disconnect.mock.callCount(), 0)
  await ctx.tools.resetDynamicAndWait()
  const fresh = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9666' })))
  assert.match(String(await f.invoke({ ...ctx, tools: leaf }, { pageId: 1, function: '() => 1' }, fresh.instance)), /expired/)
  await leaf.resetDynamicAndWait()
  assert.equal(f.disconnect.mock.callCount(), 1)
}))

for (const cancellation of ['request', 'reset'] as const) test(`${cancellation} cancellation prevents late binding publication`, async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session(), controller = new AbortController()
  const started = Promise.withResolvers<void>()
  f.connect.mock.mockImplementationOnce(async (signal?: AbortSignal) => {
    started.resolve()
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  })
  const pending = f.setup({ ...ctx, signal: controller.signal }, { action: 'attach', endpoint: 'http://localhost:9555' })
  await started.promise
  if (cancellation === 'request') controller.abort()
  else await ctx.tools.resetDynamicAndWait()
  assert.match(String(await pending), /abort/i)
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.deepEqual(JSON.parse(String(await f.setup(ctx, { action: 'list' }))).instances, [])
  assert.ok(JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' }))).instance)
}))

test('closing a binding aborts its pending RPC without affecting a peer binding', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  const first = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })))
  const second = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9666' })))
  const started = Promise.withResolvers<void>()
  f.call.mock.mockImplementationOnce(async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
    started.resolve()
    return await new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  })
  const pending = f.invoke(ctx, { pageId: 1, function: '() => 1' }, first.instance)
  await started.promise
  await f.setup(ctx, { action: 'close', instance: first.instance })
  assert.match(String(await pending), /abort/i)
  assert.equal(await f.invoke(ctx, { pageId: 2, function: '() => 1' }, second.instance), 'B')
  assert.equal(f.disconnect.mock.callCount(), 1)
}))

test('disconnect failure is reported and never leaves a callable binding', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  const receipt = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })))
  f.disconnect.mock.mockImplementationOnce(async () => { throw new Error('synthetic disconnect failure') })
  assert.match(String(await f.setup(ctx, { action: 'close', instance: receipt.instance })), /Error.*cleanup failed/)
  assert.match(String(await f.invoke(ctx, { pageId: 1, function: '() => 1' }, receipt.instance)), /unknown browser instance/)
  assert.equal(f.call.mock.callCount(), 0)
}))

test('private app handoff uses the explicit binding, routes pageId and redacts credentials', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  const identity = { id: crypto.randomUUID(), revision: 'a'.repeat(64) }
  await assert.rejects(f.importer.openApp(ctx, identity, async () => { assert.fail('No app launch without a browser binding') }), /no browser binding/)
  f.list.mock.mockImplementation(async () => [
    { name: 'new_page', description: '', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'close_page', description: '', inputSchema: { type: 'object', properties: { pageId: { type: 'number' } }, required: ['pageId'] } },
    { name: 'evaluate_script', description: '', inputSchema: { type: 'object', properties: { function: { type: 'string' }, pageId: { type: 'number' } }, required: ['function', 'pageId'] } },
  ])
  await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })
  const secret = 'never-disclose-ticket'
  f.call.mock.mockImplementation(async (name: string) => name === 'new_page' ? '## Pages\n7: http://127.0.0.1:1234/ [selected]' : '{"connected":true}')
  const receipt = await f.importer.openApp(ctx, identity, async () => ({ url: `http://127.0.0.1:1234/#shadow_ticket=${secret}` }))
  assert.equal(receipt.owned, false)
  assert.equal(receipt.pageId, 7)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret))
  assert.equal(f.call.mock.calls.at(-1)!.arguments[1].pageId, 7)
  f.call.mock.mockImplementation(async () => { throw new Error(secret) })
  await assert.rejects(f.importer.openApp(ctx, identity, async () => ({ url: `http://127.0.0.1:1234/#shadow_ticket=${secret}` })), error => error instanceof Error && !error.message.includes(secret) && /private app navigation/.test(error.message))
  assert.equal(f.disconnect.mock.callCount(), 0)
  assert.equal(JSON.parse(String(await f.setup(ctx, { action: 'list' }))).instances[0].instance, receipt.instance)
  f.call.mock.mockImplementation(async (name: string) => {
    if (name === 'new_page') return '## Pages\n8: http://127.0.0.1:1234/ [selected]'
    if (name === 'close_page') return 'Closed page'
    throw new Error(`SDK failed: ${secret}`)
  })
  await assert.rejects(f.importer.openApp(ctx, identity, async () => ({ url: `http://127.0.0.1:1234/#shadow_ticket=${secret}` })), error => error instanceof Error && !error.message.includes(secret) && /SDK handshake/.test(error.message))
  assert.equal(f.disconnect.mock.callCount(), 0)
  assert.equal(f.call.mock.calls.at(-1)!.arguments[0], 'close_page')
  assert.deepEqual(f.call.mock.calls.at(-1)!.arguments[1], { pageId: 8 })
  f.call.mock.mockImplementation(async (_name: string, args: Record<string, unknown>) => `unrelated page ${args.pageId}`)
  assert.equal(await f.invoke(ctx, { pageId: 2, function: '() => 1' }, receipt.instance), 'unrelated page 2')
  assert.equal(f.connect.mock.callCount(), 1)
}))

test('live schema invalidation stays instance-local and preserves the effective file root', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = { ...f.session(), cwd: home }
  const changed = new Map<McpConnection, () => void>()
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', function (this: McpConnection, handler: () => void) { changed.set(this, handler) })
  const first = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })))
  const second = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9666' })))
  const connection = f.connect.mock.calls[0].this as McpConnection
  assert.equal(connection.workspaceRoot, home)
  changed.get(connection)!()
  f.list.mock.mockImplementationOnce(async () => [{ name: 'evaluate_script', description: 'changed', inputSchema: {
    type: 'object', properties: { pageId: { type: 'integer' }, function: { type: 'string' }, marker: { type: 'string' } }, required: ['pageId', 'function', 'marker'],
  } }])
  assert.match(String(await f.invoke({ ...ctx, cwd: `${home}/different` }, { pageId: 1, function: '() => 1' }, first.instance)), /invalid arguments/)
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(await f.invoke(ctx, { pageId: 1, function: '() => 1', marker: 'new' }, first.instance), 'A')
  assert.equal(await f.invoke(ctx, { pageId: 2, function: '() => 1' }, second.instance), 'B')
  assert.equal(connection.workspaceRoot, home)
  assert.equal(f.connect.mock.callCount(), 2)
  assert.equal(f.list.mock.callCount(), 3)
}))

test('binding discovery remains offline and never advertises select_page', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session()
  f.base.register(new SearchTool(home))
  const before = await f.importer.virtualEntries(ctx)
  assert.ok(before)
  assert.equal(f.connect.mock.callCount(), 0)
  await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })
  const entries = await f.importer.virtualEntries(ctx)
  assert.doesNotMatch(JSON.stringify(entries), /select_page/)
  assert.match(JSON.stringify(entries), /evaluate_script/)
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 0)
}))

for (const cleanup of ['denied', 'failed'] as const) test(`app page cleanup ${cleanup} never disconnects the shared binding`, async t => withTempWorkspace(async home => {
  const f = fixture(t, home), ctx = f.session(cleanup === 'denied' ? ['chrome-devtools__close_page'] : undefined)
  f.list.mock.mockImplementation(async () => [
    { name: 'new_page', description: '', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'evaluate_script', description: '', inputSchema: { type: 'object', properties: { pageId: { type: 'number' }, function: { type: 'string' } }, required: ['pageId', 'function'] } },
    { name: 'close_page', description: '', inputSchema: { type: 'object', properties: { pageId: { type: 'number' } }, required: ['pageId'] } },
  ])
  const receipt = JSON.parse(String(await f.setup(ctx, { action: 'attach', endpoint: 'http://localhost:9555' })))
  f.call.mock.mockImplementation(async (name: string) => {
    if (name === 'new_page') return '## Pages\n8: http://127.0.0.1:1234/ [selected]'
    throw new Error('private-ticket-never-disclose')
  })
  await assert.rejects(f.importer.openApp(ctx, { id: 'test', revision: 'a'.repeat(64) }, async () => ({ url: 'http://127.0.0.1:1234/#private-ticket-never-disclose' })), error => error instanceof Error && /SDK handshake/.test(error.message) && !error.message.includes('private-ticket-never-disclose'))
  const closeCalls = f.call.mock.calls.filter(call => call.arguments[0] === 'close_page')
  assert.equal(closeCalls.length, cleanup === 'denied' ? 0 : 1)
  if (closeCalls.length) assert.deepEqual(closeCalls[0].arguments[1], { pageId: 8 })
  assert.equal(f.disconnect.mock.callCount(), 0)
  f.call.mock.mockImplementation(async () => 'unrelated page is accessible')
  assert.equal(await f.invoke(ctx, { pageId: 2, function: '() => 1' }, receipt.instance), 'unrelated page is accessible')
}))

test('managed shared endpoint keeps session registries, permissions, binding IDs and cleanup independent', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), owner = f.session(), peer = f.session()
  const ensure = t.mock.method(SharedChrome.prototype, 'ensure', async () => 'ws://127.0.0.1:9555/devtools/browser/shared')
  const shutdown = t.mock.method(SharedChrome.prototype, 'shutdown', async () => {})
  const report = { status: 'ready_with_warnings' as const, copiedFiles: 0, absent: [], warnings: [{ stage: 'open-source', item: 'Local State', code: 'SOURCE_READ_FAILED', osCode: 'EBUSY' }], loginData: 'not_migrated' as const, message: 'No login data was migrated.' }
  t.mock.method(SharedChrome.prototype, 'copyReport', () => structuredClone(report))
  const args = { action: 'managed', browser: 'chrome', executablePath: join(home, 'synthetic-chrome'), userDataDir: join(home, 'synthetic-source'), profileDirectory: 'Default' }
  const [first, second] = await Promise.all([f.setup(owner, args), f.setup(peer, args)]).then(values => values.map(value => JSON.parse(String(value))))
  assert.deepEqual(first.copyReport, report)
  assert.deepEqual(second.copyReport, report)
  assert.notEqual(first.instance, second.instance)
  assert.equal(first.owned, true)
  assert.equal(first.mode, 'managed')
  assert.match(first.lifetime, /Project runtime shared/)
  assert.equal(f.connect.mock.callCount(), 2)
  assert.deepEqual((f.connect.mock.calls[0].this as McpConnection).config.args, (f.connect.mock.calls[1].this as McpConnection).config.args)
  assert.ok((f.connect.mock.calls[0].this as McpConnection).config.args!.includes('--page-id-routing'))
  assert.deepEqual(await Promise.all([f.invoke(owner, { pageId: 1, function: '() => 1' }), f.invoke(peer, { pageId: 2, function: '() => 2' })]), ['A', 'B'])
  assert.match(String(await f.setup(peer, { action: 'close', instance: first.instance })), /unknown browser instance/)
  const before = ensure.mock.callCount()
  assert.match(String(await f.setup({ ...owner, projectId: 'foreign' }, args)), /project binding mismatch/)
  const blocked = f.session(['browser_setup'])
  assert.match(String(await f.setup(blocked, args)), /not available|not active/)
  const leaf = new CallTools(owner.tools, home)
  leaf.setExecutionScope('call', [])
  assert.match(String(await f.setup({ ...owner, tools: leaf }, args)), /only their owner/)
  assert.equal(ensure.mock.callCount(), before)
  await owner.tools.resetDynamicAndWait()
  assert.equal(shutdown.mock.callCount(), 0)
  assert.equal(await f.invoke(peer, { pageId: 2, function: '() => 2' }), 'B')
  await f.setup(peer, { action: 'close', instance: second.instance })
  assert.equal(shutdown.mock.callCount(), 0)
  await f.importer.shutdownBrowser()
  assert.equal(shutdown.mock.callCount(), 1)
  await leaf.resetDynamicAndWait()
}))
test('session reset during managed initialization cannot publish a late binding or cancel a peer', async t => withTempWorkspace(async home => {
  const f = fixture(t, home), owner = f.session(), peer = f.session()
  const started = Promise.withResolvers<void>(), endpoint = Promise.withResolvers<string>()
  t.mock.method(SharedChrome.prototype, 'ensure', async () => { started.resolve(); return endpoint.promise })
  const args = { action: 'managed', browser: 'chrome', executablePath: join(home, 'synthetic-chrome'), userDataDir: join(home, 'synthetic-source'), profileDirectory: 'Default' }
  const pending = f.setup(owner, args)
  await started.promise
  // reset aborts the binding. Shared initialization is Project-owned and continues.
  const reset = owner.tools.resetDynamicAndWait()
  const peerPending = f.setup(peer, args)
  endpoint.resolve('ws://127.0.0.1:9555/devtools/browser/shared')
  await reset
  assert.match(String(await pending), /abort/i)
  assert.ok(JSON.parse(String(await peerPending)).instance)
  assert.deepEqual(JSON.parse(String(await f.setup(owner, { action: 'list' }))).instances, [])
  assert.equal(await f.invoke(peer, { pageId: 2, function: '() => 2' }), 'B')
}))
test('managed setup requires an explicit supported family and forwards it unchanged', async t => withTempWorkspace(async home => {
  const f = fixture(t, home)
  const ensure = t.mock.method(SharedChrome.prototype, 'ensure', async () => 'ws://127.0.0.1:9555/devtools/browser/shared')
  const args = { action: 'managed', executablePath: join(home, 'synthetic-browser'), userDataDir: join(home, 'synthetic-source'), profileDirectory: 'Default' }
  assert.match(String(await f.setup(f.session(), args)), /legacy managed overrides require/)
  assert.match(String(await f.setup(f.session(), { ...args, browser: 'electron' })), /invalid (?:browser_setup )?arguments/)
  assert.equal(ensure.mock.callCount(), 0)
  for (const browser of ['chrome', 'edge', 'brave', 'chromium']) {
    const ctx = f.session()
    assert.ok(JSON.parse(String(await f.setup(ctx, { ...args, browser }))).instance)
    assert.equal(ensure.mock.calls.at(-1)!.arguments[0]!.browser, browser)
    await ctx.tools.resetDynamicAndWait()
  }
}))
