import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { FolderRegistry } from '../folders/registry.ts'
import type { FolderRecord } from '../folders/contracts.ts'
import { folderIdentifier } from '../folders/identifier.ts'
import { TopicService, type TopicServiceOptions } from './topics.ts'
import { topicsPlugin } from './topic-routes.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import type { SessionInput } from './input.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { SessionTool } from '../tools/session.ts'
import { SearchTool } from '../tools/search.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { BaseSession } from './base-session.ts'
import { Bus } from '../bus/bus.ts'
import { MessageTool } from '../tools/message.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSessionsHandler } from '../vfs/mounts.ts'

class WebContractSession extends BaseSession {
  run(context: ExecutionContext) {
    return this.runLlmLoop(context, { model: 'synthetic', contextWindow: 32000, temperature: 0 }, context.signal)
  }
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`${storage}: independent topic creation, idempotency, discovery and authorized API`, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const home = await mkdtemp(resolve('.tmp', 'topics-'))
    const folderPath = join(home, 'code')
    await mkdir(folderPath)
    const store: SessionStore = storage === 'jsonl'
      ? new JsonlSessionStore(join(home, 'sessions'))
      : new SqliteSessionStore(join(home, 'sessions'))
    await store.init()
    const folders = new FolderRegistry(home)
    await folders.init()
    const states = new Map<string, SessionState>()
    const deliveries: { sessionId: string; input: SessionInput }[] = []
    const changes: (string | undefined)[] = []
    let failDelivery = false
    let builds = 0
    const sessions: TopicServiceOptions['sessions'] = {
      getSessionState: id => states.get(id) ?? null,
      async buildSession(id, parent, fields) {
        builds++
        assert.equal(parent, undefined)
        assert.equal(fields?.parentSessionId, null)
        assert(!states.has(id))
        const state: SessionState = { sessionId: id, segmentIndex: 0, projectId: 'p', ...fields }
        states.set(id, state)
        await store.saveState(id, state)
      },
      assertFolderAccess(id) { assert(states.has(id)) },
      assertInitiativeAccess(id) { if (id !== 'work') throw new Error('Unknown Project initiative') },
      async updateConversationMetadata(id, topic) {
        const state = states.get(id)
        assert(state)
        state.name = topic.title
        state.description = topic.description
        await store.saveState(id, state)
      },
      async deliver(sessionId, input) {
        if (failDelivery) throw new Error('synthetic mailbox failure')
        deliveries.push({ sessionId, input })
        return { status: 'accepted', sessionId, inputId: input.id }
      },
    }
    const options: TopicServiceOptions = {
      projectId: 'p', sessions, folders, listStates: async () => [...states.values()],
      firstMessage: async id => id === 'web:legacy' ? 'Legacy release readiness' : null,
      resolveAgent: name => ['general', 'explore', 'encapsulator'].includes(name) ? { defaultMode: 'session' } : undefined,
      changed: id => { changes.push(id) },
    }
    const service = new TopicService(options)
    t.after(async () => {
      await store.close?.()
      await rm(home, { recursive: true, force: true })
    })
    await sessions.buildSession('web:chat-admin', undefined, { mode: 'session', agentType: 'general', parentSessionId: null })
    const { folder } = await service.registerFolder(folderPath)
    const request = {
      requestId: randomUUID(), title: 'MCP configuration',
      description: 'MCP configuration and skill declarations',
      folderId: folder.id, initiativeId: 'work', initialMessage: 'Read the selected skill and explain how to configure MCP.',
    }
    const [created, retry] = await Promise.all([
      service.create(request, 'web:chat-admin'), service.create(request, 'web:chat-admin'),
    ])
    assert.equal(created.sessionId, retry.sessionId)
    assert.equal(created.conversationUrl, `/projects/p/chat/${encodeURIComponent(created.sessionId)}`)
    assert.equal(created.initialMessageStatus, 'accepted')
    assert.equal(retry.initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, 1)
    assert.deepEqual(deliveries[0].input.source, { kind: 'session', sessionId: 'web:chat-admin' })
    const saved = states.get(created.sessionId)
    assert(saved)
    assert.equal(saved.parentSessionId, null)
    assert.equal(saved.parent, undefined)
    assert.equal(saved.workspaceRoot, undefined)
    assert.equal(saved.createdBySessionId, 'web:chat-admin')
    assert.equal(saved.workdir?.capabilityId, `local-project-v1:${folder.id}`)
    assert.equal(saved.initiativeId, 'work')
    assert.match(saved.topicRequestHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal((await store.getState(created.sessionId))?.topicRequestHash, saved.topicRequestHash)
    assert.equal(changes.filter(id => id === created.sessionId).length, 1)
    await assert.rejects(service.create({ ...request, description: 'Different description' }, 'web:chat-admin'), /requestId/)
    const restartedService = new TopicService(options)
    assert.equal((await restartedService.create(request, 'web:chat-admin')).initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, 1)
    assert.equal(builds, 2)

    const plain = await service.create({ title: 'Discussion' })
    assert.equal(states.get(plain.sessionId)?.topic, undefined)
    assert.equal(states.get(plain.sessionId)?.sessionKind, undefined)
    await assert.rejects(service.create({ title: 'No duplicate goal', goal: 'Not a metadata field' }))
    assert.equal(states.get(plain.sessionId)?.folderId, undefined)
    const worker: SessionState = { sessionId: 'task:worker', projectId: 'p', segmentIndex: 0, mode: 'task' }
    states.set(worker.sessionId, worker)
    assert.throws(() => service.assertActor('q', plain.sessionId), /owning Project/)
    assert.throws(() => service.assertActor('p', 'foreign:session'), /does not belong/)
    await assert.rejects(service.create(request, worker.sessionId), /Temporary tasks/)
    await assert.rejects(service.create({ ...request, agentType: 'missing' }), /Unknown agent/)
    await assert.rejects(service.create({ ...request, requestId: randomUUID(), folderId: randomUUID() }), /folder/i)
    const matches = await service.search({ query: 'MCP skill' })
    assert.equal(matches.totalMatches, 1)
    assert.equal(matches.sessions[0].sessionId, created.sessionId)
    const page = await service.search({ limit: 1 })
    assert.equal(page.hasMore, true)
    assert.equal(page.nextOffset, 1)
    assert.equal((await service.search({ offset: 1 })).sessions.length, 2)
    const legacy: SessionState = { sessionId: 'web:legacy', projectId: 'p', segmentIndex: 0, mode: 'session' }
    states.set(legacy.sessionId, legacy)
    const legacyMatches = await service.search({ query: 'release readiness' })
    assert.equal(legacyMatches.sessions[0].sessionId, legacy.sessionId)
    assert.equal(legacyMatches.sessions[0].metadataSource, 'first_message')
    assert(!(await service.search()).sessions.some(topic => topic.sessionId === worker.sessionId))
    await assert.rejects(service.search({ limit: 21 }))
    await assert.rejects(service.search({ offset: -1 }))

    await assert.rejects(service.update({ sessionId: created.sessionId, title: 'Hijack' }, plain.sessionId), /Only this session/)
    await service.update({ sessionId: created.sessionId, title: 'MCP session', description: request.description }, created.sessionId)
    assert.equal(states.get(created.sessionId)?.name, 'MCP session')

    const tools = new SessionTools(new Tools(home), home)
    const context: ExecutionContext = {
      projectId: 'p', sessionId: 'web:chat-admin', physicalSessionId: 'fixture',
      channel: 'web', chatId: 'chat-admin', senderId: 'user', messageId: 'm',
      tools, signal: new AbortController().signal,
    }
    const vfs = new VirtualFs()
    const handlers = createSessionsHandler({
      getSessionState: sessions.getSessionState,
      listSessions: () => [],
      getHistory: async () => ({ messages: [], total: 0 }),
    }, () => service)
    vfs.mount('v:sessions', 'Sessions', handlers.read, handlers.list)
    const search = new SearchTool(home, undefined, vfs)
    assert.match(await search.execute({ handler: 'grep', path: 'v:sessions', query: 'MCP' }, context), new RegExp(`${created.sessionId}/brief`))
    assert.equal(JSON.parse((await vfs.resolve(`v:sessions/${created.sessionId}/brief`, context))!).conversationUrl, created.conversationUrl)
    await assert.rejects(search.execute({ handler: 'glob', path: 'v:sessions', query: '**' }, { ...context, projectId: 'other' }), /Project/)
    const remoteContext = { ...context, sessionId: worker.sessionId, remoteWorkdir: {
      nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not access remote executor') },
    } }
    assert.match(await search.execute({ handler: 'grep', path: 'v:sessions', query: 'MCP' }, remoteContext), /\/brief/)
    const tool = new SessionTool(service)
    const describedPath = join(folderPath, 'described-folder')
    await mkdir(describedPath)
    const registered = JSON.parse(await tool.execute({ action: 'register_folder', path: describedPath, description: 'Tool registration metadata' }, context))
    assert.equal(registered.folder.description, 'Tool registration metadata')
    await assert.rejects(tool.execute({ action: 'register_folder', path: describedPath, description: 42 }, context), /description must be a string/)
    await assert.rejects(tool.execute({ action: 'register_folder', path: folderPath }, { ...context, sessionId: worker.sessionId }), /Temporary/)
    await assert.rejects(tool.execute({ action: 'register_folder', path: folderPath, extra: 1 }, context), /only path/)
    await assert.rejects(tool.execute({ action: 'create', title: 'x', goal: 'y', scope: 'z', projectId: 'other' }, context))

    const app = new Hono()
    topicsPlugin(service, req => req.headers.get('authorization') === 'fixture')(app)
    assert.equal((await app.request('/api/sessions/discover')).status, 401)
    const headers = { authorization: 'fixture', 'content-type': 'application/json' }
    assert.equal((await app.request('/api/sessions/discover?limit=NaN', { headers })).status, 400)
    assert.equal((await app.request('/api/sessions', { method: 'POST', headers, body: '{"projectId":"other"}' })).status, 400)
    assert.equal((await app.request('/api/sessions', { method: 'POST', headers, body: '{' })).status, 400)
    const trustedRequest = new Request('http://127.0.0.1/api/sessions', {
      method: 'POST', headers, body: '{"projectId":"other"}',
    })
    const trustedApp = new Hono()
    topicsPlugin(service, req => req === trustedRequest)(trustedApp)
    assert.equal((await trustedApp.request(trustedRequest)).status, 400,
      'Authorize the trusted request before the body limiter can clone it')
    const list = await app.request('/api/sessions/discover?query=MCP', { headers })
    assert.equal((await list.json()).totalMatches, 1)

    const bus = new Bus()
    t.after(() => bus.stopAll())
    const base = new Tools(home)
    base.register(new SearchTool(home, undefined, vfs))
    base.register(new SessionTool(service))
    base.register(new MessageTool(bus, () => true, () => undefined, () => [], sessions.deliver,
      (from, to) => states.has(from) && states.has(to)))
    const adminTools = new SessionTools(base, home, ['search', 'session', 'message'])
    let turn = 0
    let routedSessionId = ''
    const provider: LLMProvider = {
      name: 'synthetic', listModels: () => ['synthetic'],
      async chat(messages, definitions) {
        assert(!definitions.some(tool => ['invoke_tool', 'exec', 'write', 'subagent'].includes(tool.function.name)))
        turn++
        const lastResult = messages.filter(message => message.role === 'tool').at(-1)
        if (turn === 1) return {
          content: '', finishReason: 'tool_calls',
          toolCalls: [{ id: 'find-topic', name: 'search', arguments: { handler: 'grep', path: 'v:sessions', query: 'LLM routing' } }],
        }
        assert(lastResult)
        if (turn === 2) {
          assert.equal(String(lastResult.content), 'No matches found')
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'create-topic', name: 'session', arguments: {
              action: 'create', title: 'LLM routing', description: 'Routing investigation',
              folderId: folder.id, initialMessage: 'Investigate the routing contract and report here.',
            } }],
          }
        }
        if (turn === 3) {
          const receipt = JSON.parse(String(lastResult.content))
          routedSessionId = receipt.sessionId
          assert.equal(receipt.initialMessageStatus, 'accepted')
          assert.equal(states.get(routedSessionId)?.parentSessionId, null)
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'context-message', name: 'message', arguments: {
              sessionId: routedSessionId, intent: 'question', content: 'Confirm your boundary before changing shared files.',
            } }],
          }
        }
        assert.match(String(lastResult.content), /admission only/)
        return { content: `Continue in ${routedSessionId}`, finishReason: 'stop', toolCalls: [] }
      },
    }
    const adminState = states.get('web:chat-admin')
    assert(adminState)
    const loop = new WebContractSession(home, adminState.sessionId, adminState, [], provider, adminTools, bus, store)
    await store.createSessionLog(loop.physicalSessionId, [])
    assert.equal(await loop.run({ ...context, tools: adminTools, physicalSessionId: loop.physicalSessionId }), `Continue in ${routedSessionId}`)
    assert.equal(turn, 4)
    assert.equal(deliveries.filter(delivery => delivery.sessionId === routedSessionId).length, 2)
    const records = []
    for await (const record of store.readSessionLog(loop.physicalSessionId)) records.push(record)
    assert.match(JSON.stringify(records), /find-topic/)
    assert.match(JSON.stringify(records), /create-topic/)
    assert.match(JSON.stringify(records), /context-message/)
    assert.match(JSON.stringify(records), /admission only/)
    adminTools.resetDynamic()

    const deliveryCount = deliveries.length
    failDelivery = true
    const failing = { ...request, requestId: randomUUID() }
    await assert.rejects(service.create(failing, 'web:chat-admin'), /was created.*not confirmed accepted/)
    failDelivery = false
    assert.equal((await service.create(failing, 'web:chat-admin')).initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, deliveryCount)

    const selectorRequest = { requestId: randomUUID(), title: 'Persisted selector', folderId: 'code', initialMessage: 'One kickoff' }
    const selected = await service.create(selectorRequest, 'web:chat-admin')
    const persisted = await store.getState(selected.sessionId)
    assert(persisted)
    assert.equal(persisted.folderId, folder.id)
    states.set(selected.sessionId, persisted)
    const retryWithoutRegistry = new TopicService({ ...options, folders: {
      ...options.folders,
      register: options.folders.register.bind(options.folders),
      acquireAccess: options.folders.acquireAccess.bind(options.folders),
      list: () => { throw new Error('Retries must not re-resolve selectors') },
      requireAvailable: async () => { throw new Error('Retries must not retarget folders') },
    } })
    const selectedDeliveryCount = deliveries.length
    assert.equal((await retryWithoutRegistry.create(selectorRequest, 'web:chat-admin')).initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, selectedDeliveryCount)
  })
}

