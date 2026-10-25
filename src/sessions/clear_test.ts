import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Bus } from '../bus/bus.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { memoryProvider } from '../agent/context/memory-provider.ts'
import { MemoryStore } from '../agent/memory.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { EventService } from '../events/service.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import { ContextResetMetadataError, type SessionStore } from './session-store.ts'
import type { SessionTurnFact } from './input.ts'

const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const projectId = '11111111-1111-4111-8111-111111111111'

async function definition(workspace: string, role: string, prompt: string, tools = 'read') {
  const directory = projectStoragePath(workspace, 'agents', role)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'AGENT.md'), `---\nallowedTools: [${tools}]\ndefaultMode: session\n---\n${prompt}`)
}

async function fixture(workspace: string, store: SessionStore) {
  const calls: Array<{ messages: ChatMessage[]; tools: string[] }> = []
  const held = Promise.withResolvers<LLMResponse>()
  const started = Promise.withResolvers<void>()
  let hold = false
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, tools) {
      calls.push({ messages: structuredClone(messages), tools: tools?.map(tool => tool.function.name) ?? [] })
      if (hold) {
        hold = false
        started.resolve()
        return held.promise
      }
      return { content: 'Synthetic answer', toolCalls: [] }
    },
  }
  const bus = new Bus()
  const agentTypes = new AgentTypesManager(workspace)
  await agentTypes.load()
  const tools = new Tools(workspace)
  for (const name of ['read', 'search']) tools.register({
    name, description: name, parameters: { type: 'object', properties: {} },
    async execute() { return 'fixture' },
  })
  const context = new ContextBuilder(workspace)
  context.register({ name: 'role', getPromptSection: ctx => ctx.agent.prompt })
  context.register(memoryProvider(new MemoryStore(workspace), () => undefined))
  const events = new EventService(workspace, bus, (id, input) => sessions.deliver(id, input))
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const sessions: SessionManager = new SessionManager({
    workspace, projectId, store, bus, provider, agentTypes, context, tools, events, backgroundTasks,
    ownsFolder: id => id === 'fixture-folder',
    identity: new IdentityManager(workspace, projectId),
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm,
  })
  await sessions.start()
  async function send(sessionId: string, content: string) {
    const messageId = crypto.randomUUID()
    const finished = Promise.withResolvers<SessionTurnFact>()
    const subscription = bus.on('session.turn.finished', fact => {
      if (fact.inputId === messageId) finished.resolve(fact)
    })
    try {
      await sessions.dispatch({
        channel: 'web', chatId: sessionId.slice(4), senderId: 'owner', admin: true,
        messageId, timestamp: new Date().toISOString(), content,
      }, llm)
      const fact = await finished.promise
      assert.equal(fact.status, 'completed', fact.error)
      await setImmediate()
    } finally { bus.off(subscription) }
  }
  async function close() {
    held.resolve({ content: 'Released', toolCalls: [] })
    await sessions.stop()
    await backgroundTasks.stop()
    await events.stop()
  }
  return { sessions, calls, send, close, agentTypes, held, started, hold: () => { hold = true } }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const role of ['general']) {
    test(`${Store.name}: /clear refreshes ${role} context without changing identity or deleting history`, { timeout: 15000 }, async () => {
      await withTempWorkspace(async workspace => {
        await definition(workspace, role, 'OLD_ROLE_PROMPT')
        const directory = join(workspace, 'sessions')
        let store: SessionStore = new Store(directory)
        await store.init()
        let f = await fixture(workspace, store)
        const id = 'web:chat-admin'
        try {
          await f.sessions.buildSession(id, undefined, {
            agentType: role, sessionKind: 'topic',
            folderId: 'fixture-folder',
          })
          await f.send(id, 'OLD_CONVERSATION')
          const original = structuredClone(f.sessions.getSessionState(id)!)
          const oldLog = await Array.fromAsync(store.readSessionLog(physicalSessionId(original)))
          const oldActive = f.sessions.getActiveSession(id)
          const memoryFile = join(workspace, 'memory', 'sessions', `${id.replace(':', '_')}.md`)
          await mkdir(join(workspace, 'memory', 'sessions'), { recursive: true })
          await writeFile(memoryFile, 'OLD_HANDOFF_SUMMARY')
          await definition(workspace, role, 'NEW_ROLE_PROMPT', 'search')
          assert.equal(await f.sessions.clearSessionContext(id), 'cleared')
          assert.equal(f.calls.length, 1, 'Clear must never call a model/handoff')
          assert.equal(f.sessions.getActiveSession(id), undefined)
          assert.deepEqual((await f.sessions.getHistory(id)).messages, [])
          const state = f.sessions.getSessionState(id)!
          assert.equal(state.sessionId, original.sessionId)
          assert.equal(state.projectId, original.projectId)
          assert.equal(state.folderId, original.folderId)
          assert.deepEqual(state.workdir, original.workdir)
          assert.equal(state.agentType, role)
          assert.equal(state.segmentIndex, 1)
          assert.equal(state.lastKnownTokens, 0)
          assert(state.contextResetAt)
          assert.deepEqual(await Array.fromAsync(store.readSessionLog(physicalSessionId(original))), oldLog)
          const first = await store.readFirstRecord(physicalSessionId(state))
          assert.equal(first?.previous_physical_id, physicalSessionId(original))
          assert.equal(first?.context_reset, true)
          assert.equal(first?.summary_context, undefined)
          assert.match((await f.sessions.getContext({ sessionId: id })).systemPrompt, /NEW_ROLE_PROMPT/)
          assert.doesNotMatch((await f.sessions.getContext({ sessionId: id })).systemPrompt, /OLD_/)
          await f.send(id, 'NEW_CONVERSATION')
          assert.notEqual(f.sessions.getActiveSession(id), oldActive)
          assert.match(JSON.stringify(f.calls.at(-1)), /NEW_ROLE_PROMPT/)
          assert.match(JSON.stringify(f.calls.at(-1)), /NEW_CONVERSATION/)
          assert.doesNotMatch(JSON.stringify(f.calls.at(-1)), /OLD_/)
          if (role === 'general') assert.deepEqual(f.calls.at(-1)!.tools, ['search'])
          const resetAt = state.contextResetAt
          await f.close()
          store.close?.()
          store = new Store(directory)
          await store.init()
          f = await fixture(workspace, store)
          assert.equal(f.sessions.getSessionState(id)?.contextResetAt, resetAt)
          await f.send(id, 'AFTER_RESTART')
          assert.doesNotMatch(JSON.stringify(f.calls), /OLD_/)
          assert.match(JSON.stringify(f.calls), /NEW_CONVERSATION/)
          assert.match(JSON.stringify(await f.sessions.getHistory(id, { physicalId: physicalSessionId(original) })), /OLD_CONVERSATION/)
        } finally { await f.close(); store.close?.() }
      })
    })
  }

  test(`${Store.name}: clear rejects busy work, serializes new admissions and cannot revive fork history`, { timeout: 15000 }, async t => {
    await withTempWorkspace(async workspace => {
      await definition(workspace, 'general', 'ROLE_PROMPT')
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = await fixture(workspace, store)
      try {
        await f.send('web:parent', 'INHERITED_CONTEXT')
        await f.sessions.buildSession('web:fork', {
          id: 'web:parent', physicalId: physicalSessionId(f.sessions.getSessionState('web:parent')!), index: 1,
        }, { parentSessionId: null })
        const parent = structuredClone(f.sessions.getSessionState('web:fork')!.parent)
        assert.match(JSON.stringify(await f.sessions.getHistory('web:fork')), /INHERITED_CONTEXT/)
        f.hold()
        const busy = f.send('web:fork', 'OLD_FORK_MESSAGE')
        await f.started.promise
        assert.equal(await f.sessions.clearSessionContext('web:fork'), 'busy')
        assert.equal(f.sessions.getSessionState('web:fork')!.segmentIndex, 0)
        f.held.resolve({ content: 'Done', toolCalls: [] })
        await busy
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const refresh = f.agentTypes.refresh.bind(f.agentTypes)
        t.mock.method(f.agentTypes, 'refresh', async (name: string) => {
          entered.resolve()
          await release.promise
          await refresh(name)
        })
        const clear = f.sessions.clearSessionContext('web:fork')
        await entered.promise
        const config = f.sessions.applySessionConfigPatch('web:fork', { set: { temperature: 0.25 }, unset: [] })
        const next = f.send('web:fork', 'NEW_FORK_MESSAGE')
        release.resolve()
        assert.equal(await clear, 'cleared')
        await Promise.all([next, config])
        assert.equal((await store.getState('web:fork'))!.segmentIndex, 1)
        assert.equal((await store.getState('web:fork'))!.config?.temperature, 0.25)
        assert.doesNotMatch(JSON.stringify(f.calls.at(-1)), /INHERITED_CONTEXT|OLD_FORK_MESSAGE/)
        assert.deepEqual(f.sessions.getSessionState('web:fork')!.parent, parent, 'Keep lineage without inheriting old context')
        await f.close()
        const reopened = await fixture(workspace, store)
        try {
          await reopened.send('web:fork', 'AFTER_RESTART')
          assert.doesNotMatch(JSON.stringify(reopened.calls), /INHERITED_CONTEXT|OLD_FORK_MESSAGE/)
        } finally { await reopened.close() }
      } finally { await f.close(); store.close?.() }
    })
  })

  test(`${Store.name}: failed clear preserves the history pointer and rejects invalid reset metadata`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = await fixture(workspace, store)
      try {
        await f.send('web:failure', 'KEEP_HISTORY')
        const before = structuredClone(f.sessions.getSessionState('web:failure')!)
        const save = store.saveState.bind(store)
        const mocked = t.mock.method(store, 'saveState', async (...args: Parameters<SessionStore['saveState']>) => {
          if (args[1].contextResetAt) throw new Error('Synthetic storage failure')
          await save(...args)
        })
        await assert.rejects(f.sessions.clearSessionContext('web:failure'), /Synthetic storage failure/)
        assert.deepEqual(f.sessions.getSessionState('web:failure'), before)
        assert.match(JSON.stringify(await f.sessions.getHistory('web:failure')), /KEEP_HISTORY/)
        assert.equal(await store.readFirstRecord(physicalSessionId(before, before.segmentIndex + 1)), null)
        mocked.mock.restore()
        await assert.rejects(store.saveState('web:failure', { ...before, contextResetAt: 'invalid' }), ContextResetMetadataError)
        assert.equal(await f.sessions.clearSessionContext('web:failure'), 'cleared')
        assert.equal(f.sessions.getSessionState('web:failure')!.segmentIndex, 1)
        assert.equal((await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState('web:failure')!)))).length, 1)
      } finally { await f.close(); store.close?.() }
    })
  })
}

test('refresh rereads builtin definitions and rejects invalid updated files without replacing the cached role', async () => {
  await withTempWorkspace(async workspace => {
    const manager = new AgentTypesManager(workspace)
    await manager.load()
    const original = manager.resolve('general')!.prompt
    manager.resolve('general')!.prompt = 'STALE_BUILTIN'
    await manager.refresh('general')
    assert.equal(manager.resolve('general')!.prompt, original)
    await definition(workspace, 'general', 'VALID_ROLE')
    await manager.load()
    const before = manager.resolve('general')
    await writeFile(projectStoragePath(workspace, 'agents', 'general', 'AGENT.md'), '---\nallowedModules: [invalid]\n---\nINVALID_ROLE')
    await assert.rejects(manager.refresh('general'))
    assert.equal(manager.resolve('general'), before)
  })
})
