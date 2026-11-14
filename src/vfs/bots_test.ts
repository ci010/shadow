import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { botFiles } from '../bots/sdk-test-fixture.ts'
import { migrateBotFrontmatter } from '../bots/format.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { ChannelManager } from '../channels/manager.ts'
import { BotChatSetup } from '../channels/chat-setup.ts'
import { ConfigSchema } from '../config/schema.ts'
import { Bus } from '../bus/bus.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { Tools } from '../tools/registry.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { LLMProvider } from '../providers/provider.ts'
import type { SessionMessageInput, SessionTurnFact } from '../sessions/input.ts'
import { inputContext } from '../sessions/input.ts'
import { isDirectOwnerTurn } from '../sessions/owner-policy.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { isOwnerSession } from '../sessions/owner-policy.ts'
import { InputRouter } from '../input/router.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { BotSetupTool } from '../tools/bot-setup.ts'
import { botPackageTool } from '../bots/management.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { VirtualFs } from './virtual-fs.ts'
import { createBotsHandler } from './bots.ts'

function fixture(workspace: string) {
  const store = new BotInstanceStore({ projectId: 'p', path: join(workspace, 'connections.json') })
  const bot = store.create('qq', 'Synthetic connection', { enabled: true, appId: 'PRIVATE_APP', secret: 'PRIVATE_SECRET' }, undefined, 'personal')
  store.bindOwner(bot.id, 'PRIVATE_OWNER', 'PRIVATE_CHAT')
  const bus = new Bus()
  const channels = new ChannelManager(ConfigSchema.parse({}), bus, {} as SessionManager, async () => { throw Error('No delivery') },
    { projectId: 'p', instanceStore: store, factory: () => { throw Error('Status must not construct adapters') } })
  const deployments = new BotDeployments({ projectId: 'p', directory: join(workspace, 'deployments'), runGit: async () => { throw Error('Fixture: no git') } })
  const directory = new DirectoryBots(deployments)
  const states = new Map<string, SessionState>([['web:owner', { sessionId: 'web:owner', projectId: 'p' } as SessionState]])
  const assertSession = (id: string) => {
    if (!isOwnerSession(states.get(id), 'p')) throw Error('Not an owner session')
  }
  const handler = createBotsHandler({ projectId: 'p', store, channels, directory, assertSession })
  const vfs = new VirtualFs(); vfs.mount('v:bots', 'Bot status', handler.read, handler.list)
  const context = { projectId: 'p', channel: 'web', sessionId: 'web:owner', admin: true, inputSource: 'user',
    signal: new AbortController().signal, tools: { executionMode: 'session' } } as ExecutionContext
  const read = new ReadTool(workspace, vfs), search = new SearchTool(workspace, undefined, vfs, false)
  assert.match(String(handler.read('authoring', context)), /BOT.md is the sole BOT listener/)
  assert.match(String(handler.read('authoring', context)), /skills: \[\{name, content\}\]/)
  const get = async (path: string) => JSON.parse(String(await read.execute({ path: `v:bots/${path}` }, context)))
  const deploy = async (id: string, files = botFiles()) => {
    files = { ...files, 'BOT.md': files['BOT.md']!.replace('id: demo', `id: ${id}`) }
    return deployments.deploy({ id, source: { folderId: 'source-folder', directory: `packages/${id}` }, ...deployments.freeze(files), expectedRevision: deployments.read(id)?.deployment.revision })
  }
  return { workspace, store, bot, channels, bus, deployments, directory, states, handler, vfs, context, read, search, get, deploy, assertSession }
}

function tree(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const file = join(root, name), stat = lstatSync(file)
    return { name, mtime: stat.mtimeMs, content: stat.isDirectory() ? tree(file) : readFileSync(file, 'utf8') }
  })
}
const qq = (connection: string, conversationId: string, enabled = true) => ({ platform: 'qq', botInstanceId: connection, conversationId, enabled, tools: [], allowFrom: ['PRIVATE_BINDING_SENDER'] })

