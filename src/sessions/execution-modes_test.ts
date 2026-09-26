import { ReplyTool } from '../tools/reply.ts'
import { requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import type { LLMProvider, LLMResponse, ChatMessage } from '../providers/provider.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { SubagentTool } from '../tools/subagent.ts'
import { MessageTool } from '../tools/message.ts'
import { AskTool } from '../tools/ask.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { EventService } from '../events/service.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { decisionBrief } from '../testing/decision.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import type { SessionStore } from './session-store.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionMessageInput, SessionTurnFact } from './input.ts'
import { sessionsApiPlugin } from './routes.ts'
import { CallTools } from './call-tools.ts'
import { ExecTool } from '../tools/shell.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import type { ManagedProcessStatus } from '../execution/processes/manager.ts'
import { managedSessionWorkdirRef, resolveSessionLocations } from './locality.ts'
import { parseTopicMetadata } from './topic-contract.ts'
import { physicalSessionId } from './session-identity.ts'

const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const question = { kind: 'decision', question: 'Choose a path', options: ['A', 'B', 'C'], default_option: 'A', brief: decisionBrief }
const done = (content = 'Final'): LLMResponse => ({ content, toolCalls: [] })
const invoke = (name: string, args: Record<string, unknown>, id: string = crypto.randomUUID()): LLMResponse =>
  ({ content: '', toolCalls: [{ name, arguments: args, id }] })
const input = (content: string, policy: SessionMessageInput['policy'] = 'queue'): SessionMessageInput => ({
  kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), content, policy,
  source: { kind: 'event', eventId: crypto.randomUUID(), type: 'fixture', source: 'fixture' },
})

async function waitFor(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < end, 'Execution fixture timed out'); await delay(2) }
}

function fixture(workspace: string, store: SessionStore, settings: {
  callTimeoutMs?: number; ignoreAbort?: boolean; hasInitiative?: (id: string) => boolean
} = {}) {
  const requests: Array<{
    sessionId: string; messages: ChatMessage[]; names: string[]; signal: AbortSignal; model?: string; settled: boolean
    resolve: (response: LLMResponse) => void; reject: (error: Error) => void
  }> = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, definitions, options) {
      const pending = Promise.withResolvers<LLMResponse>()
      const signal = options!.signal!
      const request = {
        // Fixture identity precedes any per-inference runtime guidance.
        sessionId: JSON.parse(String(messages[0]!.content).split('\n', 1)[0]).sessionId as string,
        messages: structuredClone(messages), names: definitions.map(def => def.function.name),
        signal, model: options?.model, settled: false,
        resolve: (response: LLMResponse) => { request.settled = true; pending.resolve(response) },
        reject: (error: Error) => { request.settled = true; pending.reject(error) },
      }
      const abort = () => { if (!settings.ignoreAbort) request.reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      requests.push(request)
      try { signal.throwIfAborted(); return await pending.promise }
      finally { request.settled = true; signal.removeEventListener('abort', abort) }
    },
  }
  const bus = new Bus()
  const facts: SessionTurnFact[] = []
  const reports: Array<Parameters<EventService['emit']>[0]> = []
  bus.on('session.turn.finished', fact => { facts.push(fact) })
  const tools = new Tools(workspace)
  const agentTypes = {
    resolve: (name: string) => ({
      name, description: '', prompt: '', source: 'builtin',
      root: name === 'sub',
      defaultMode: name === 'verify' ? 'task' : 'session',
      ...(name === 'limited' ? { allowedTools: ['subagent', 'ask', 'reply', 'message', 'read'] } : {}),
    }),
    allNames: () => ['general', 'sub', 'limited', 'verify'],
  } as unknown as AgentTypesManager
  const events: EventService = new EventService(workspace, bus, (id, value) => sessions.deliver(id, value))
  const emit = events.emit.bind(events)
  events.emit = async value => { reports.push(value); await emit(value) }
  const sessions: SessionManager = new SessionManager({
    workspace, store, provider, bus, tools, agentTypes, events,
    handoffManager: { shouldHandoff: () => false },
    context: { buildSystemPrompt: async (ctx: any) => JSON.stringify({ sessionId: ctx.sessionId, mode: ctx.mode, role: ctx.agent.name }) },
    getLlmRuntimeConfig: () => llm, callTimeoutMs: settings.callTimeoutMs,
    hasInitiative: settings.hasInitiative,
  } as unknown as SessionManagerDeps)
  const subagent = new SubagentTool(bus, sessions, agentTypes, { createThread: async () => null } as unknown as ChannelManager)
  tools.register(subagent)
  tools.register(new AskTool(sessions.yields, sessions.inputs))
  tools.register(new ReplyTool(sessions.yields, sessions.inputs))
  tools.register(new InvokeTool())
  tools.register(new MessageTool(bus, id => sessions.canReceiveSessionMessage(id),
    id => sessions.getSessionState(id)?.parent, id => sessions.getSessionState(id)?.children,
    (id, value) => sessions.deliver(id, value), (source, target) => sessions.canSendSessionMessage(source, target)))
  for (const name of ['read', 'dangerous', 'exec', 'cron', 'event_subscribe', 'continuation', 'cancel']) tools.register({
    name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => name,
  })
  async function next(id: string) {
    await waitFor(() => requests.some(request => request.sessionId === id && !request.settled))
    return requests.find(request => request.sessionId === id && !request.settled)!
  }
  async function spawn() {
    await sessions.deliver('web:root', input('Parent-only history sentinel'))
    ;(await next('web:root')).resolve(invoke('subagent', {
      description: 'Independent work', mode: 'task', agent_type: 'limited', task: 'Fresh task',
    }, 'task-1'))
    const parent = await next('web:root')
    const receipt = JSON.parse(String(parent.messages.find(message => message.tool_call_id === 'task-1')!.content))
    assert.equal(receipt.executionId, receipt.sessionId)
    assert.equal(Object.hasOwn(receipt, 'result'), false)
    return { child: receipt.sessionId as string, parent }
  }
  return { sessions, requests, reports, facts, subagent, tools, bus, next, spawn }
}

