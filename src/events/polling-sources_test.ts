import { EventProviderRuntime } from './providers/runtime.ts'
import { EventProviderTool } from '../tools/event-provider.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CapabilityBroker } from '../execution/grants.ts'
import { Bus } from '../bus/bus.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { EventService } from './service.ts'
import { PollingSources } from './polling-sources.ts'
import { EventSourceTool, registerEventTools } from '../tools/event-source.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { ReadTool } from '../tools/read.ts'

const grant = {
  id: 'fetch', kind: 'http' as const, origin: 'https://api.github.com',
  routes: [{ method: 'GET' as const, path: '/repos/test/repo/issues/1/events' }],
  credential: { secretRef: 'github-issues', header: 'Authorization', prefix: 'Bearer ' },
}

const code = `
import { fetch } from '@shadow/fetch'
export async function run({ checkpoint }) {
  const response = await fetch('/repos/test/repo/issues/1/events')
  const items = response.body
  const unseen = checkpoint === null ? [] : items.filter(item => BigInt(item.id) > BigInt(checkpoint))
  return {
    events: unseen.filter(item => item.event === 'closed')
      .map(item => ({ id: String(item.id), type: 'github.issue.closed', content: 'Issue closed' })),
    checkpoint: items.at(-1)?.id ?? checkpoint,
  }
}`

test('polling source uses host-held credential, restores checkpoint, and avoids repeat deliveries', async () => {
  await withTempWorkspace(async workspace => {
    const delivered: string[] = []
    const requests: Array<{ url: string; authorization: string | undefined }> = []
    let remoteEvents: Array<{ id: string; event: string }> = [{ id: '1', event: 'closed' }]
    const makeBroker = () => new CapabilityBroker({
      projectId: 'project', directory: join(workspace, 'receipts'),
      resolveSecret: async () => 'synthetic-secret',
      deliver: async () => undefined, canDeliver: () => false,
      request: async (url, options) => {
        requests.push({ url: String(url), authorization: (options?.headers as Record<string, string>).authorization })
        return new Response(JSON.stringify(remoteEvents), { status: 200 })
      },
    })
    const makeEvents = async () => {
      const events = new EventService(workspace, new Bus(), async (id, input) => {
        assert.equal(id, 'owner')
        if (input.kind === 'message') delivered.push(input.content)
        return { status: 'accepted', sessionId: id, inputId: input.id }
      })
      await events.start()
      return events
    }
    const events = await makeEvents()
    const subscription = events.subscribe({ sessionId: 'owner', event: 'github.issue.closed', source: 'custom:issue-watch' })
    events.subscribe({ sessionId: 'watcher', event: 'github.issue.closed', source: 'custom:issue-watch' })
    const sources = new PollingSources(workspace, events, makeBroker(), id => id === 'owner', ref => ref === 'github-issues')
    sources.start()
    const created = sources.create({
      id: 'issue-watch', ownerSessionId: 'owner', code, grant, intervalMs: 60_000,
    })
    assert.match(created.hash, /^[a-f0-9]{64}$/)
    assert.equal(events.unregisterSource('custom:issue-watch'), false)
    assert.throws(() => events.registerSource({ source: 'custom:issue-watch', kind: 'custom' }), /managed/)
    assert.equal(await sources.run('issue-watch', 'owner'), 0)
    remoteEvents = [...remoteEvents, { id: '2', event: 'closed' }]
    events.unsubscribe(subscription.id)
    await assert.rejects(sources.run('issue-watch', 'owner'), /Subscribe this session/)
    assert.equal(sources.list('owner')[0].lastError, 'missing_subscription')
    events.subscribe({ sessionId: 'owner', event: 'github.issue.closed', source: 'custom:issue-watch' })
    assert.equal(await sources.run('issue-watch', 'owner'), 1)
    assert.deepEqual(delivered, ['Issue closed'])
    assert.equal(await sources.run('issue-watch', 'owner'), 0)
    assert.equal(requests.length, 3)
    assert.deepEqual(requests[0], {
      url: 'https://api.github.com/repos/test/repo/issues/1/events',
      authorization: 'Bearer synthetic-secret',
    })
    const persisted = await readFile(projectStoragePath(workspace, '.events', 'polling-sources.json'), 'utf8')
    assert.doesNotMatch(persisted, /synthetic-secret/)
    await sources.stop()
    await events.stop()

    // Legacy definitions predate the pause flag; checksum identity remains valid.
    const legacy = JSON.parse(persisted)
    delete legacy[0].enabled
    await writeFile(projectStoragePath(workspace, '.events', 'polling-sources.json'), JSON.stringify(legacy))
    const restartedEvents = await makeEvents()
    const restarted = new PollingSources(workspace, restartedEvents, makeBroker(), id => id === 'owner', () => true)
    restarted.start()
    assert.equal(await restarted.run('issue-watch', 'owner'), 0)
    remoteEvents = [...remoteEvents, { id: '3', event: 'closed' }]
    assert.equal(await restarted.run('issue-watch', 'owner'), 1)
    assert.deepEqual(delivered, ['Issue closed', 'Issue closed'])
    await restarted.stop()
    await restartedEvents.stop()
  })
})