test('Bot VFS connection whitelist uses the same live status as bot_setup, without secrets or setup side effects', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const setup = new BotSetupTool(new BotChatSetup('p'), f.channels, f.assertSession)
    f.channels['health'].set(f.bot.id, { state: 'disconnected', message: 'PRIVATE_HEADER https://example.invalid/?signature=PRIVATE_SIGNATURE' })
    const before = tree(workspace)
    const status = await f.get(`connections/${f.bot.id}`)
    const previous = JSON.parse(await setup.execute({ action: 'status' }, f.context)).bots[0]
    assert.deepEqual(status, { id: previous.id, displayName: previous.displayName, platform: previous.platform,
      purpose: previous.purpose, enabled: previous.enabled, health: previous.state, ownerVerified: previous.ownerVerified })
    assert.equal(status.health, 'disconnected')
    assert.equal(status.enabled, true, 'Enabled does not imply connected')
    assert.deepEqual(Object.keys(status).sort(), ['displayName', 'enabled', 'health', 'id', 'ownerVerified', 'platform', 'purpose'])
    f.channels['health'].set(f.bot.id, { state: 'connected' })
    assert.equal((await f.get(`connections/${f.bot.id}`)).health, 'connected', 'No persisted/cross-read status cache')
    for (const handler of ['glob', 'grep']) {
      const result = await f.search.execute({ handler, path: 'v:bots', query: handler === 'glob' ? '**' : 'PRIVATE_|signature|config|secrets' }, f.context)
      assert.doesNotMatch(result, /PRIVATE_|signature=|"config"|"secrets"/)
    }
    assert.deepEqual(tree(workspace), before)
    assert.equal(f.channels['channels'].size, 0, 'Status never initializes a connection')
    f.bus.stopAll()
  })
})

test('deployment status separates bindings/subscriptions/enablement and projects the actual router listeners', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const files = botFiles('throw new Error("PRIVATE_MODULE_MUST_NOT_EXECUTE")', { bindings: [qq(f.bot.id, 'group:one'), qq(f.bot.id, 'group:two', false), qq(f.bot.id, 'group:three')],
      subscriptions: [{ platform: 'qq', botInstanceId: f.bot.id, conversationId: 'group:one' }, { platform: 'qq', botInstanceId: f.bot.id, conversationId: 'group:two' }] })
    const previous = await f.deploy('support', files)
    const current = await f.deploy('support', migrateBotFrontmatter(files))
    const expected = f.directory.inputListeners()
    const before = tree(workspace), diagnostics = f.directory.diagnostics()
    const status = await f.get('deployments/support/status')
    assert.equal(status.revision, current.revision)
    assert.equal(status.previous, previous.revision)
    assert.deepEqual(status.source, { folderId: 'source-folder', directory: 'packages/support' })
    assert.equal(status.format, 'frontmatter')
    assert.equal(status.loaded, 'lazy-validated')
    assert.equal(status.processingSuccess, 'unknown')
    assert.equal(status.routing, 'not-probed')
    assert.deepEqual(status.counts, { bindings: 3, subscribed: 2, enabledBindings: 2, listeners: 1 })
    assert.deepEqual(status.rows.map((row: { enabled: boolean; subscribed: boolean }) => [row.enabled, row.subscribed]), [[true, true], [false, true], [true, false]])
    const listeners = await f.get('deployments/support/listeners')
    assert.deepEqual(listeners.rows, expected)
    let calls = 0
    const router = new InputRouter('p', { listeners: () => f.directory.inputListeners(), deliver: async target => { calls++; return target } })
    const envelope = { ...expected[0]!, projectId: 'p', id: 'fixture-input', payload: null }
    assert.deepEqual(await router.route(envelope), { kind: 'bot', id: 'support' })
    assert.equal(await router.route({ ...envelope, topic: 'group:two' }), undefined)
    assert.equal(calls, 1)
    const oldTool = botPackageTool({ projectId: 'p', deployments: f.deployments, runtime: f.directory, folders: { list: () => [] }, canAuthor: () => true } as unknown as Parameters<typeof botPackageTool>[0])
    const old = JSON.parse(String(await oldTool.execute({ action: 'status' }, f.context)))
    assert.equal(old.deployments[0].revision, status.revision)
    assert.equal(old.deployments[0].previous, status.previous)
    assert.deepEqual(f.directory.diagnostics(), diagnostics)
    assert.deepEqual(tree(workspace), before)
    await f.deploy('support', botFiles('', { bindings: [qq(f.bot.id, 'group:one')], subscriptions: [] }))
    assert.equal((await f.get('deployments/support/listeners')).total, 0, 'Explicit [] receives nothing')
    assert.equal((await f.get('deployments/support/status')).format, 'legacy-json')
    f.bus.stopAll()
  })
})

