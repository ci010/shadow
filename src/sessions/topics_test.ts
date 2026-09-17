import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { FolderRegistry } from '../folders/registry.ts'
import { TopicService, type TopicServiceOptions } from './topics.ts'
import { topicsPlugin } from './topic-routes.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import type { SessionInput } from './input.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { TopicTool } from '../tools/topic.ts'
import { SearchTool } from '../tools/search.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { topicProvider } from '../agent/context/topic.ts'
import { BaseSession } from './base-session.ts'
import { Bus } from '../bus/bus.ts'
import { MessageTool } from '../tools/message.ts'
import type { LLMProvider } from '../providers/provider.ts'

class CoordinatorContractSession extends BaseSession {
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
      async updateTopicMetadata(id, topic) {
        const state = states.get(id)
        assert(state)
        state.topic = topic
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
      firstMessage: async () => 'Legacy release readiness',
      resolveAgent: name => ['general', 'orchestrator', 'explore', 'encapsulator'].includes(name) ? { defaultMode: 'session' } : undefined,
      changed: id => { changes.push(id) },
    }
    const service = new TopicService(options)
    t.after(async () => {
      await store.close?.()
      await rm(home, { recursive: true, force: true })
    })
    const coordinator = await Promise.all(Array.from({ length: 8 }, () => service.ensureOrchestrator()))
    assert(coordinator.every(item => item.sessionId === 'web:orchestrator'))
    assert.equal(builds, 1)
    assert.equal(states.get('web:orchestrator')?.folderId, undefined)
    const { folder } = await service.registerFolder(folderPath)
    const request = {
      requestId: randomUUID(), title: 'MCP configuration', goal: 'Explain lazy tool setup',
      scope: 'MCP configuration and skill declarations', nonGoals: 'Provider changes',
      folderId: folder.id, initiativeId: 'work', initialMessage: 'Read the selected skill and explain how to configure MCP.',
    }
    const [created, retry] = await Promise.all([
      service.create(request, 'web:orchestrator'), service.create(request, 'web:orchestrator'),
    ])
    assert.equal(created.sessionId, retry.sessionId)
    assert.equal(created.conversationUrl, `/projects/p/chat/${encodeURIComponent(created.sessionId)}`)
    assert.equal(created.initialMessageStatus, 'accepted')
    assert.equal(retry.initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, 1)
    assert.deepEqual(deliveries[0].input.source, { kind: 'session', sessionId: 'web:orchestrator' })
    const saved = states.get(created.sessionId)
    assert(saved)
    assert.equal(saved.parentSessionId, null)
    assert.equal(saved.parent, undefined)
    assert.equal(saved.workspaceRoot, undefined)
    assert.equal(saved.createdBySessionId, 'web:orchestrator')
    assert.equal(saved.workdir?.capabilityId, `local-project-v1:${folder.id}`)
    assert.equal(saved.initiativeId, 'work')
    assert.match(saved.topicRequestHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal((await store.getState(created.sessionId))?.topicRequestHash, saved.topicRequestHash)
    assert.equal(changes.filter(id => id === created.sessionId).length, 1)
    await assert.rejects(service.create({ ...request, goal: 'Different goal' }, 'web:orchestrator'), /requestId/)
    const restartedService = new TopicService(options)
    assert.equal((await restartedService.create(request, 'web:orchestrator')).initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, 1)
    assert.equal((await restartedService.ensureOrchestrator()).sessionId, 'web:orchestrator')
    assert.equal(builds, 2)

    const plain = await service.create({ title: 'Discussion', goal: 'Clarify requirements', scope: '' })
    assert.equal(states.get(plain.sessionId)?.folderId, undefined)
    const worker: SessionState = { sessionId: 'task:worker', projectId: 'p', segmentIndex: 0, mode: 'task' }
    states.set(worker.sessionId, worker)
    assert.throws(() => service.assertActor('q', plain.sessionId), /owning Project/)
    assert.throws(() => service.assertActor('p', 'foreign:session'), /does not belong/)
    await assert.rejects(service.create(request, worker.sessionId), /Temporary tasks/)
    await assert.rejects(service.create({ ...request, agentType: 'orchestrator' }), /existing Project coordinator/)
    await assert.rejects(service.create({ ...request, agentType: 'missing' }), /Unknown agent/)
    await assert.rejects(service.create({ ...request, requestId: randomUUID(), folderId: randomUUID() }), /folder/i)
    const matches = await service.search({ query: 'MCP skill' })
    assert.equal(matches.totalMatches, 1)
    assert.equal(matches.topics[0].sessionId, created.sessionId)
    const page = await service.search({ limit: 1 })
    assert.equal(page.hasMore, true)
    assert.equal(page.nextOffset, 1)
    assert.equal((await service.search({ offset: 1 })).topics.length, 1)
    const legacy: SessionState = { sessionId: 'web:legacy', projectId: 'p', segmentIndex: 0, mode: 'session' }
    states.set(legacy.sessionId, legacy)
    const legacyMatches = await service.search({ query: 'release readiness' })
    assert.equal(legacyMatches.topics[0].sessionId, legacy.sessionId)
    assert.equal(legacyMatches.topics[0].briefSource, 'first_message')
    assert(!(await service.search()).topics.some(topic => topic.sessionId === worker.sessionId))
    await assert.rejects(service.search({ limit: 21 }))
    await assert.rejects(service.search({ offset: -1 }))

    await assert.rejects(service.update({ sessionId: created.sessionId, title: 'Hijack', goal: 'x', scope: 'y' }, plain.sessionId), /Only this topic/)
    await service.update({ sessionId: created.sessionId, title: 'MCP topic', goal: request.goal, scope: request.scope }, 'web:orchestrator')
    assert.equal(states.get(created.sessionId)?.topic?.title, 'MCP topic')
    const prompt = topicProvider(sessions.getSessionState).getPromptSection({
      sessionId: created.sessionId, projectId: 'p', mode: 'session', behavior: {}, channel: 'web', chatId: created.chatId!,
      agent: { name: 'general', defaultMode: 'session', prompt: '', source: 'builtin', description: '' },
    })
    assert.match(String(prompt), /MCP topic/)
    assert.match(String(prompt), /assignments.*authority/)

    const tools = new SessionTools(new Tools(home), home)
    const context: ExecutionContext = {
      projectId: 'p', sessionId: 'web:orchestrator', physicalSessionId: 'fixture',
      channel: 'web', chatId: 'orchestrator', senderId: 'user', messageId: 'm',
      tools, signal: new AbortController().signal,
    }
    const search = new SearchTool(home, undefined, undefined, undefined, undefined, () => service)
    assert.equal(JSON.parse(await search.execute({ space: 'sessions:', query: 'MCP' }, context)).totalMatches, 1)
    await assert.rejects(search.execute({ space: 'sessions:' }, { ...context, projectId: 'other' }), /Project/)
    const tool = new TopicTool(service)
    await assert.rejects(tool.execute({ action: 'register_folder', path: folderPath }, { ...context, sessionId: worker.sessionId }), /Temporary/)
    await assert.rejects(tool.execute({ action: 'register_folder', path: folderPath, extra: 1 }, context), /only path/)
    await assert.rejects(tool.execute({ action: 'create', title: 'x', goal: 'y', scope: 'z', projectId: 'other' }, context))

    const app = new Hono()
    topicsPlugin(service, req => req.headers.get('authorization') === 'fixture')(app)
    assert.equal((await app.request('/api/topics')).status, 401)
    assert.equal((await app.request('/api/orchestrator', { method: 'POST' })).status, 401)
    const headers = { authorization: 'fixture', 'content-type': 'application/json' }
    const response = await app.request('/api/orchestrator', { method: 'POST', headers })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).sessionId, 'web:orchestrator')
    assert.equal((await app.request('/api/topics?limit=NaN', { headers })).status, 400)
    assert.equal((await app.request('/api/topics', { method: 'POST', headers, body: '{"projectId":"other"}' })).status, 400)
    assert.equal((await app.request('/api/topics', { method: 'POST', headers, body: '{' })).status, 400)
    const list = await app.request('/api/topics?query=MCP', { headers })
    assert.equal((await list.json()).totalMatches, 1)

    const bus = new Bus()
    t.after(() => bus.stopAll())
    const base = new Tools(home)
    base.register(new SearchTool(home, undefined, undefined, undefined, undefined, () => service))
    base.register(new TopicTool(service))
    base.register(new MessageTool(bus, () => true, () => undefined, () => [], sessions.deliver,
      (from, to) => states.has(from) && states.has(to)))
    const coordinatorTools = new SessionTools(base, home, ['search', 'topic', 'message'])
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
          toolCalls: [{ id: 'find-topic', name: 'search', arguments: { space: 'sessions:', query: 'LLM routing' } }],
        }
        assert(lastResult)
        if (turn === 2) {
          assert.equal(JSON.parse(String(lastResult.content)).totalMatches, 0)
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'create-topic', name: 'topic', arguments: {
              action: 'create', title: 'LLM routing', goal: 'Explain a routing change', scope: 'Routing only',
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
    const coordinatorState = states.get('web:orchestrator')
    assert(coordinatorState)
    const loop = new CoordinatorContractSession(home, coordinatorState.sessionId, coordinatorState, [], provider, coordinatorTools, bus, store)
    await store.createSessionLog(loop.physicalSessionId, [])
    assert.equal(await loop.run({ ...context, tools: coordinatorTools, physicalSessionId: loop.physicalSessionId }), `Continue in ${routedSessionId}`)
    assert.equal(turn, 4)
    assert.equal(deliveries.filter(delivery => delivery.sessionId === routedSessionId).length, 2)
    const records = []
    for await (const record of store.readSessionLog(loop.physicalSessionId)) records.push(record)
    assert.match(JSON.stringify(records), /find-topic/)
    assert.match(JSON.stringify(records), /create-topic/)
    assert.match(JSON.stringify(records), /context-message/)
    assert.match(JSON.stringify(records), /admission only/)
    coordinatorTools.resetDynamic()

    const deliveryCount = deliveries.length
    failDelivery = true
    const failing = { ...request, requestId: randomUUID() }
    await assert.rejects(service.create(failing, 'web:orchestrator'), /was created.*not confirmed accepted/)
    failDelivery = false
    assert.equal((await service.create(failing, 'web:orchestrator')).initialMessageStatus, 'not_replayed')
    assert.equal(deliveries.length, deliveryCount)
  })
}