test('source checksum, grant, and failures do not silently advance the cursor', async () => {
  await withTempWorkspace(async workspace => {
    const events = new EventService(workspace, new Bus(), async () => { throw new Error('session unavailable') })
    await events.start()
    events.subscribe({ sessionId: 'owner', event: 'github.issue.closed', source: 'custom:issue-watch' })
    let requests = 0
    const broker = new CapabilityBroker({
      projectId: 'project', directory: join(workspace, 'receipts'),
      resolveSecret: async () => 'synthetic-secret',
      deliver: async () => undefined, canDeliver: () => false,
      request: async () => {
        requests++
        return new Response(JSON.stringify([{ id: '1', event: 'closed' }]), { status: 200 })
      },
    })

    const sources = new PollingSources(workspace, events, broker, id => id === 'owner', () => true)
    sources.start()
    sources.create({
      id: 'issue-watch', ownerSessionId: 'owner', code, intervalMs: 60_000,
      grant: { ...grant, routes: [{ method: 'GET', path: '/private' }] },
    })

    await assert.rejects(sources.run('issue-watch', 'owner'), /route_denied/)
    assert.equal(requests, 0)
    assert.equal(await sources.remove('issue-watch', 'owner'), true)
    const failingCode = `
      import { fetch } from '@shadow/fetch'
      export async function run({ checkpoint }) {
        await fetch('/repos/test/repo/issues/1/events')
        return { events: [{ id: '1', type: 'github.issue.closed', content: 'closed' }], checkpoint: '1' }
      }`
    sources.create({ id: 'issue-watch', ownerSessionId: 'owner', code: failingCode, intervalMs: 60_000, grant })
    await assert.rejects(sources.run('issue-watch', 'owner'), /session unavailable/)
    const path = projectStoragePath(workspace, '.events', 'polling-sources.json')
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(persisted[0].checkpoint, null)
    assert.deepEqual(persisted[0].seen, [])
    await sources.stop()
    await events.stop()
    persisted[0].grant.routes = [{ method: 'GET', path: '/private' }]
    await writeFile(path, JSON.stringify(persisted))
    const changedGrant = new PollingSources(workspace, events, broker, () => true, () => true)
    assert.throws(() => changedGrant.start(), /changed on disk/)
    persisted[0].grant.routes = grant.routes
    persisted[0].code = code
    await writeFile(path, JSON.stringify(persisted))
    const restarted = new PollingSources(workspace, events, broker, () => true, () => true)
    assert.throws(() => restarted.start(), /changed on disk/)
  })
})