test('invalid, quarantined, identity-mismatched and integrity-failed deployments remain discoverable without unsafe parsing or metadata', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    await f.deploy('healthy')
    const invalid = await f.deploy('invalid', botFiles('', { bindings: [{ ...qq(f.bot.id, 'group:invalid'), skills: ['PRIVATE_DRAFT'] }] }))
    // Existing runtime quarantine is neither cleared nor updated by VFS reads.
    f.directory.definitions()
    const diagnostics = f.directory.diagnostics()
    const before = tree(workspace)
    const status = await f.get('deployments/invalid/status')
    assert.equal(status.state, 'quarantined')
    assert.equal(status.error, 'invalid-package')
    assert.equal(status.revision, invalid.revision, 'Only integrity-verified metadata survives invalid package parsing')
    assert.equal(status.format, null)
    assert.equal(status.counts, null)
    assert.equal((await f.get('deployments/invalid/listeners')).total, 0)
    assert.deepEqual(f.directory.diagnostics(), diagnostics)
    assert.deepEqual(tree(workspace), before)
    await f.deploy('broken')
    writeFileSync(join(workspace, 'deployments/broken/current/BOT.md'), 'PRIVATE_CORRUPT https://example.invalid/?sig=PRIVATE_SIGNATURE')
    const broken = await f.get('deployments/broken/status')
    assert.equal(broken.error, 'integrity-failure')
    assert.equal(broken.revision, undefined, 'Integrity failure cannot expose unverified active metadata')
    assert.equal(broken.source, undefined)
    assert.equal((await f.get('deployments/healthy/status')).state, 'valid')
    assert.ok((await f.get('deployments/index')).rows.some((row: { id: string }) => row.id === 'invalid'))
    assert.match(await f.search.execute({ handler: 'grep', query: 'invalid-package|integrity-failure', path: 'v:bots/deployments' }, f.context), /deployments\/invalid\/status/)
    assert.doesNotMatch(await f.search.execute({ handler: 'grep', query: 'PRIVATE_', path: 'v:bots' }, f.context), /PRIVATE_/)
    const mismatched = f.deployments.freeze(botFiles())
    await f.deployments.deploy({ id: 'mismatch', source: { folderId: 'source', directory: '' }, ...mismatched })
    assert.equal((await f.get('deployments/mismatch/status')).error, 'identity-mismatch')
    await f.deploy('malformed', { ...botFiles(), 'bot.json': '{"headers":"PRIVATE_BEARER", broken' })
    assert.equal((await f.get('deployments/malformed/status')).error, 'invalid-package')
    const metadataPath = join(workspace, 'deployments/healthy/active.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    metadata.current.headers = { Authorization: 'PRIVATE_BEARER' }
    metadata.current.source.directory = 'https://example.invalid/?sig=PRIVATE_SIGNATURE'
    writeFileSync(metadataPath, JSON.stringify(metadata))
    assert.equal((await f.get('deployments/healthy/status')).source, null)
    assert.doesNotMatch(await f.search.execute({ handler: 'grep', path: 'v:bots', query: 'PRIVATE_|Authorization' }, f.context), /PRIVATE_|Authorization/)
    f.bus.stopAll()
  })
})