test('session tool resolves Project selectors across nodes without fallback and pins exact retries', async () => {
  const local: FolderRecord = { id: randomUUID(), name: 'Code', path: '/synthetic/local', createdAt: new Date().toISOString() }
  const remote: FolderRecord = {
    id: randomUUID(), name: 'Remote App', path: '/opaque/not-on-main', createdAt: local.createdAt, kind: 'remote',
    workdir: { version: 1, nodeId: 'child-a', capabilityId: 'remote-capability' },
    identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
  }
  const otherRemote: FolderRecord = {
    ...remote, id: randomUUID(), name: 'Code',
    workdir: { version: 1 as const, nodeId: 'child-b', capabilityId: 'other-capability' },
  }
  let records: FolderRecord[] = [local, remote]
  const states = new Map<string, SessionState>([['web:actor', {
    sessionId: 'web:actor', segmentIndex: 0, projectId: 'p', mode: 'session',
    workdir: { version: 1, nodeId: 'caller-node', capabilityId: 'caller-cap' },
  }]])
  let offline = false
  let builds = 0
  let deliveries = 0
  let lookups = 0
  const options: TopicServiceOptions = {
    projectId: 'p', listStates: async () => [...states.values()], resolveAgent: () => ({ defaultMode: 'session' }), changed() {},
    folders: {
      list: () => records,
      acquireAccess: () => () => {},
      register: async () => { throw new Error('Not used') },
      requireAvailable: async id => {
        lookups++
        if (offline) throw new Error('node-offline')
        const folder = records.find(record => record.id === id)
        assert(folder)
        return folder
      },
    },
    sessions: {
      getSessionState: id => states.get(id) ?? null,
      assertFolderAccess: id => { assert(states.has(id)) },
      assertInitiativeAccess() {},
      updateConversationMetadata: async () => {},
      buildSession: async (id, _parent, fields) => {
        builds++
        states.set(id, { sessionId: id, segmentIndex: 0, projectId: 'p', ...fields })
      },
      deliver: async (sessionId, input) => { deliveries++; return { status: 'accepted', sessionId, inputId: input.id } },
    },
  }
  const service = new TopicService(options)
  const tool = new SessionTool(service)
  const context = {
    projectId: 'p', sessionId: 'web:actor', signal: new AbortController().signal,
    remoteWorkdir: { nodeId: 'caller-node', capabilityId: 'caller-cap' },
  } as ExecutionContext
  const create = async (folderId?: string) => {
    const result = JSON.parse(await tool.execute({ action: 'create', title: 'Selector', ...(folderId ? { folderId } : {}) }, context))
    return states.get(result.sessionId)!
  }
  for (const selector of ['code', folderIdentifier(local.id, local.name), local.id]) {
    const state = await create(selector)
    assert.equal(state.folderId, local.id)
    assert.equal(state.workdir?.nodeId, 'local')
    assert.equal(state.workdir?.capabilityId, `local-project-v1:${local.id}`)
  }
  for (const selector of ['remote-app', folderIdentifier(remote.id, remote.name), remote.id]) {
    const state = await create(selector)
    assert.equal(state.folderId, remote.id)
    assert.deepEqual(state.workdir, remote.workdir)
  }
  const discussion = await create()
  assert.equal(discussion.folderId, undefined)
  assert.equal(discussion.workdir, undefined)

  records.push(otherRemote)
  const beforeRejected = builds
  for (const selector of ['code', 'unknown', '/opaque/not-on-main', randomUUID()]) {
    await assert.rejects(create(selector), /Unknown or ambiguous/)
  }
  offline = true
  await assert.rejects(create('remote-app'), /node-offline/)
  assert.equal(builds, beforeRejected)
  offline = false
  for (const folder of [local, otherRemote]) {
    for (const selector of [folderIdentifier(folder.id, folder.name), folder.id]) {
      const state = await create(selector)
      assert.equal(state.folderId, folder.id)
      assert.equal(state.workdir?.nodeId, folder.kind === 'remote' ? folder.workdir.nodeId : 'local')
    }
  }

  const request = { requestId: randomUUID(), title: 'Pinned', folderId: 'remote-app', initialMessage: 'Once' }
  const [first, retry] = await Promise.all([service.create(request, 'web:actor'), service.create(request, 'web:actor')])
  assert.equal(first.sessionId, retry.sessionId)
  assert.equal(retry.initialMessageStatus, 'not_replayed')
  assert.equal(deliveries, 1)
  const beforeRetry = { builds, lookups }
  // The selector now names a different node. A restarted service must use the
  // persisted request hash before resolution and must never replay the kickoff.
  records = [local, { ...otherRemote, name: 'Remote App' }]
  offline = true
  const restarted = new TopicService(options)
  const persistedRetry = await restarted.create(request, 'web:actor')
  assert.equal(persistedRetry.sessionId, first.sessionId)
  assert.equal(persistedRetry.folderId, remote.id)
  assert.deepEqual(states.get(first.sessionId)?.workdir, remote.workdir)
  assert.deepEqual({ builds, lookups }, beforeRetry)
  assert.equal(deliveries, 1)
  await assert.rejects(restarted.create({ ...request, folderId: otherRemote.id }, 'web:actor'), /requestId/)
  await assert.rejects(tool.execute({ action: 'create', title: 'No node override', folderId: local.id, nodeId: 'child-b' }, context))
  assert.equal(builds, beforeRetry.builds)
})