test('event source tool accepts only direct user creation and does not return source code', async () => {
  await withTempWorkspace(async workspace => {
    const events = new EventService(workspace, new Bus(), async (id, input) => ({
      status: 'accepted', sessionId: id, inputId: input.id,
    }))
    await events.start()
    const broker = new CapabilityBroker({
      projectId: 'project', directory: join(workspace, 'receipts'),
      resolveSecret: async () => 'synthetic-secret',
      deliver: async () => undefined, canDeliver: () => false,
    })

    const sources = new PollingSources(workspace, events, broker, id => id === 'owner', () => true)
    sources.start()
    const tool = new EventSourceTool(sources, id => id === 'owner')
    const context: ExecutionContext = {
      projectId: 'project', sessionId: 'owner', physicalSessionId: 'owner.0',
      channel: 'web', chatId: 'owner', senderId: 'owner', messageId: 'user-input',
      inputSource: 'user', signal: new AbortController().signal,
      tools: new SessionTools(new Tools(workspace), workspace),
    }
    const args = {
      action: 'create', id: 'issue-watch', code, grant_json: JSON.stringify(grant),
      interval_seconds: 60,
    }
    try {
      assert.match(await tool.execute(args, { ...context, inputSource: 'event' }), /direct user turn/)
      assert.match(await tool.execute(args, context), /Created event source custom:issue-watch/)
      const simpleArgs = { action: 'create', id: 'simple-watch', grant_json: JSON.stringify(grant), interval_seconds: 60,
        simple_json: JSON.stringify({ mode: 'snapshot', request: { method: 'GET', path: '/repos/test/repo/issues/1/events' }, select: [], eventType: 'remote.changed', completeResponse: true }) }
      assert.match(await tool.execute(simpleArgs, { ...context, inputSource: 'event' }), /direct user turn/)
      assert.match(await tool.execute(simpleArgs, context), /Created event source custom:simple-watch/)
      assert.match(await tool.execute({ ...simpleArgs, code }, context), /exactly one/)

      await assert.rejects(tool.execute(args, context), /already exists/)
      const listing = await tool.execute({ action: 'list' }, context)
      assert.match(listing, /issue-watch/)
      assert.doesNotMatch(listing, /export async function|synthetic-secret/)
      assert.match(await tool.execute({ action: 'inspect', id: 'issue-watch' }, { ...context, inputSource: 'event' }), /checkpoint/)
      assert.match(await tool.execute({ action: 'pause', id: 'issue-watch' }, { ...context, inputSource: 'event' }), /direct user turn/)
      assert.match(await tool.execute({ action: 'pause', id: 'issue-watch' }, context), /Paused/)
      await assert.rejects(tool.execute({ action: 'run', id: 'issue-watch' }, context), /paused/)
      assert.match(await tool.execute({ action: 'resume', id: 'issue-watch' }, context), /Resumed/)
      assert.match(await tool.execute({ action: 'inspect', id: 'issue-watch' }, { ...context, sessionId: 'foreign' }), /owner session/)
      assert.match(await tool.execute({ action: 'remove', id: 'issue-watch' }, context), /Removed event source/)
    } finally {
      await sources.stop()
      await events.stop()
    }
  })
})

test('event tools are discoverable and invoked lazily without entering the base tool list', async () => {
  await withTempWorkspace(async workspace => {
  const events = new EventService(workspace, new Bus(), async (id, input) => ({
    status: 'accepted', sessionId: id, inputId: input.id,
  }))
  await events.start()
  const broker = new CapabilityBroker({
    projectId: 'project', directory: join(workspace, 'receipts'),
    resolveSecret: async () => undefined, deliver: async () => undefined, canDeliver: () => false,
  })
  const sources = new PollingSources(workspace, events, broker, id => id === 'owner', () => false)
  sources.start()
  const providers = new EventProviderRuntime(workspace, broker, async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }), id => id === 'owner', () => false)
  providers.start()
  try {
    const base = new Tools(workspace)
    const importer = new ImportTool(new Map(), workspace)
    const invoke = new InvokeTool(importer)
    base.register(new ReadTool(workspace))
    base.register(invoke)
    registerEventTools(importer, events, sources, id => id === 'owner', [new EventProviderTool(providers, 'project')])
    const session = new SessionTools(base, workspace)
    const context: ExecutionContext = {
      projectId: 'project', sessionId: 'owner', physicalSessionId: 'owner.0',
      channel: 'web', chatId: 'owner', senderId: 'owner', messageId: 'user-input',
      inputSource: 'user', signal: new AbortController().signal, tools: session,
    }
    assert.deepEqual(base.getDefinitions().map(def => def.function.name), ['read', 'invoke_tool'])
    assert.equal(session.hasDynamic('event_subscribe'), false)
    assert.equal(session.hasDynamic('event_source'), false)
    const catalog = await importer.virtualEntries(context, { subpath: 'events' })
    assert(catalog.some(entry => entry.name === 'events/event_subscribe'))
    assert(catalog.some(entry => entry.name === 'events/event_source'))
    assert(catalog.some(entry => entry.name === 'events/event_provider'))
    assert.equal(session.hasDynamic('event_provider'), false)
    const discovered = JSON.parse(String(await invoke.execute({name:'event_provider',args:{action:'discover'}},context)))
    assert.equal(discovered.providers[0].id, 'github-issues')
    assert.ok(discovered.providers[0].demandSchema)
    assert.ok(discovered.providers[0].examples.length)
    assert.equal(session.hasDynamic('event_provider'), true)
    assert.match(String(await invoke.execute({
      name: 'event_subscribe', args: { action: 'subscribe', event: 'issue.closed' },
    }, context)), /Subscribed owner to issue.closed/)
    assert.equal(session.hasDynamic('event_subscribe'), true)
    assert.equal(session.hasDynamic('event_source'), false)
    assert.equal(String(await invoke.execute({ name: 'event_source', args: { action: 'list' } }, context)), '[]')
    assert.equal(session.hasDynamic('event_source'), true)
    const call = new SessionTools(base, workspace)
    call.setExecutionScope('call', [])
    assert.match(String(await invoke.execute({
      name: 'event_subscribe', args: { action: 'subscribe', event: 'issue.closed' },
    }, { ...context, tools: call })), /not active and could not be imported/)
    assert.deepEqual(events.list('owner').map(sub => sub.event), ['issue.closed'])
  } finally {
    await providers.stop()
    await sources.stop()
    await events.stop()
  }
  })
})