test('all VFS entrypoints reject cross-Project, channel/Service, child, nonowner, script and remote contexts before discovery', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const patches: Partial<ExecutionContext>[] = [{ projectId: 'other' }, { admin: false }, { channel: 'qq' }, { channel: 'a2a' },
      { sessionId: 'bot:p:service:group' }, { isGroup: true }, { scriptInvocation: true },
      { remoteWorkdir: {} as ExecutionContext['remoteWorkdir'] }, { channelAddress: {} as ExecutionContext['channelAddress'] },
      { memoryAccess: {} as ExecutionContext['memoryAccess'] }, { tools: { executionMode: 'task' } as ExecutionContext['tools'] },
      { tools: { executionMode: 'call' } as ExecutionContext['tools'] }, { sessionId: 'web:missing' }]
    for (const state of [{ parentSessionId: 'web:owner' }, { parent: {} }, { automation: {} }, { mode: 'task' }, { mode: 'call' }, { statePersistence: 'ephemeral' }, { projectId: 'other' }]) {
      const sessionId = `web:denied-${patches.length}`
      f.states.set(sessionId, { sessionId, projectId: 'p', ...state } as SessionState)
      patches.push({ sessionId })
    }
    let inspections = 0
    f.deployments.diagnosticIds = () => { inspections++; throw Error('Must not discover') }
    for (const patch of patches) {
      const ctx = { ...f.context, ...patch }
      await assert.rejects(async () => f.handler.read('overview', ctx))
      await assert.rejects(async () => f.handler.list(ctx))
      await assert.rejects(async () => f.read.execute({ path: 'v:bots/connections/index', flag: 'l' }, ctx))
      // SearchTool blocks remote search even before VFS; other denials throw.
      for (const handler of ['grep', 'glob']) {
        const operation = () => f.search.execute({ path: 'v:bots', handler, query: '**'.replace('**', handler === 'grep' ? '.' : '**') }, ctx)
        if (patch.remoteWorkdir) assert.match(await operation(), /only v:sessions/)
        else await assert.rejects(operation)
      }
    }
    assert.equal(inspections, 0)
    assert.match(String(await f.handler.read('overview', { ...f.context, channel: 'virtual' })), /Read-only/)
    assert.throws(() => createBotsHandler({ projectId: 'other', store: f.store, channels: f.channels, directory: f.directory, assertSession: () => {} }), /ownership/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(async () => f.handler.read('overview', { ...f.context, signal: controller.signal }))
    assert.throws(() => f.vfs.write('v:bots/connections/index', { content: '{}' }, f.context), /read-only/)
    f.bus.stopAll()
  })
})