function sourceContext(workspace: string, f: ReturnType<typeof fixture>): ExecutionContext {
  return {
    sessionId: 'web:root', physicalSessionId: 'web_root-0', channel: 'web', chatId: 'root',
    senderId: 'fixture', messageId: crypto.randomUUID(), signal: new AbortController().signal,
    tools: new SessionTools(f.tools, workspace),
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: concurrent explicit and implicit creation cannot replace admitted state or history`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await assert.rejects(f.sessions.deliver('web:orchestrator', input('Implicit coordinator')), /canonical configuration/)
        assert.equal(await store.countSessionLog('web_orchestrator-0'), 0)
        for (const id of ['web:race', 'web:orchestrator']) {
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const originalCreate = store.createSessionLog.bind(store)
          let creates = 0
          store.createSessionLog = async (physicalId, events) => {
            creates++
            entered.resolve()
            await release.promise
            await originalCreate(physicalId, events)
          }
          const fields = {
            mode: 'session' as const,
            sessionKind: id === 'web:orchestrator' ? 'orchestrator' as const : 'topic' as const,
            agentType: id === 'web:orchestrator' ? 'orchestrator' : 'general',
            topic: { title: 'Original brief', goal: 'Original goal', scope: '' },
          }
          const creation = f.sessions.buildSession(id, undefined, fields)
          await entered.promise
          const duplicate = assert.rejects(f.sessions.buildSession(id, undefined, {
            ...fields, topic: { ...fields.topic, title: 'Conflicting brief' },
          }), /existing session/)
          const implicit = f.sessions.deliver(id, input('Admitted user message'))
          await delay(1)
          try {
            assert.equal(creates, 1)
            assert.equal(f.sessions.getSessionState(id), null)
          } finally { release.resolve() }
          await Promise.all([creation, duplicate, implicit])
          assert.equal(creates, 1)
          store.createSessionLog = originalCreate
          assert.equal((await store.getState(id))?.topic?.title, 'Original brief')
          const request = await f.next(id)
          request.resolve(done('Preserved reply'))
          await waitFor(() => f.facts.some(fact => fact.sessionId === id))
          const history = await f.sessions.getHistory(id)
          await assert.rejects(f.sessions.buildSession(id, undefined, fields), /existing session/)
          assert.deepEqual(await f.sessions.getHistory(id), history)
        }
        const save = store.saveState.bind(store)
        store.saveState = async (id, state) => {
          if (id === 'web:failed-create') throw new Error('Synthetic write failure')
          await save(id, state)
        }
        await assert.rejects(f.sessions.buildSession('web:failed-create'), /Synthetic write failure/)
        assert.equal(f.sessions.getSessionState('web:failed-create'), null)
        store.saveState = save
        await f.sessions.buildSession('web:failed-create')
        assert.equal(f.sessions.getSessionState('web:failed-create')?.mode, 'session')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: coordinator capabilities remain pinned despite custom role overrides`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const deps = (f.sessions as any).deps as SessionManagerDeps
      const resolve = deps.agentTypes.resolve.bind(deps.agentTypes)
      deps.agentTypes.resolve = name => {
        const role = resolve(name)
        return name === 'orchestrator' && role ? { ...role, allowedTools: ['exec', 'invoke_tool', 'subagent'] } : role
      }
      for (const name of ['search', 'session', 'work', 'initiative', 'project_config', 'skill_read', 'skill_save']) {
        f.tools.register({ name, description: name, optIn: name === 'initiative',
          parameters: { type: 'object', properties: {} }, execute: async () => name })
      }
      const allowed = ['ask', 'message', 'project_config', 'read', 'reply', 'search', 'session', 'skill_read', 'skill_save', 'work']
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:orchestrator', undefined, { mode: 'session', agentType: 'orchestrator', sessionKind: 'orchestrator' })
        assert.deepEqual(f.sessions.getToolDefinitions('web:orchestrator').map(tool => tool.name).sort(), allowed)
        assert.deepEqual(f.sessions.getToolDefinitions('web:orchestrator', { allowedTools: ['exec'] }).map(tool => tool.name).sort(), allowed)
        assert.throws(() => f.sessions.assertCanCreateChild('web:orchestrator', 'task'), /role does not permit/)
        await f.sessions.deliver('web:orchestrator', input('Coordinate this Project'))
        const request = await f.next('web:orchestrator')
        assert.deepEqual(request.names.sort(), allowed)
        request.resolve(invoke('exec', { command: 'not actually executed' }, 'denied'))
        const resumed = await f.next('web:orchestrator')
        assert.match(String(resumed.messages.find(message => message.tool_call_id === 'denied')?.content), /not available|not found|not allowed|Unknown tool/i)
        resumed.resolve(done('Coordinated'))
        await waitFor(() => f.facts.some(fact => fact.sessionId === 'web:orchestrator'))
        await f.sessions.stop()
        await f.sessions.start()
        assert.deepEqual(f.sessions.getToolDefinitions('web:orchestrator').map(tool => tool.name).sort(), allowed)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: topic metadata validates, replaces, persists and canonical coordinator cannot be aliased`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const topic = { title: 'Topic', goal: 'Finish a goal', scope: '', nonGoals: 'Unrelated work' }
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:orchestrator', undefined, { mode: 'session', agentType: 'orchestrator', sessionKind: 'orchestrator' })
        for (const fields of [{ agentType: 'orchestrator' }, { sessionKind: 'orchestrator' as const }]) {
          await assert.rejects(f.sessions.buildSession('web:alias', undefined, fields), /orchestrator/)
        }
        await f.sessions.buildSession('web:topic', undefined, {
          mode: 'session', parentSessionId: null, sessionKind: 'topic', topic, createdBySessionId: 'web:orchestrator',
          topicRequestHash: 'a'.repeat(64),
        })
        for (const invalid of [null, [], {}, { ...topic, title: ' ' }, { ...topic, goal: '' },
          { ...topic, title: 'x'.repeat(201) }, { ...topic, scope: 'x'.repeat(8001) },
          { ...topic, nonGoals: 1 }, { ...topic, unexpected: true }]) {
          assert.throws(() => parseTopicMetadata(invalid))
        }
        await assert.rejects(f.sessions.updateConversationMetadata('web:topic', { title: '' }))
        await assert.rejects(f.sessions.updateConversationMetadata('web:topic', { title: 'Valid', description: 'x'.repeat(4001) }))
        await assert.rejects(f.sessions.updateConversationMetadata('web:orchestrator', { title: 'Forbidden' }), /ordinary/)
        await assert.rejects(f.sessions.buildSession('web:foreign', undefined, { topic, createdBySessionId: 'web:missing' }), /project/)
        await assert.rejects(store.saveState('web:invalid', { sessionId: 'web:invalid', segmentIndex: 0, topic: { ...topic, goal: '' } }))
        const replacement = { title: 'Replacement', description: 'Discovery metadata, not a new goal' }
        await Promise.all([
          f.sessions.updateConversationMetadata('web:topic', { ...replacement, title: 'Previous replacement' }),
          f.sessions.updateConversationMetadata('web:topic', replacement),
        ])
        assert.equal(f.sessions.listSessions().find(s => s.sessionId === 'web:topic')?.description, replacement.description)
        assert.equal((await f.sessions.getSessionDetails('web:topic'))?.description, replacement.description)
        assert.equal((await f.sessions.getSessionDetails('web:topic'))?.name, replacement.title)
        assert.deepEqual((await store.listSessions()).find(s => s.sessionId === 'web:topic')?.topic, topic, 'Historical metadata is preserved, not another editable goal')
        await f.sessions.stop()
        await f.sessions.start()
        assert.deepEqual(f.sessions.getSessionState('web:topic')?.topic, topic)
        assert.equal(f.sessions.getSessionState('web:topic')?.name, replacement.title)
        assert.equal(f.sessions.getSessionState('web:topic')?.createdBySessionId, 'web:orchestrator')
        assert.equal(f.sessions.getSessionState('web:topic')?.topicRequestHash, 'a'.repeat(64))
        assert.equal(f.sessions.getDelegationOwner('web:topic'), undefined)
        await f.sessions.deleteSession('web:orchestrator')
        assert.equal(f.sessions.getSessionState('web:topic')?.sessionKind, 'topic')
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const originalSave = store.saveState.bind(store)
        store.saveState = async (id, state) => {
          if (state.name === 'Slow replacement') { entered.resolve(); await release.promise }
          await originalSave(id, state)
        }
        const update = f.sessions.updateConversationMetadata('web:topic', { ...replacement, title: 'Slow replacement' })
        await entered.promise
        const deletion = f.sessions.deleteSession('web:topic')
        release.resolve()
        await Promise.all([update, deletion])
        assert.equal(await store.getState('web:topic'), null)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: legacy long-lived children become independent without moving workdir or losing fork history`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const physical = 'web_root-0'
      const records = [
        { previous_physical_id: null, timestamp: new Date().toISOString() },
        { role: 'user', content: 'Inherited history sentinel', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Historical answer', timestamp: new Date().toISOString() },
      ]
      await store.createSessionLog(physical, records)
      await store.saveState('web:root', { sessionId: 'web:root', segmentIndex: 0, mode: 'session', children: ['web:legacy', 'web:fork', 'web:remote'] })
      await store.saveState('web:legacy', {
        sessionId: 'web:legacy', segmentIndex: 0, agentType: 'sub', parentSessionId: 'web:root',
        parent: { id: 'web:root', physicalId: physical }, reportTo: 'web:root', workspaceRoot: 'web:root',
      })
      await store.saveState('web:fork', {
        sessionId: 'web:fork', segmentIndex: 0, mode: 'session',
        parent: { id: 'web:root', physicalId: physical, index: 3 }, workspaceRoot: 'web:root',
      })
      const remote = { version: 1 as const, nodeId: 'remote', capabilityId: 'opaque', displayPathSnapshot: 'C:\\never-use-on-main' }
      await store.saveState('web:remote', {
        sessionId: 'web:remote', segmentIndex: 0, mode: 'session',
        parentSessionId: 'web:root', workdir: remote, workspaceRoot: 'web:root',
      })
      try {
        await f.sessions.start()
        const legacy = f.sessions.getSessionState('web:legacy')!
        assert.equal(legacy.parentSessionId, null)
        assert.equal(legacy.createdBySessionId, 'web:root')
        assert.equal(legacy.reportTo, undefined)
        assert.deepEqual(legacy.workdir, managedSessionWorkdirRef('web:root'))
        const before = resolveSessionLocations(workspace, legacy)
        assert.equal(before.workdir.available, true)
        assert.equal(f.sessions.getDelegationOwner('web:legacy'), undefined)
        assert.deepEqual(await f.sessions.getChildren('web:root'), [])
        assert.deepEqual(f.sessions.getSessionState('web:remote')?.workdir, remote)
        assert.equal(resolveSessionLocations(workspace, f.sessions.getSessionState('web:remote')!).workdir.available, false)
        const logs = []
        for await (const record of store.readSessionLog(physical)) logs.push(record)
        assert.deepEqual(logs, records)
        assert.match(JSON.stringify((await f.sessions.getHistory('web:fork')).messages), /Inherited history sentinel/)
        await f.sessions.deliver('web:legacy', {
          ...input('Direct user conversation'),
          source: { kind: 'user', sender: { channel: 'web', chatId: 'legacy', senderId: 'user', messageId: 'user-input' } },
        })
        const pending = await f.next('web:legacy')
        assert.deepEqual(await f.sessions.deleteSession('web:root'), ['web:root'])
        assert.equal(pending.signal.aborted, false)
        assert.deepEqual(resolveSessionLocations(workspace, legacy), before)
        assert.match(JSON.stringify((await f.sessions.getHistory('web:fork')).messages), /Inherited history sentinel/)
        pending.resolve(done('Independent answer'))
        await waitFor(() => f.facts.some(fact => fact.sessionId === 'web:legacy'))
        assert.equal(f.reports.length, 0)
        await f.sessions.stop()
        const saved = await store.getState('web:legacy')
        await f.sessions.start()
        assert.deepEqual(await store.getState('web:legacy'), saved)
        assert.deepEqual(resolveSessionLocations(workspace, f.sessions.getSessionState('web:legacy')!), before)
        assert.equal(f.sessions.canReceiveSessionMessage('web:legacy'), true)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: Initiative delegation inherits context, validates explicit scope and survives restart`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store, { hasInitiative: id => ['cleanup', 'second'].includes(id) })
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root', undefined, { initiativeId: 'cleanup' })
        const context = sourceContext(workspace, f)
        const inherited = JSON.parse(await f.subagent.execute({ description: 'Inherited', mode: 'task', task: 'Work' }, context))
        assert.equal(f.sessions.getSessionState(inherited.sessionId)?.initiativeId, 'cleanup')
        const ids: string[] = []
        for (const field of ['initiative_id', 'initiative_name', 'project_name']) {
          const child = JSON.parse(await f.subagent.execute({
            description: 'Explicit', mode: 'task', task: 'Work', [field]: 'second',
          }, context))
          ids.push(child.sessionId)
          assert.equal(f.sessions.getSessionState(child.sessionId)?.initiativeId, 'second')
          assert.equal(f.sessions.getSessionState(child.sessionId)?.folderId, undefined)
        }
        await assert.rejects(f.subagent.execute({
          description: 'Wrong Project', mode: 'task', task: 'Work', initiative_id: 'missing',
        }, context), /does not belong/)
        await assert.rejects(f.subagent.execute({
          description: 'Conflict', mode: 'task', task: 'Work', initiative_id: 'cleanup', project_name: 'second',
        }, context), /Conflicting/)
        await f.sessions.stop()
        await f.sessions.start()
        assert.equal(f.sessions.getSessionState(inherited.sessionId)?.initiativeId, 'cleanup')
        for (const id of ids) assert.equal(f.sessions.getSessionState(id)?.initiativeId, 'second')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: temporary delegation schema and independent persistent topics`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await store.saveState('web:legacy', { sessionId: 'web:legacy', segmentIndex: 0, agentType: 'verify' })
        await f.sessions.start()
        assert.equal(f.sessions.getSessionState('web:legacy')?.mode, 'task')
        await f.sessions.buildSession('web:root')
        const context = sourceContext(workspace, f)
        const schema = f.sessions.getToolDefinitions('web:root').find(tool => tool.name === 'subagent')!.parameters as typeof f.subagent.parameters
        assert.deepEqual(schema.properties.mode.enum, ['task', 'call'])
        assert.match(await f.subagent.execute({ description: 'missing', mode: 'task' }, context), /task is required/)
        assert.match(await f.subagent.execute({ description: 'invalid', mode: 'unsupported', task: 'x' }, context), /mode must be task or call/)
        assert.match(await f.subagent.execute({ description: 'Reusable verifier', agent_type: 'verify', mode: 'session' }, context), /session creation/)
        await f.sessions.buildSession('web:topic', undefined, { mode: 'session', agentType: 'verify', parentSessionId: null, createdBySessionId: 'web:root' })
        const reusable = { sessionId: 'web:topic' }
        assert.equal(f.requests.length, 0)
        assert.equal(f.sessions.canReceiveSessionMessage(reusable.sessionId), true)
        for (const content of ['first', 'second']) {
          await f.sessions.deliver(reusable.sessionId, input(content))
          ;(await f.next(reusable.sessionId)).resolve(done(content))
          await waitFor(() => f.facts.some(fact => fact.sessionId === reusable.sessionId && fact.content === content))
        }
        assert.equal((await f.sessions.getChildren('web:root')).length, 0)
        assert.equal(f.reports.length, 0)
        await f.sessions.stop()
        await f.sessions.start()
        assert.equal(f.sessions.getSessionState(reusable.sessionId)?.mode, 'session')
        assert.equal(f.sessions.getSessionState('web:legacy')?.mode, 'task')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: root omitted mode always uses task, independent of role preferences`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        const context = sourceContext(workspace, f)
        const reusable = JSON.parse(await f.subagent.execute({ description: 'Default task', task: 'Work' }, context))
        assert.equal(reusable.mode, 'task')
        const task = JSON.parse(await f.subagent.execute({ description: 'Preferred task', agent_type: 'verify', task: 'Work' }, context))
        assert.equal(task.mode, 'task')
        const types = (f.sessions as any).deps.agentTypes
        const original = types.resolve
        types.resolve = (name: string) => ({ ...original(name), ...(name === 'verify' ? { defaultMode: 'call' } : {}) })
        const preferred = JSON.parse(await f.subagent.execute({ description: 'Ignored preference', agent_type: 'verify', task: 'Work' }, context))
        assert.equal(preferred.mode, 'task')
        const explicit = JSON.parse(await f.subagent.execute({ description: 'Explicit task', agent_type: 'verify', mode: 'task', task: 'Work' }, context))
        assert.equal(explicit.mode, 'task')
        assert.equal(f.sessions.getSessionState(task.sessionId)?.mode, 'task')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: task admission returns immediately with fresh context and role tools; completion reports once`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const visibleEvents: string[] = []
      f.bus.on('session.message.appended', ({ sessionId, message }) => {
        if (sessionId === 'web:root' && JSON.stringify(message.content).includes('subagent-complete')) visibleEvents.push(JSON.stringify(message.content))
      })
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root', undefined, { model: 'parent-model' })
        const { child, parent } = await f.spawn()
        const task = await f.next(child)
        assert.equal(task.model, 'fixture')
        assert.ok(!JSON.stringify(task.messages).includes('Parent-only history sentinel'))
        assert.equal(JSON.parse(String(task.messages[0]!.content)).role, 'limited')
        assert.ok(!task.names.includes('dangerous'))
        parent.resolve(done('Parent can idle independently'))
        await waitFor(() => f.sessions.getActiveSession('web:root')?.phase === 'idle')
        assert.equal(task.signal.aborted, false)
        assert.equal(f.reports.length, 0)
        const app = new Hono()
        sessionsApiPlugin(f.sessions)(app)
        const graph = await (await app.request('/api/sessions/graph')).json()
        const card = graph.sessions.find((session: any) => session.sessionId === child)
        assert.equal(card.parentToolCallId, 'task-1')
        assert.equal((await store.getState(child))?.parentToolCallId, 'task-1')
        assert.deepEqual([card.mode, card.agentType, card.parentSessionId, card.executionStatus], ['task', 'limited', 'web:root', 'running'])
        assert.deepEqual(await f.sessions.getChildren('web:root'), [])
        await assert.rejects(f.sessions.deliver(child, input('Followup')), /subsequent inputs/)
        task.resolve(done('Task final result'))
        const resumed = await f.next('web:root')
        assert.match(JSON.stringify(resumed.messages), /Task final result/)
        assert.equal(visibleEvents.length, 1)
        assert.match(visibleEvents[0], /Task final result/)
        assert.equal(resumed.messages.filter(message => message.tool_call_id === 'task-1').length, 1)
        await waitFor(() => f.sessions.getSessionState(child)?.completionReported === true)
        f.bus.emit('session.turn.finished', f.facts.find(fact => fact.sessionId === child)!)
        await delay(5)
        assert.equal(f.reports.length, 1)
        resumed.resolve(done())
        await waitFor(() => f.sessions.getActiveSession('web:root')?.phase === 'idle')
        await f.sessions.stop()
        await f.sessions.start()
        assert.equal(f.reports.length, 1)
        assert.equal(f.sessions.getSessionState(child)?.parentToolCallId, 'task-1')
        await assert.rejects(f.sessions.deliver(child, input('Restart followup')), /subsequent inputs/)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: task yield wakes its actual reusable parent and preserves answer authorization`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        const { child, parent } = await f.spawn()
        parent.resolve(done())
        await waitFor(() => f.sessions.getActiveSession('web:root')?.phase === 'idle')
        ;(await f.next(child)).resolve(invoke('ask', question))
        const decision = await f.next('web:root')
        const request = f.sessions.yields.get(child)!
        assert.deepEqual(request.recipient, { kind: 'parent', sessionId: 'web:root' })
        decision.resolve(invoke('reply', { request_id: request.id, text: 'B' }))
        const resumed = await f.next(child)
        assert.equal(JSON.parse(String(resumed.messages.at(-1)?.content)).option, 'B')
        assert.equal(f.sessions.yields.get(child), null)
        ;(await f.next('web:root')).resolve(done())
        resumed.resolve(done('Task complete'))
        await waitFor(() => f.sessions.getSessionState(child)?.completionReported === true)
        assert.equal(f.reports.length, 1)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: native admission replay is idempotent and task failures report once`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        const context = { ...sourceContext(workspace, f), toolCallId: 'same-tool', toolCallName: 'subagent' }
        const args = { mode: 'task', description: 'Fail once', task: 'Failure' }
        const [first, second] = await Promise.all([f.subagent.execute(args, context), f.subagent.execute(args, context)])
        assert.deepEqual(JSON.parse(first), JSON.parse(second))
        const child = JSON.parse(first).sessionId
        ;(await f.next(child)).reject(new Error('Synthetic failure'))
        const parent = await f.next('web:root')
        assert.match(JSON.stringify(parent.messages), /Synthetic failure/)
        await waitFor(() => f.sessions.getSessionState(child)?.completionReported === true)
        assert.equal(JSON.parse(await f.subagent.execute(args, context)).sessionId, child)
        assert.equal(f.sessions.listSessions().length, 2)
        assert.equal(f.reports.length, 1)
        parent.resolve(done())
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: parent interruption does not cancel task; explicit task cancellation does`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        const { child, parent } = await f.spawn()
        const task = await f.next(child)
        await f.sessions.deliver('web:root', input('Unrelated question', 'interactive'))
        assert.equal(parent.signal.aborted, true)
        assert.equal(task.signal.aborted, false)
        ;(await f.next('web:root')).resolve(done())
        f.sessions.getActiveSession(child)!.cancel()
        await waitFor(() => f.sessions.getSessionState(child)?.completionReported === true)
        assert.equal(task.signal.aborted, true)
        assert.equal(f.sessions.getSessionState(child)?.executionStatus, 'cancelled')
        assert.equal(f.reports[0]!.type, 'subagent-cancelled')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: owner deletion cancels and removes unindexed tasks and their persisted traces`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        const { child, parent } = await f.spawn()
        parent.resolve(done())
        const task = await f.next(child)
        const physicalId = physicalSessionId(f.sessions.getSessionState(child)!)
        assert.ok(!f.sessions.getSessionState('web:root')!.children?.includes(child))
        assert.deepEqual(await f.sessions.deleteSession('web:root'), [child, 'web:root'])
        assert.equal(task.signal.aborted, true)
        assert.equal(f.sessions.getSessionState('web:root'), null)
        assert.equal(f.sessions.getSessionState(child), null)
        assert.equal(await store.getState(child), null)
        assert.equal(await store.countSessionLog(physicalId), 0)
        assert.equal(f.reports.length, 0)
        await f.sessions.stop()
        await f.sessions.start()
        assert.equal(f.sessions.getSessionState(child), null)
        assert.equal(f.sessions.getSessionState('web:root'), null)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: deletion discovers finished and nested executions but preserves independent topics`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('virtual:task', { id: 'web:root' }, { mode: 'task', parentSessionId: 'web:root' })
        await f.sessions.buildSession('virtual:call', { id: 'virtual:task' }, { mode: 'call', parentSessionId: 'virtual:task' })
        await f.sessions.buildSession('web:topic', { id: 'web:root' }, { mode: 'session', parentSessionId: null, createdBySessionId: 'web:root' })
        await f.sessions.buildSession('virtual:other-task', { id: 'web:topic' }, { mode: 'task', parentSessionId: 'web:topic' })
        const traces: string[] = []
        for (const id of ['virtual:task', 'virtual:call']) {
          const state = f.sessions.getSessionState(id)!
          state.executionStatus = 'completed'
          await store.saveState(id, state)
          traces.push(physicalSessionId(state))
          await store.appendMessages(physicalSessionId(state), [{ role: 'assistant', content: 'Completed trace', timestamp: new Date().toISOString() }])
        }
        assert.equal(f.sessions.getSessionState('web:root')!.children, undefined)
        const app = new Hono()
        sessionsApiPlugin(f.sessions)(app)
        const response = await app.request('/api/sessions/web%3Aroot', { method: 'DELETE' })
        assert.equal(response.status, 200)
        assert.deepEqual((await response.json()).deleted, ['virtual:call', 'virtual:task', 'web:root'])
        for (const id of traces) assert.equal(await store.countSessionLog(id), 0)
        for (const id of ['web:topic', 'virtual:other-task']) assert.ok(await store.getState(id))
        await f.sessions.stop()
        await f.sessions.start()
        assert.deepEqual(f.sessions.listSessions().map(state => state.sessionId).sort(), ['virtual:other-task', 'web:topic'])
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: deletion drains an owned child creation already writing its first log`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const create = store.createSessionLog.bind(store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        store.createSessionLog = async (...args) => { entered.resolve(); await release.promise; await create(...args) }
        const creation = f.sessions.buildSession('virtual:late', { id: 'web:root' }, { mode: 'task', parentSessionId: 'web:root' })
        await entered.promise
        const deletion = f.sessions.deleteSession('web:root')
        release.resolve()
        await creation
        assert.deepEqual(await deletion, ['virtual:late', 'web:root'])
        assert.equal(await store.getState('virtual:late'), null)
        assert.equal(f.sessions.getSessionState('virtual:late'), null)
      } finally { release.resolve(); store.createSessionLog = create; await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: deleting a live call drains its final receipt before removing its trace`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.deliver('web:root', input('Call a worker'))
        ;(await f.next('web:root')).resolve(invoke('subagent', {
          description: 'Blocking work', mode: 'call', agent_type: 'limited', task: 'Pending call',
        }, 'call-for-deletion'))
        await waitFor(() => f.sessions.listSessions().some(state => state.mode === 'call'))
        const child = f.sessions.listSessions().find(state => state.mode === 'call')!.sessionId
        const request = await f.next(child)
        const physicalId = physicalSessionId(f.sessions.getSessionState(child)!)
        assert.deepEqual(await f.sessions.deleteSession(child), [child])
        assert.equal(request.signal.aborted, true)
        ;(await f.next('web:root')).resolve(done())
        assert.equal(f.sessions.getSessionState(child), null)
        assert.equal(await store.getState(child), null)
        assert.equal(await store.countSessionLog(physicalId), 0)
        assert.ok(f.sessions.getSessionState('web:root'))
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: an in-flight completion report cannot restore a deleted task`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const save = store.saveState.bind(store)
      try {
        await f.sessions.start()
        const { child, parent } = await f.spawn()
        parent.resolve(done())
        store.saveState = async (id, state) => {
          if (id === child && state.completionReported) { entered.resolve(); await release.promise }
          await save(id, state)
        }
        ;(await f.next(child)).resolve(done('Finished task'))
        await entered.promise
        const physicalId = physicalSessionId(f.sessions.getSessionState(child)!)
        const deletion = f.sessions.deleteSession('web:root')
        release.resolve()
        assert.deepEqual(await deletion, [child, 'web:root'])
        assert.equal(await store.getState(child), null)
        assert.equal(f.sessions.getSessionState(child), null)
        assert.equal(await store.countSessionLog(physicalId), 0)
      } finally { release.resolve(); store.saveState = save; await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: owner deletion stops a task waiting for a nested call and removes both traces`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        const { child, parent } = await f.spawn()
        parent.resolve(done())
        ;(await f.next(child)).resolve(invoke('subagent', {
          description: 'Nested call', mode: 'call', agent_type: 'limited', task: 'Still running',
        }, 'nested-call'))
        await waitFor(() => f.sessions.listSessions().some(state => state.mode === 'call'))
        const leaf = f.sessions.listSessions().find(state => state.mode === 'call')!.sessionId
        const request = await f.next(leaf)
        const traces = [child, leaf].map(id => physicalSessionId(f.sessions.getSessionState(id)!))
        assert.deepEqual(await f.sessions.deleteSession('web:root'), [leaf, child, 'web:root'])
        assert.equal(request.signal.aborted, true)
        for (const id of [child, leaf]) {
          assert.equal(await store.getState(id), null)
          assert.equal(f.sessions.getSessionState(id), null)
        }
        for (const id of traces) assert.equal(await store.countSessionLog(id), 0)
        assert.equal(f.reports.length, 0)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: complete V3 matrix rejects tool, script bridge and manager bypasses`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'session', agentType: 'general', parentSessionId: null })
        await f.sessions.buildSession('virtual:task', { id: 'web:root' }, { mode: 'task', parentSessionId: 'web:root' })
        await f.sessions.buildSession('virtual:leaf', { id: 'virtual:task' }, { mode: 'call', parentSessionId: 'virtual:task' })
        await f.sessions.buildSession('web:fork', { id: 'web:sub', index: 0 })
        await f.sessions.buildSession('web:empty-fork', { id: 'web:sub' })
        assert.equal(f.sessions.getDelegationOwner('web:fork'), undefined)
        assert.deepEqual(f.sessions.getAllowedSubagentModes('web:empty-fork'), ['task', 'call'])
        f.tools.register({ name: 'bridge', description: '', parameters: { type: 'object', properties: {} },
          execute: (args, context) => f.subagent.execute(args, context) })
        const rows = [
          ['web:root', ['task', 'call']], ['web:sub', ['task', 'call']],
          ['virtual:task', ['call']], ['virtual:leaf', []],
        ] as const
        for (const [owner, allowed] of rows) {
          assert.deepEqual(f.sessions.getAllowedSubagentModes(owner), allowed)
          const definition = f.sessions.getToolDefinitions(owner).find(tool => tool.name === 'subagent')
          if (allowed.length) {
            const parameters = definition!.parameters as typeof f.subagent.parameters
            assert.deepEqual(parameters.properties.mode.enum, allowed)
            assert.equal(parameters.required?.includes('mode') ?? false, owner === 'virtual:task')
          }
          else assert.equal(definition, undefined)
          for (const mode of ['session', 'task', 'call'] as const) {
            const id = `${owner}-${mode}`
            const context = { ...sourceContext(workspace, f), sessionId: owner }
            if (!(allowed as readonly string[]).includes(mode)) {
              await assert.rejects(f.sessions.buildSession(id, { id: owner }, { mode, parentSessionId: owner }), /not allowed|Leaf calls/)
              if (mode === 'session') assert.match(await f.subagent.execute({ mode, task: 'Work', description: id }, context), /session creation/)
              else await assert.rejects(f.subagent.execute({ mode, task: 'Work', description: id }, context), /not allowed|Leaf calls/)
              assert.match(requireToolText(await f.tools.execute('bridge', { mode, task: 'Work', description: id }, context)), /not allowed|Leaf calls|session creation/)
            } else {
              await f.sessions.buildSession(id, { id: owner }, { mode, parentSessionId: owner })
              assert.equal(f.sessions.getSessionState(id)?.mode, mode)
              if (mode === 'call') await assert.rejects(f.sessions.deliver(id, input('Bypass')), /private/)
            }
          }
        }
        for (const owner of ['virtual:task']) {
          const context = { ...sourceContext(workspace, f), sessionId: owner }
          const before = f.sessions.listSessions().length
          assert.match(await f.subagent.execute({ description: 'Omitted mode', task: 'Work', agent_type: 'verify' }, context), /mode is required/)
          assert.equal(f.sessions.listSessions().length, before)
        }
        await assert.rejects(f.sessions.buildSession('virtual:unowned', undefined, { mode: 'call' }), /structural owner/)
        await f.sessions.buildSession('web:no-delegation', undefined, { agentType: 'limited' })
        // Role restrictions are checked even when the execution row itself permits delegation.
        const role = (f.sessions as any).deps.agentTypes.resolve
        ;(f.sessions as any).deps.agentTypes.resolve = (name: string) => name === 'limited'
          ? { ...role(name), allowedTools: ['read'] } : role(name)
        await assert.rejects(f.subagent.execute({ mode: 'task', task: 'Work', description: 'Role bypass' },
          { ...sourceContext(workspace, f), sessionId: 'web:no-delegation' }), /role does not permit/)
        await f.sessions.stop()
        await f.sessions.start()
        assert.deepEqual(f.sessions.getAllowedSubagentModes('web:fork'), ['task', 'call'])
        assert.equal(f.sessions.getSessionState('web:empty-fork')?.parentSessionId, null)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  for (const mode of ['session', 'task'] as const) {
    test(`${Store.name}: ${mode} caller awaits leaf result with multimodal context, borrowed tools and isolated trace`, async () => {
      await withTempWorkspace(async workspace => {
        const store: SessionStore = new Store(join(workspace, 'sessions'))
        await store.init()
        const f = fixture(workspace, store)
        let disconnects = 0
        const callWaits: boolean[] = []
        f.bus.on('session.activity.changed', ({ sessionId }) => {
          if (sessionId === 'web:worker') callWaits.push(f.sessions.isWaitingForCall(sessionId))
        })
        f.tools.register({ name: 'prepare', description: '', parameters: { type: 'object', properties: {} },
          execute: async (_args, context) => {
            context.tools.registerDynamic({ name: 'borrowed', description: '', parameters: { type: 'object', properties: {} },
              execute: async () => disconnects ? 'Premature disconnect' : 'Borrowed tool works' })
            context.tools.setMcpConn('fixture', { disconnect: async () => { disconnects++ } } as any, [])
            return 'Prepared'
          } })
        try {
          await f.sessions.start()
          await f.sessions.buildSession('web:root')
          await f.sessions.buildSession('web:worker', { id: 'web:root' }, {
            mode, parentSessionId: mode === 'session' ? null : 'web:root', model: 'worker-model', reportTo: mode === 'session' ? undefined : 'web:root',
          })
          const physical = SessionManager.currentPhysicalId(f.sessions.getSessionState('web:worker')!)
          await store.appendMessages(physical, [{ role: 'user', timestamp: new Date().toISOString(),
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,c25hcHNob3Q=' } }] }])
          await f.sessions.deliver('web:worker', input('Worker context sentinel'))
          ;(await f.next('web:worker')).resolve(invoke('prepare', {}))
          ;(await f.next('web:worker')).resolve(invoke('subagent', { mode: 'call', task: 'Inspect locally', description: 'Leaf work' }, 'leaf-tool'))
          await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call'))
          const child = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
          const leaf = await f.next(child)
          assert.equal(leaf.model, 'worker-model')
          assert.match(JSON.stringify(leaf.messages), /Worker context sentinel/)
          assert.match(JSON.stringify(leaf.messages), /data:image\/png;base64,c25hcHNob3Q=/)
          assert.ok(!JSON.stringify(leaf.messages).includes('leaf-tool'))
          for (const denied of ['subagent', 'ask', 'reply', 'message', 'cron', 'event_subscribe', 'continuation']) assert.ok(!leaf.names.includes(denied))
          assert.ok(leaf.names.includes('exec'))
          assert.equal(f.sessions.isWaitingForCall('web:worker'), true)
          assert.equal(callWaits.at(-1), true, 'Entering a blocking call publishes its wait state')
          assert.equal(f.reports.length, 0)
          assert.equal(f.requests.filter(request => request.sessionId === 'web:worker' && !request.settled).length, 0)
          const app = new Hono()
          sessionsApiPlugin(f.sessions)(app)
          assert.deepEqual(await (await app.request('/api/sessions/web:worker/stage')).json(), { stage: 'waiting', waitingForCall: true })
          const graph = await (await app.request('/api/sessions/graph')).json()
          assert.equal(graph.sessions.find((state: any) => state.sessionId === 'web:worker').waitingForCall, true)
          leaf.resolve({ ...invoke('invoke_tool', { name: 'borrowed', args: {} }), content: 'PRIVATE LEAF TRACE' })
          const afterTool = await f.next(child)
          assert.equal(afterTool.messages.at(-1)?.content, 'Borrowed tool works')
          assert.equal(disconnects, 0)
          const finalResult = `Final leaf result ${'x'.repeat(12_500)}`
          afterTool.resolve(done(finalResult))
          const caller = await f.next('web:worker')
          assert.equal(callWaits.at(-1), false, 'Finishing a blocking call publishes the cleared wait')
          const receipt = JSON.parse(String(caller.messages.find(message => message.tool_call_id === 'leaf-tool')!.content))
          assert.equal(receipt.status, 'completed')
          assert.equal(receipt.result, finalResult)
          assert.equal(receipt.executionId, child)
          assert.equal(receipt.partialWork, '')
          assert.ok(!JSON.stringify(caller.messages).includes('PRIVATE LEAF TRACE'))
          assert.match(JSON.stringify((await f.sessions.getHistory(child)).messages), /PRIVATE LEAF TRACE/)
          assert.equal(caller.messages.filter(message => message.tool_call_id === 'leaf-tool').length, 1)
          assert.equal(f.sessions.isWaitingForCall('web:worker'), false)
          assert.equal(f.reports.length, 0)
          caller.resolve(done('Worker final'))
          await waitFor(() => f.facts.some(fact => fact.sessionId === 'web:worker'))
          const active = f.sessions.getActiveSession('web:worker')
          active?.stop()
          await active?.completion
          assert.equal(disconnects, 1)
          assert.equal(f.reports.filter(report => report.origin?.sessionId === child).length, 0)
        } finally { await f.sessions.stop(); store.close?.() }
      })
    })
  }

  test(`${Store.name}: leaf coordination denial returns blocked with partial work, never silent success or a yield wait`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      let writes = 0
      f.tools.register({ name: 'write-fixture', description: '', parameters: { type: 'object', properties: {} },
        execute: async () => { writes++; return 'Written' } })
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'task', parentSessionId: 'web:root' })
        await f.sessions.deliver('web:sub', input('Do work'))
        ;(await f.next('web:sub')).resolve(invoke('subagent', { mode: 'call', description: 'Leaf', task: 'Work' }, 'leaf'))
        await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call'))
        const child = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
        ;(await f.next(child)).resolve(invoke('write-fixture', {}))
        ;(await f.next(child)).resolve({ ...invoke('ask', question), content: 'Changed one fixture; need permission to continue.' })
        const caller = await f.next('web:sub')
        const receipt = JSON.parse(String(caller.messages.find(message => message.tool_call_id === 'leaf')!.content))
        assert.equal(receipt.status, 'blocked')
        assert.match(receipt.blockedReason, /ask/)
        assert.match(receipt.partialWork, /Changed one fixture/)
        assert.equal(receipt.sideEffectsMayHaveOccurred, true)
        assert.equal(writes, 1)
        assert.equal(f.sessions.yields.get(child), null)
        assert.equal(f.reports.length, 0)
        await assert.rejects(f.sessions.yields.ask(child, { question: 'Choose', options: ['A', 'B', 'C'], defaultOption: 'A' }, new AbortController().signal), /Leaf calls/)
        await assert.rejects(f.sessions.deliver('web:sub', { ...input('Leak'), source: { kind: 'session', sessionId: child } }), /Leaf calls/)
        caller.resolve(invoke('ask', question, 'owner-question'))
        const decision = await f.next('web:root')
        const request = f.sessions.yields.get('web:sub')!
        decision.resolve(invoke('reply', { request_id: request.id, text: 'B' }))
        const afterDecision = await f.next('web:sub')
        ;(await f.next('web:root')).resolve(done())
        afterDecision.resolve(invoke('subagent', { mode: 'call', task: 'Continue with permission', description: 'New leaf' }, 'new-leaf'))
        await waitFor(() => f.sessions.listSessions().filter(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call').length === 2)
        const nextId = f.sessions.listSessions().find(state => state.sessionId !== child && f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
        ;(await f.next(nextId)).resolve(done('New permitted result'))
        const final = await f.next('web:sub')
        const second = JSON.parse(String(final.messages.find(message => message.tool_call_id === 'new-leaf')!.content))
        assert.equal(second.status, 'completed')
        assert.equal(second.result, 'New permitted result')
        assert.notEqual(second.executionId, child)
        assert.equal(f.reports.length, 0)
        final.resolve(done())
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: call cancellation propagates and persisted replay never emits completion events`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'session', parentSessionId: null })
        const controller = new AbortController()
        const context = { ...sourceContext(workspace, f), sessionId: 'web:sub', signal: controller.signal, toolCallId: 'stable', toolCallName: 'subagent' }
        const args = { mode: 'call', task: 'Work', description: 'Cancelled leaf' }
        const first = f.subagent.execute(args, context)
        const duplicate = f.subagent.execute(args, context)
        await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call'))
        const child = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
        const request = await f.next(child)
        controller.abort()
        const receipt = JSON.parse(await first)
        assert.equal(receipt.status, 'cancelled')
        assert.equal(request.signal.aborted, true)
        assert.deepEqual(JSON.parse(await duplicate), receipt)
        assert.equal(f.sessions.isWaitingForCall('web:sub'), false)
        assert.equal(f.reports.length, 0)
        await f.sessions.stop()
        await f.sessions.start()
        assert.deepEqual(JSON.parse(await f.subagent.execute(args, context)), receipt)
        assert.equal(f.reports.length, 0)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  for (const outcome of ['stop', 'failure'] as const) {
    test(`${Store.name}: caller ${outcome} cleans blocking child and borrowed resources exactly once`, async () => {
      await withTempWorkspace(async workspace => {
        const store: SessionStore = new Store(join(workspace, 'sessions'))
        await store.init()
        const f = fixture(workspace, store)
        let disconnects = 0
        f.tools.register({ name: 'subagent', description: f.subagent.description, parameters: f.subagent.parameters,
          execute: async (args, context) => {
            context.tools.setMcpConn('owned-resource', { disconnect: async () => { disconnects++ } } as any, [])
            context.tools.registerDynamic({ name: 'borrowed', description: '', parameters: { type: 'object', properties: {} },
              execute: async () => disconnects ? 'closed' : 'usable' })
            return f.subagent.execute(args, context)
          } })
        try {
          await f.sessions.start()
          await f.sessions.buildSession('web:root')
          await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'session', parentSessionId: null })
          await f.sessions.deliver('web:sub', input('Work'))
          ;(await f.next('web:sub')).resolve(invoke('subagent', { mode: 'call', description: 'Leaf', task: 'Work' }, 'leaf'))
          await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call'))
          const child = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
          const leaf = await f.next(child)
          assert.equal(disconnects, 0)
          const parent = f.sessions.getActiveSession('web:sub')!
          if (outcome === 'failure') {
            leaf.reject(new Error('Leaf provider failure'))
            const resumed = await f.next('web:sub')
            const result = JSON.parse(String(resumed.messages.find(message => message.tool_call_id === 'leaf')!.content))
            assert.equal(result.status, 'failed')
            assert.match(result.error, /Leaf provider failure/)
            assert.equal(disconnects, 0)
            resumed.resolve(done())
          }
          parent.stop()
          await parent.completion
          assert.equal(f.sessions.isWaitingForCall('web:sub'), false)
          assert.equal(f.sessions.getActiveSession(child), undefined)
          assert.equal(disconnects, 1)
          assert.equal(f.reports.length, 0)
          const history = (await f.sessions.getHistory('web:sub')).messages
          assert.equal(history.filter(message => message.tool_call_id === 'leaf').length, 1)
          if (outcome === 'stop') assert.equal(leaf.signal.aborted, true)
        } finally { await f.sessions.stop(); store.close?.() }
      })
    })
  }

  test(`${Store.name}: cancelling a caller waits for foreground exec termination before returning`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const exit = Promise.withResolvers<ManagedProcessStatus>()
      const cleanup = Promise.withResolvers<void>()
      let started = false
      let cleaning = false
      let processActive = true
      let background = 0
      const managed = { pid: 98765, command: 'fixture', cwd: workspace, shell: defaultManagedShell(),
        startedAt: new Date(), process: {}, stdoutChunks: [], stderrChunks: [], exitPromise: exit.promise }
      const manager = { terminate: async () => {
        cleaning = true
        await cleanup.promise
        processActive = false
        exit.resolve({ success: false, code: -1, signal: 'SIGTERM' })
        return exit.promise
      } }
      f.tools.register(new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager as any,
        defaultManagedShell(), { runPromiseTask: () => { background++; return 'unexpected' } } as any,
        { startProcess: async () => { started = true; return managed as any } }))
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'session', parentSessionId: null })
        await f.sessions.deliver('web:sub', input('Work'))
        ;(await f.next('web:sub')).resolve(invoke('subagent', { mode: 'call', task: 'Work', description: 'Exec leaf' }))
        await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call'))
        const child = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
        ;(await f.next(child)).resolve(invoke('exec', { script: 'held fixture process' }))
        await waitFor(() => started)
        const parent = f.sessions.getActiveSession('web:sub')!
        let stopped = false
        void parent.completion.then(() => { stopped = true })
        parent.stop()
        await waitFor(() => cleaning)
        assert.equal(stopped, false)
        assert.equal(f.sessions.isWaitingForCall('web:sub'), true)
        cleanup.resolve()
        await parent.completion
        assert.equal(processActive, false)
        assert.equal(background, 0)
        assert.equal(f.reports.length, 0)
        assert.equal(f.sessions.isWaitingForCall('web:sub'), false)
        assert.equal(f.sessions.getActiveSession(child), undefined)
      } finally { cleanup.resolve(); await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: role overrides cannot widen caller capabilities and embedded blocking admission is rejected`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'session', parentSessionId: null, agentType: 'limited' })
        const context = { ...sourceContext(workspace, f), sessionId: 'web:sub',
          tools: new SessionTools(f.tools, workspace, ['subagent', 'read']) }
        const args = { mode: 'call', task: 'Work', description: 'Intersection', agent_type: 'general' }
        await assert.rejects(f.subagent.execute(args, { ...context, toolCallName: 'exec' }), /native subagent/)
        assert.equal(f.sessions.listSessions().length, 2)
        const work = f.subagent.execute(args, context)
        await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call'))
        const child = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.mode === 'call')!.sessionId
        const leaf = await f.next(child)
        assert.deepEqual(leaf.names, ['read'])
        leaf.resolve(invoke('dangerous', {}))
        const receipt = JSON.parse(await work)
        assert.equal(receipt.status, 'blocked')
        assert.match(receipt.blockedReason, /capability intersection/)
        for (const [content, status] of [
          ['{"status":"blocked","reason":"Missing permission","partialWork":"Inspected context"}', 'blocked'],
          ['Blocked: missing required input.', 'blocked'],
          ['{"status":"failed","error":"Operation failed"}', 'failed'],
          ['Failed: operation could not complete.', 'failed'],
        ]) {
          const declared = f.subagent.execute({ ...args, description: content }, context)
          await waitFor(() => f.sessions.listSessions().some(state => f.sessions.getSessionState(state.sessionId)?.description === content))
          const id = f.sessions.listSessions().find(state => f.sessions.getSessionState(state.sessionId)?.description === content)!.sessionId
          ;(await f.next(id)).resolve(done(content))
          const result = JSON.parse(await declared)
          assert.equal(result.status, status)
          assert.equal(result.sideEffectsMayHaveOccurred, false)
          assert.equal(f.sessions.getSessionState(id)?.executionStatus, 'failed')
        }
        assert.equal(f.reports.length, 0)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: leaf deadline releases a caller even when the provider ignores cancellation`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store, { callTimeoutMs: 100, ignoreAbort: true })
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        await f.sessions.buildSession('web:sub', { id: 'web:root' }, { mode: 'session', parentSessionId: null })
        const work = f.subagent.execute({ mode: 'call', task: 'Bounded work', description: 'Deadline' },
          { ...sourceContext(workspace, f), sessionId: 'web:sub' })
        const receipt = JSON.parse(await work)
        assert.equal(receipt.status, 'blocked')
        assert.match(receipt.blockedReason, /deadline/)
        assert.equal(f.sessions.isWaitingForCall('web:sub'), false)
        const history = JSON.stringify((await f.sessions.getHistory(receipt.sessionId)).messages)
        for (const pending of f.requests) pending.resolve(done('LATE RESPONSE MUST NOT WRITE HISTORY'))
        await delay(5)
        assert.equal(JSON.stringify((await f.sessions.getHistory(receipt.sessionId)).messages), history)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: shutdown cancels task and restart reports once without rerunning it`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        const { child, parent } = await f.spawn()
        parent.resolve(done())
        const task = await f.next(child)
        await f.sessions.stop()
        assert.equal(task.signal.aborted, true)
        assert.equal(f.reports.length, 0)
        await f.sessions.start()
        await waitFor(() => f.sessions.getSessionState(child)?.completionReported === true)
        assert.equal(f.sessions.getActiveSession(child), undefined)
        assert.equal(f.reports.length, 1)
        ;(await f.next('web:root')).resolve(done())
        await f.sessions.stop()
        await f.sessions.start()
        assert.equal(f.reports.length, 1)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })
}

test('leaf coordination tools remain denied through direct registry, dynamic invocation and invoke gateway', async () => {
  const base = new Tools('.')
  const denied = ['subagent', 'ask', 'reply', 'message', 'cron', 'cron_add', 'cron_list', 'cron_remove', 'event_subscribe', 'continuation', 'cancel']
  let executions = 0
  for (const name of denied) base.register({ name, description: '', parameters: { type: 'object', properties: {} },
    execute: async () => { executions++; return 'Unexpected execution' } })
  base.register(new InvokeTool())
  for (const name of ['read', 'dangerous', 'exec']) base.register({
    name, description: '', parameters: { type: 'object', properties: {} }, execute: async () => name,
  })
  const caller = new SessionTools(base, '.')
  const tools = new CallTools(caller, '.')
  const reasons: string[] = []
  tools.setExecutionScope('call', [], reason => { reasons.push(reason) })
  const context: ExecutionContext = {
    sessionId: 'virtual:leaf', physicalSessionId: 'leaf-0', channel: 'virtual', chatId: 'leaf',
    messageId: 'leaf-input', senderId: 'fixture', signal: new AbortController().signal, tools,
  }
  for (const name of denied) {
    assert.equal(tools.has(name), false)
    assert.match(requireToolText(await base.execute(name, {}, context)), /Blocked:/)
    tools.registerDynamic({ name, description: '', parameters: { type: 'object', properties: {} },
      execute: async () => { executions++; return 'Unexpected dynamic execution' } })
    assert.match(requireToolText(await tools.executeDynamic(name, {}, context)), /Blocked:/)
    assert.match(requireToolText(await base.execute('invoke_tool', { name, args: {} }, context)), /Blocked:/)
  }
  assert.equal(executions, 0)
  assert.equal(reasons.length, denied.length * 3)
  assert.equal(tools.has('exec'), true)
  assert.match(requireToolText(await base.execute('exec', { timeout_ms: 0 }, context)), /background execution is forbidden/)
  assert.match(requireToolText(await base.execute('invoke_tool', { name: 'exec', args: { timeout_ms: 0 } }, context)), /background execution is forbidden/)
  const narrowed = new CallTools(caller, '.', ['read'])
  narrowed.setExecutionScope('call', [])
  assert.deepEqual(narrowed.names(), ['read'])
  assert.equal(narrowed.canUseDynamic('anything'), false)
  assert.match(requireToolText(await narrowed.execute('dangerous', {}, { ...context, tools: narrowed })), /Blocked:/)
})

test('separate script invocations never share their outer provider admission key', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const f = fixture(workspace, store)
    try {
      await f.sessions.start()
      await f.sessions.buildSession('web:root')
      const context = { ...sourceContext(workspace, f), toolCallId: 'outer-script', toolCallName: 'script' }
      const args = { mode: 'task', description: 'Parallel task', task: 'Analyse' }
      const results = await Promise.all([f.subagent.execute(args, context), f.subagent.execute(args, context)])
      const ids = results.map(result => JSON.parse(result).sessionId)
      assert.notEqual(ids[0], ids[1])
      assert.equal((await f.next(ids[0])).signal.aborted, false)
      assert.equal((await f.next(ids[1])).signal.aborted, false)
    } finally { await f.sessions.stop() }
  })
})