test('owner diagnostics and pause/resume preserve checkpoints across restart without leaking code', async () => {
  await withTempWorkspace(async workspace => {
    const events = new EventService(workspace, new Bus(), async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }))
    await events.start()
    const broker = new CapabilityBroker({ projectId: 'project', directory: join(workspace, 'receipts'),
      resolveSecret: async () => undefined, deliver: async () => undefined, canDeliver: () => false })
    const make = () => new PollingSources(workspace, events, broker, id => id === 'owner', () => false)
    let sources = make()
    sources.start()
    try {
      events.subscribe({ sessionId: 'owner', event: 'changed', source: 'custom:generic', delivery: { urgency: 'queue' } })
      sources.create({ id: 'generic', ownerSessionId: 'owner', intervalMs: 30000,
        grant: { id: 'fetch', kind: 'http', origin: 'https://example.com', routes: [{ method: 'GET', path: '/signal' }] },
        code: 'export async function run({checkpoint}) { return {events:[], checkpoint: checkpoint ?? "private-cursor"} }' })
      assert.equal(await sources.run('generic', 'owner'), 0)
      assert.throws(() => sources.inspect('generic', 'foreign'), /not found/)
      await assert.rejects(sources.setEnabled('generic', 'foreign', false), /not found/)
      const evidence = sources.inspect('generic', 'owner')
      assert.equal(evidence.checkpoint, 'private-cursor')
      assert.equal(evidence.subscriptions[0].delivery?.urgency, 'queue')
      assert.doesNotMatch(JSON.stringify(evidence), /export async|code/)
      await sources.setEnabled('generic', 'owner', false)
      await assert.rejects(sources.run('generic', 'owner'), /paused/)
      await sources.stop()
      sources = make()
      sources.start()
      assert.equal(sources.inspect('generic', 'owner').enabled, false)
      assert.equal(sources.inspect('generic', 'owner').checkpoint, 'private-cursor')
      await assert.rejects(sources.run('generic', 'owner'), /paused/)
      await sources.setEnabled('generic', 'owner', true)
      assert.equal(await sources.run('generic', 'owner'), 0)
      assert.equal(sources.inspect('generic', 'owner').checkpoint, 'private-cursor')
      assert.equal(await sources.remove('generic', 'owner'), true)
      assert.throws(() => sources.inspect('generic', 'owner'), /not found/)
    } finally { await sources.stop(); await events.stop() }
  })
})


test('pausing a polling source aborts in-flight HTTP without advancing its checkpoint', async () => {
  await withTempWorkspace(async workspace => {
    const events = new EventService(workspace, new Bus(), async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }))
    await events.start()
    const started = Promise.withResolvers<void>()
    const broker = new CapabilityBroker({ projectId: 'fixture', directory: join(workspace, 'receipts'),
      resolveSecret: async () => undefined, deliver: async () => undefined, canDeliver: () => false,
      request: async (_url, options) => {
        started.resolve()
        const signal = options?.signal
        return await new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      } })
    const sources = new PollingSources(workspace, events, broker, id => id === 'owner', () => false)
    sources.start()
    try {
      events.subscribe({ sessionId: 'owner', event: '*', source: 'custom:cancel-test' })
      sources.create({ id: 'cancel-test', ownerSessionId: 'owner', intervalMs: 86400000,
        grant: { id: 'fetch', kind: 'http', origin: 'https://example.com', routes: [{ method: 'GET', path: '/signal' }] },
        code: `import { fetch } from '@shadow/fetch'; export async function run() { await fetch('/signal'); return {events:[],checkpoint:'advanced'} }` })
      const run = assert.rejects(sources.run('cancel-test', 'owner'))
      await started.promise
      await sources.setEnabled('cancel-test', 'owner', false)
      await run
      assert.equal(sources.inspect('cancel-test', 'owner').checkpoint, null)
      assert.equal(sources.inspect('cancel-test', 'owner').running, false)
    } finally { await sources.stop(); await events.stop() }
  })
})