test('read/list/glob/grep paths and paging agree, with bounded broad discovery and explicit object expansion', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const bindings = Array.from({ length: 53 }, (_, i) => qq(f.bot.id, `group:${i}`))
    await f.deploy('paged', botFiles('', { bindings }))
    const status = await f.get('deployments/paged/status')
    assert.equal(status.rows.length, 50)
    assert.equal(status.next, 'v:bots/deployments/paged/status/2')
    assert.equal((await f.get('deployments/paged/status/2')).rows.length, 3)
    assert.equal((await f.get('deployments/paged/listeners/2')).rows.length, 3)
    const entries = await f.vfs.list('v:bots/deployments/paged', f.context)
    assert.equal(entries?.length, 4)
    const broadMissing = await f.search.execute({ handler: 'grep', path: 'v:bots/deployments', query: 'group:52' }, f.context)
    assert.match(broadMissing, /first page/, 'Omitted later object pages must warn even with only one deployment')
    const listPage = String(await f.read.execute({ path: 'v:bots/deployments/index', flag: 'l', offset: 1, limit: 3 }, f.context))
    assert.match(listPage, /projectId/)
    for (const entry of entries!) assert.equal(await f.vfs.resolve(entry.path, f.context), entry.content)
    const glob = await f.search.execute({ handler: 'glob', path: 'v:bots/deployments/paged', query: '**', limit: 1 }, f.context)
    assert.match(glob, /continue with offset: 1/)
    const grep = await f.search.execute({ handler: 'grep', path: 'v:bots/deployments/paged/listeners/2', query: 'group:52' }, f.context)
    const line = Number(/Line (\d+)/.exec(grep)?.[1])
    assert.ok(line > 0)
    assert.match(String(await f.read.execute({ path: 'v:bots/deployments/paged/listeners/2', offset: line, limit: 1 }, f.context)), /group:52/)
    const ids = Array.from({ length: 1001 }, (_, i) => `connection-${String(i).padStart(4, '0')}`)
    f.store.ids = limit => ({ ids: ids.slice(0, limit), truncated: ids.length > limit })
    f.channels.botStatus = id => ({ ...f.store.status(f.bot.id), id })
    const index = await f.get('connections/index')
    assert.equal(index.rows.length, 50)
    assert.equal(index.warning, 'connection-index-limit')
    assert.equal((await f.get('connections/index/2')).rows.length, 50)
    assert.match(await f.search.execute({ handler: 'grep', path: 'v:bots/connections', query: 'DOES_NOT_MATCH' }, f.context), /connection-index-limit/)
    assert.match(await f.search.execute({ handler: 'glob', path: 'v:bots/connections/connection-0052', query: '**' }, f.context), /connection-0052/)
    for (const path of ['deployments/absent/status', 'deployments/paged/status/99', 'deployments/paged/unknown', '../connections/index'])
      await assert.rejects(f.get(path), /not found/)
    f.bus.stopAll()
  })
})

test('storage boundary failures and pathological indexes are safe, bounded and never repaired by status', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    await f.deploy('owned')
    const owner = join(workspace, 'deployments/owned/owner.json')
    writeFileSync(owner, JSON.stringify({ id: 'owned', projectId: 'other', secret: 'PRIVATE_FOREIGN' }))
    assert.equal((await f.get('deployments/owned/status')).error, 'storage-unavailable')
    assert.equal((await f.get('deployments/owned/status')).revision, undefined)
    symlinkSync(join(workspace, 'deployments/owned'), join(workspace, 'deployments/linked'))
    assert.equal((await f.get('deployments/linked/status')).error, 'storage-unavailable')
    mkdirSync(join(workspace, 'deployments/incomplete'))
    assert.equal((await f.get('deployments/incomplete/status')).error, 'storage-unavailable')
    const before = readFileSync(owner, 'utf8')
    await f.search.execute({ handler: 'grep', path: 'v:bots', query: 'PRIVATE_' }, f.context)
    assert.equal(readFileSync(owner, 'utf8'), before)
    for (let i = 0; i < 1030; i++) mkdirSync(join(workspace, `deployments/empty-${i}`))
    const ids = f.deployments.diagnosticIds()
    assert.ok(ids.ids.length <= 1024)
    assert.equal(ids.warning, 'deployment-index-limit')
    writeFileSync(join(workspace, 'deployments/.store.json'), '{"projectId":"other"}')
    assert.deepEqual(f.deployments.diagnosticIds(), { ids: [], warning: 'deployment-store-unavailable' })
    assert.equal((await f.get('deployments/owned/status')).error, 'storage-unavailable')
    f.bus.stopAll()
  })
})

test('personal deployments do not export private owner/session listeners, and URL-bearing labels are omitted', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    await f.deploy('personal', botFiles('', { mode: 'personal', connection: f.bot.id, agent: 'general', tools: [] }))
    assert.equal((await f.get('deployments/personal/status')).subscriptionMode, 'host-owner-ingress')
    const listeners = await f.get('deployments/personal/listeners')
    assert.equal(listeners.total, 0)
    assert.equal(listeners.personalIngress, 'host-session-listeners-not-exported')
    f.store.update(f.bot.id, { displayName: 'https://example.invalid/?sig=PRIVATE_SIGNATURE' })
    assert.equal((await f.get(`connections/${f.bot.id}`)).displayName, '[url-omitted]')
    assert.doesNotMatch(await f.search.execute({ handler: 'grep', path: 'v:bots', query: 'PRIVATE_' }, f.context), /PRIVATE_/)
    f.bus.stopAll()
  })
})


test('a deployment named index can be searched directly beyond broad discovery', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    await f.deploy('index')
    const realIndex = f.deployments.diagnosticIds.bind(f.deployments)
    f.deployments.diagnosticIds = () => ({ ids: [...Array.from({ length: 51 }, (_, i) => `earlier-${i}`), ...realIndex().ids] })
    const scoped = await f.search.execute({ handler: 'glob', path: 'v:bots/deployments/index/status', query: '**' }, f.context)
    assert.match(scoped, /v:bots\/deployments\/index\/status/)
    assert.match(await f.search.execute({ handler: 'grep', path: 'v:bots/deployments/index/status', query: 'lazy-validated' }, f.context), /lazy-validated/)
    f.bus.stopAll()
  })
})

test('metadata FIFOs reject promptly instead of blocking synchronous status reads', async t => {
  if (process.platform === 'win32') { t.skip('POSIX FIFO fixture'); return }
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    await f.deploy('owned')
    const module = new URL('../bots/deployments.ts', import.meta.url).href
    const script = `import { BotDeployments } from ${JSON.stringify(module)};
      try { const store = new BotDeployments({ projectId: 'p', directory: process.argv[1] }); console.log(store.inspect('owned').error); }
      catch { console.log('rejected'); }`
    for (const name of ['owned/owner.json', 'owned/active.json', '.store.json']) {
      const file = join(workspace, 'deployments', name), before = readFileSync(file)
      unlinkSync(file)
      execFileSync('mkfifo', [file])
      try {
        const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, join(workspace, 'deployments')], { timeout: 5000, encoding: 'utf8' })
        assert.match(result, /storage-unavailable|rejected/)
      } finally { unlinkSync(file); writeFileSync(file, before) }
    }
    f.bus.stopAll()
  })
})

test('Feishu and Discord message/observation selectors use the canonical listener projection, not raw grants', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const discord = { platform: 'discord', id: '00000000-0000-4000-8000-000000000001', botInstanceId: f.bot.id, botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '201' },
      enabled: true, trigger: 'mention', participants: { everyone: false, userIds: ['500'], roleIds: [] }, tools: [], readDomains: [], inheritThreads: true, manage: false }
    const observation = { ...discord, id: '00000000-0000-4000-8000-000000000002',
      target: { kind: 'channel', guildId: '100', channelId: '301' }, observation: { enabled: true, guildId: '100', channelIds: ['201', '202'], audienceChannelId: '301', processor: { code: 'throw Error("PRIVATE_PROCESSOR")', delayMs: 10 } } }
    await f.deploy('multi', botFiles('', { bindings: [{ ...qq(f.bot.id, 'group:feishu'), platform: 'feishu' }, discord, observation] }))
    assert.deepEqual((await f.get('deployments/multi/listeners')).rows, f.directory.inputListeners())
    assert.equal((await f.get('deployments/multi/listeners')).rows[1].descendants, true)
    assert.deepEqual((await f.get('deployments/multi/listeners')).rows[2], { target: { kind: 'bot', id: 'multi' }, source: { type: 'discord', id: f.bot.id }, kind: 'observation', topic: observation.id })
    assert.doesNotMatch(await f.search.execute({ handler: 'grep', path: 'v:bots/deployments/multi', query: 'PRIVATE_' }, f.context), /PRIVATE_/)
    const status = await f.get('deployments/multi/status')
    assert.deepEqual(status.rows[1].binding, { platform: 'discord', bindingId: discord.id })
    assert.doesNotMatch(JSON.stringify(status), /participants|allowFrom|grants/)
    f.bus.stopAll()
  })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: child request continuation preserves owner execution identity through the real session tool loop`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const f = fixture(workspace), bus = new Bus()
      const store = new Store(join(workspace, 'sessions')); await store.init()
      const tools = new Tools(workspace)
      const captured: ExecutionContext[] = []
      tools.register({ name: 'inspect_bots', description: 'Read-only continuation regression probe', parameters: { type: 'object', properties: {} },
        execute: async (_args, context) => {
          assert.equal(context.tools.executionMode, 'session')
          assert.equal(context.admin, true)
          assert.equal(context.inputSource, 'session')
          assert.equal(context.senderId, 'task:child')
          assert.equal(isDirectOwnerTurn(context), false)
          const result = await f.read.execute({ path: 'v:bots/overview' }, context)
          assert.match(String(result), /Read-only/)
          const setup = new BotSetupTool(new BotChatSetup('p'), f.channels, f.assertSession)
          assert.match(await setup.execute({ action: 'status' }, context), /bots/)
          for (const action of [{ action: 'open' }, { action: 'create', purpose: 'personal', platform: 'qq', displayName: 'Denied' }, { action: 'connection', id: f.bot.id, enabled: false }]) {
            await assert.rejects(() => setup.execute(action, context), /direct administrator human turn/)
          }
          captured.push(context)
          return String(result)
        } })
      let calls = 0
      const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], chat: async () => ++calls === 1
        ? { content: '', toolCalls: [{ id: 'inspect', name: 'inspect_bots', arguments: {} }] }
        : { content: 'Finished', toolCalls: [] } }
      const sessions = new SessionManager({ workspace, store, provider, bus, tools,
        agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }), allNames: () => ['general'] } as unknown as AgentTypesManager,
        handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
        context: { buildSystemPrompt: async () => 'Synthetic continuation fixture.' },
        getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 128000 }),
      } as unknown as SessionManagerDeps)
      const state: SessionState = { sessionId: 'web:owner', projectId: 'p', segmentIndex: 0, mode: 'session' }
      await store.saveState(state.sessionId, state)
      const input: SessionMessageInput = { id: 'child-request', timestamp: new Date().toISOString(), kind: 'message', policy: 'queue', content: 'Please inspect Bot status.',
        source: { kind: 'session', sessionId: 'task:child', coordination: { intent: 'request' } } }
      const finished = Promise.withResolvers<SessionTurnFact>()
      const off = bus.on('session.turn.finished', fact => { if (fact.inputId === input.id) finished.resolve(fact) })
      try {
        await sessions.start()
        await sessions.deliver(state.sessionId, input)
        const fact = await finished.promise
        assert.equal(fact.status, 'completed', fact.error)
        assert.equal(captured.length, 1, 'The actual ExecutionContext must reach the read tool')
        // A forged sender/reply cannot give a restricted target the owner's identity.
        for (const patch of [{ mode: 'task' }, { mode: 'call' }, { serviceGeneration: 'service' }, { parentSessionId: 'web:parent' }, { projectId: 'foreign' }, { sessionId: 'web:missing' }]) {
          const target = { ...state, ...patch } as SessionState
          const forged: SessionMessageInput = { ...input, replyTo: { channel: 'web', chatId: 'owner' }, source: { kind: 'session', sessionId: 'web:owner', senderName: 'Administrator', coordination: { intent: 'request' } } }
          const context: ExecutionContext = { ...captured[0]!, ...inputContext(target.sessionId, forged, target), sessionId: target.sessionId, projectId: target.projectId, inputSource: 'session' }
          await assert.rejects(() => f.read.execute({ path: 'v:bots/overview' }, context))
        }
      } finally {
        bus.off(off); await sessions.stop(); bus.stopAll(); f.bus.stopAll(); store.close?.()
      }
    })
  })
}
