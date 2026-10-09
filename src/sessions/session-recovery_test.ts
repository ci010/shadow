import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { SESSION_ITERATION_LIMIT } from '../agent/context/execution-budget.ts'
import { HandoffManager } from './handoff/manager.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { physicalSessionId } from './session-identity.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { sessionsApiPlugin } from './routes.ts'
import type { SessionMessageInput, SessionTurnFact } from './input.ts'
import type { SessionState, SessionStore, StoredMessage } from './session-store.ts'
import { isBackgroundResponse } from './response-context.ts'
import { ProviderTransportError } from '../providers/provider.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'

const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const done = (): LLMResponse => ({ content: 'Finished', toolCalls: [] })
const input = (id: string): SessionMessageInput => ({
  kind: 'message', id, content: 'Perform original request', timestamp: new Date().toISOString(), policy: 'queue',
  source: { kind: 'event', eventId: id, type: 'fixture', source: 'fixture' },
})
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) { assert(Date.now() < deadline, 'Timed out waiting for recovery fixture'); await delay(2) }
}
function fixture(workspace: string, store: SessionStore) {
  const calls: Array<{ messages: ChatMessage[]; signal: AbortSignal; resolve: (response: LLMResponse) => void; reject: (error: Error) => void }> = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, _tools, options) {
      const pending = Promise.withResolvers<LLMResponse>()
      const signal = options!.signal!
      const abort = () => pending.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      calls.push({ messages: structuredClone(messages), signal, resolve: pending.resolve, reject: pending.reject })
      try { signal.throwIfAborted(); return await pending.promise }
      finally { signal.removeEventListener('abort', abort) }
    },
  }
  const bus = new Bus()
  const facts: SessionTurnFact[] = []
  const toolResults: string[] = []
  bus.on('session.turn.finished', fact => { facts.push(fact) })
  bus.on('message.outbound', message => {
    if (message.event === 'tool_result' && message.toolCallId) toolResults.push(message.toolCallId)
  })
  const tools = new Tools(workspace)
  const context = new ContextBuilder(workspace)
  let preparationFails = false
  context.register({ name: 'fixture', getPromptSection: () => {
    if (preparationFails) throw new Error('Fixture preparation failed')
    return 'Synthetic recovery fixture'
  } })
  let emitted = 0
  const sessions = new SessionManager({
    workspace, store, bus, provider, tools, context,
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm,
    agentTypes: { resolve: () => ({ name: 'general', description: '', prompt: '', source: 'builtin', defaultMode: 'session' }) },
    events: { emit: async () => { emitted++ } },
  } as unknown as SessionManagerDeps)
  const app = new Hono()
  sessionsApiPlugin(sessions)(app)
  return { sessions, calls, tools, app, facts, toolResults, emitted: () => emitted, failPreparation: (fail: boolean) => { preparationFails = fail } }
}
const post = (app: Hono, id: string, action: string, body: object) => app.request(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
async function seed(store: SessionStore, id: string, state: Partial<SessionState>, messages: Array<Partial<StoredMessage>>) {
  const saved = { sessionId: id, segmentIndex: 0, ...state }
  await store.saveState(id, saved)
  await store.appendMessages(physicalSessionId(saved), messages.map(message => ({
    role: 'user', content: '', timestamp: '2025-01-01T00:00:00Z', ...message,
  })))
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: unknown tool effects pause inference and Continue only reconciles the saved call`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-unknown-effect'
      let starts = 0
      let checks = 0
      let known = false
      f.tools.register({
        name: 'fixture_remote', description: '', parameters: { type: 'object', properties: {} },
        execute: async (_args, context) => {
          if (context.recoveringToolCall) checks++
          else starts++
          if (!known) throw new ToolOutcomeUnknownError('Remote result is unknown')
          return 'Durable original result'
        },
      })
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'remote-call', name: 'fixture_remote', arguments: {} }] })
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        assert.equal(f.calls.length, 1, 'The model must not receive an error result and automatically retry')
        const recovery = f.sessions.getSessionRecovery(id)!
        assert.equal(recovery.pendingToolCalls, 1)
        await post(f.app, id, 'resume', { recoveryId: recovery.id, acknowledgeToolReplay: true })
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        assert.equal(f.calls.length, 1)
        assert.equal(starts, 1)
        assert.equal(checks, 1)
        assert.equal(f.toolResults.length, 0)
        known = true
        await post(f.app, id, 'resume', { recoveryId: f.sessions.getSessionRecovery(id)!.id, acknowledgeToolReplay: true })
        await waitFor(() => f.calls.length === 2)
        assert.equal(starts, 1)
        assert.equal(checks, 2)
        assert.equal(f.calls[1].messages.filter(message => message.tool_call_id === 'remote-call').length, 1)
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 3)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: a failed model response requires explicit resume and does not repeat committed tools`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-transport-resume'
      let effects = 0
      f.tools.register({ name: 'fixture_effect', description: '', parameters: { type: 'object', properties: {} },
        execute: async () => { effects++; return 'Committed receipt-one' } })
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'effect-one', name: 'fixture_effect', arguments: {} }] })
        await waitFor(() => f.calls.length === 2)
        f.calls[1].reject(new ProviderTransportError('response', 'UND_ERR_SOCKET'))
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        const recovery = f.sessions.getSessionRecovery(id)!
        assert.equal(recovery.reason, 'failed')
        assert.equal(f.calls.length, 2)
        assert.equal((await post(f.app, id, 'resume', { recoveryId: recovery.id })).status, 202)
        await waitFor(() => f.calls.length === 3)
        assert.equal(effects, 1)
        assert.equal(f.calls[2].messages.filter(message => message.tool_call_id === 'effect-one').length, 1)
        f.calls[2].resolve(done())
        await waitFor(() => f.facts.length === 2)
        assert.equal(f.sessions.getSessionRecovery(id), undefined)
        assert.equal(effects, 1)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: Continue keeps an aborted user request expanded without expanding a background request`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        for (const [id, source] of [
          ['web:chat-user-continue', { kind: 'user' as const, sender: {
            channel: 'web', chatId: 'chat-user-continue', senderId: 'owner', messageId: 'original',
          } }],
          ['web:chat-event-continue', { kind: 'event' as const, eventId: 'original', type: 'fixture', source: 'fixture' }],
        ] as const) {
          const index = f.calls.length
          await f.sessions.deliver(id, { ...input('original'), source })
          await waitFor(() => f.calls.length === index + 1)
          assert.equal((await post(f.app, id, 'cancel', { requestId: 'original' })).status, 200)
          await waitFor(() => !!f.sessions.getSessionRecovery(id))
          const recovery = f.sessions.getSessionRecovery(id)!
          assert.equal(recovery.userInvolved, source.kind === 'user')
          assert.equal((await post(f.app, id, 'resume', { recoveryId: recovery.id })).status, 202)
          await waitFor(() => f.calls.length === index + 2)
          assert.equal(String(f.calls[index + 1].messages[0].content).includes('Answer the user\'s request normally'),
            source.kind === 'user')
          f.calls[index + 1].resolve(done())
          await waitFor(() => f.facts.length === (index + 2))
          const history = (await f.sessions.getHistory(id, { shallow: true })).messages
          const response = history.filter(message => message.role === 'assistant').at(-1)!
          assert.equal(isBackgroundResponse(response.responseContext), source.kind !== 'user')
        }
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: older recovery metadata still recognizes a pending user request`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const id = 'web:chat-legacy-user-resume'
      await seed(store, id, { mode: 'session', executionStatus: 'cancelled',
        recovery: { id: 'legacy-recovery', reason: 'stopped' } }, [{
        role: 'user', content: [
          { type: 'text', text: '<sender id="owner" name="owner" chat="direct" />' },
          { type: 'text', text: 'Pending user request' },
        ],
      }])
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        assert.equal(f.sessions.getSessionRecovery(id)?.userInvolved, undefined)
        assert.equal((await post(f.app, id, 'resume', { recoveryId: 'legacy-recovery' })).status, 202)
        await waitFor(() => f.calls.length === 1)
        assert.match(String(f.calls[0].messages[0].content), /Answer the user's request normally/)
        f.calls[0].resolve(done())
        await waitFor(() => f.facts.length === 1)
        const reply = (await f.sessions.getHistory(id, { shallow: true })).messages.filter(message => message.role === 'assistant').at(-1)!
        assert.equal(isBackgroundResponse(reply.responseContext), false)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: explicit Stop -> Resume continues saved history once without replaying completed tools`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-stop-resume'
      let effects = 0
      f.tools.register({ name: 'fixture_effect', description: '', parameters: { type: 'object', properties: {} },
        execute: async () => { effects++; return 'Committed receipt-one' } })
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'effect-one', name: 'fixture_effect', arguments: {} }] })
        await waitFor(() => f.calls.length === 2)
        assert.equal(effects, 1)
        assert.equal((await post(f.app, id, 'cancel', { requestId: 'original' })).status, 200)
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        const recovery = f.sessions.getSessionRecovery(id)!
        assert.equal(recovery.reason, 'stopped')
        assert.deepEqual((await store.getState(id))!.recovery, recovery)
        const snapshot = await (await f.app.request('/api/sessions/stages')).json()
        assert.deepEqual(snapshot.recoveries[id], recovery)
        const results = await Promise.all([post(f.app, id, 'resume', { recoveryId: recovery.id }), post(f.app, id, 'resume', { recoveryId: recovery.id })])
        assert.deepEqual(results.map(result => result.status).sort(), [202, 409])
        await waitFor(() => f.calls.length === 3)
        const history = f.calls[2].messages
        assert.equal(history.filter(message => JSON.stringify(message.content).includes('Perform original request')).length, 1)
        assert.equal(history.filter(message => message.tool_call_id === 'effect-one').length, 1)
        const previous = f.calls[1].messages
        const previousPrompt = String(previous[0].content)
        const previousBudget = `\n${SESSION_ITERATION_LIMIT - 1} inference requests including this one remain for this turn;`
        assert.ok(previousPrompt.includes(previousBudget))
        assert.deepEqual(history, [
          { ...previous[0], content: previousPrompt.replace(previousBudget,
            `\n${SESSION_ITERATION_LIMIT} inference requests including this one remain for this turn;`) },
          ...previous.slice(1),
        ], 'Continue preserves the exact prior context except for the refreshed turn budget')
        assert.equal(effects, 1)
        const accepted = await results.find(result => result.status === 202)!.json()
        const resumedActivity = await (await f.app.request('/api/sessions/stages')).json()
        assert.equal(resumedActivity.activeRequestIds[id], accepted.requestId)
        f.calls[2].resolve(done())
        await waitFor(() => f.facts.length === 2)
        assert.equal(f.sessions.getSessionRecovery(id), undefined)
        assert.equal((await post(f.app, id, 'resume', { recoveryId: recovery.id })).status, 409)
        await f.sessions.stop()
        const restarted = fixture(workspace, store)
        await restarted.sessions.start()
        assert.equal(restarted.calls.length, 0)
        assert.equal(restarted.sessions.getSessionRecovery(id), undefined)
        await restarted.sessions.stop()
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: restart preserves unfinished calls and Continue executes only missing results`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const id = 'web:chat-crashed'
      const continuity: ChatMessage['provider_state'] = {
        provider: 'copilot', model: llm.model,
        reasoning: [{ type: 'reasoning', id: 'reasoning-original', encrypted_content: 'synthetic-state', summary: [] }],
        outputItems: [
          { type: 'reasoning', id: 'reasoning-original', encrypted_content: 'synthetic-state', summary: [] },
          { type: 'function_call', call_id: 'known', name: 'fixture_effect', arguments: '{}' },
          { type: 'function_call', call_id: 'unknown', name: 'fixture_effect', arguments: '{"value":42}' },
        ],
      }
      await seed(store, id, { mode: 'session', executionStatus: 'running', lastActivityAt: '2025-01-01T00:00:00Z' }, [
        { role: 'user', content: [
          { type: 'text', text: '<sender id="owner" name="owner" chat="direct" />' },
          { type: 'text', text: 'Original interrupted input' },
        ] },
        { role: 'assistant', content: null, provider_state: continuity, reasoning_content: 'Original reasoning', tool_calls: [
          { id: 'known', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } },
          { id: 'unknown', type: 'function', function: { name: 'fixture_effect', arguments: '{"value":42}' } },
        ] },
        { role: 'tool', tool_call_id: 'known', name: 'fixture_effect', content: 'Committed receipt' },
      ])
      await seed(store, 'web:chat-legacy', {}, [{ role: 'user', content: 'Legacy unfinished' }])
      await seed(store, 'web:chat-completed', { mode: 'session', executionStatus: 'running' }, [
        { role: 'user', content: 'Original' }, { role: 'assistant', content: 'Finished' },
      ])
      await seed(store, 'web:chat-empty', { mode: 'session', executionStatus: 'pending' }, [])
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        assert.equal(f.calls.length, 0)
        assert.equal(f.emitted(), 0)
        const recovery = f.sessions.getSessionRecovery(id)!
        assert.equal(recovery.reason, 'interrupted')
        assert.equal(recovery.userInvolved, true)
        assert.equal(f.sessions.getSessionRecovery('web:chat-legacy')?.reason, 'interrupted')
        assert.equal(f.sessions.getSessionRecovery('web:chat-completed'), undefined)
        assert.equal(f.sessions.getSessionRecovery('web:chat-empty'), undefined)
        await f.sessions.recoverIncompleteSessions()
        assert.deepEqual(f.sessions.getSessionRecovery(id), recovery)
        const records = await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!)))
        assert.equal(records.length, 3, 'Startup only updates recovery metadata, never the transcript')
        assert.equal(records.filter(record => record.tool_call_id === 'unknown').length, 0)
        await f.sessions.stop()
        const restored = fixture(workspace, store)
        const executions: string[] = []
        restored.tools.register({ name: 'fixture_effect', description: '', parameters: { type: 'object', properties: {} },
          execute: async (args, context) => {
            assert.deepEqual(args, { value: 42 })
            executions.push(context.toolCallId!)
            assert.equal(restored.calls.length, 0, 'Pending calls finish before contacting the provider')
            return 'Recovered result'
          } })
        try {
          await restored.sessions.start()
          assert.deepEqual(restored.sessions.getSessionRecovery(id), recovery)
          assert.equal(restored.calls.length, 0)
          assert.equal((await post(restored.app, 'web:chat-legacy', 'resume', { recoveryId: recovery.id })).status, 409)
          assert.equal((await post(restored.app, id, 'resume', { recoveryId: recovery.id, content: 'Forbidden replay' })).status, 400)
          restored.failPreparation(true)
          assert.equal((await post(restored.app, id, 'resume', { recoveryId: recovery.id })).status, 409)
          assert.equal((await post(restored.app, id, 'resume', { recoveryId: recovery.id, acknowledgeToolReplay: true })).status, 500)
          assert.deepEqual(restored.sessions.getSessionRecovery(id), recovery)
          restored.failPreparation(false)
          assert.equal((await post(restored.app, id, 'resume', { recoveryId: recovery.id, acknowledgeToolReplay: true })).status, 202)
          await waitFor(() => restored.calls.length === 1)
          assert.match(String(restored.calls[0].messages[0].content), /Answer the user's request normally/)
          assert.deepEqual(restored.calls[0].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['known', 'unknown'])
          assert.equal(restored.calls[0].messages.at(-1)!.content, 'Recovered result')
          assert.deepEqual(executions, ['unknown'])
          assert.equal(restored.calls[0].messages.filter(message => message.role === 'user').length, 1)
          assert.equal(restored.calls[0].messages.filter(message => message.role === 'assistant').length, 1)
          assert.deepEqual(restored.calls[0].messages.find(message => message.role === 'assistant')?.provider_state, continuity)
          assert.equal(restored.calls[0].messages.find(message => message.role === 'assistant')?.reasoning_content, 'Original reasoning')
          restored.calls[0].resolve(done())
          await waitFor(() => restored.facts.length === 1)
          const reply = (await restored.sessions.getHistory(id, { shallow: true })).messages.filter(message => message.role === 'assistant').at(-1)!
          assert.equal(isBackgroundResponse(reply.responseContext), false)
        } finally { await restored.sessions.stop() }
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: repeated failed continuations do not change API context or persisted messages`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-repeat-continue'
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        const before = await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!)))
        for (let attempt = 0; attempt < 3; attempt++) {
          f.calls[attempt].reject(new Error('Synthetic API failure'))
          await waitFor(() => !!f.sessions.getSessionRecovery(id))
          const recovery = f.sessions.getSessionRecovery(id)!
          assert.equal((await post(f.app, id, 'resume', { recoveryId: recovery.id })).status, 202)
          await waitFor(() => f.calls.length === attempt + 2)
          assert.deepEqual(f.calls[attempt + 1].messages, f.calls[0].messages)
          const records = await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!)))
          assert.deepEqual(records.filter(record => record.type !== 'model_usage'), before)
          const usage = records.filter(record => record.type === 'model_usage')
          assert.equal(usage.length, attempt + 1, 'Each failed call records its unknown usage without adding a message')
          assert.equal(new Set(usage.map(record => record.id)).size, usage.length)
          for (const record of usage) {
            assert.equal(record.sessionId, id)
            assert.equal(record.usage, null)
          }
        }
        f.calls[3].resolve(done())
        await waitFor(() => f.facts.length === 4)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: Stop preserves a finishing tool result and Continue runs the unstarted next group`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-pending-group'
      const release = Promise.withResolvers<string>()
      const executed: string[] = []
      f.tools.register({ name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
        execute: async (_args, context) => { executed.push(context.toolCallId!); return release.promise } })
      f.tools.register({ name: 'fixture_read', description: '', parameters: { type: 'object', properties: {} }, readonly: true,
        execute: async (_args, context) => { executed.push(context.toolCallId!); return 'Read receipt' } })
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [
          { id: 'first', name: 'fixture_wait', arguments: {} },
          { id: 'second', name: 'fixture_read', arguments: {} },
        ] })
        await waitFor(() => executed.length === 1)
        await post(f.app, id, 'cancel', { requestId: 'original' })
        release.resolve('Committed receipt after cancellation')
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        const records = await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!)))
        assert.deepEqual(records.filter(record => record.role === 'tool').map(record => [record.tool_call_id, record.content]),
          [['first', 'Committed receipt after cancellation']])
        const recovery = f.sessions.getSessionRecovery(id)!
        assert.equal((await post(f.app, id, 'resume', { recoveryId: recovery.id, acknowledgeToolReplay: true })).status, 202)
        await waitFor(() => f.calls.length === 2)
        assert.deepEqual(executed, ['first', 'second'])
        assert.deepEqual(f.calls[1].messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]),
          [['first', 'Committed receipt after cancellation'], ['second', 'Read receipt']])
        assert.equal(f.calls[1].messages.filter(message => message.role === 'user').length, 1)
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 2)
      } finally { release.resolve('cleanup'); await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: an aborted tool with no result remains pending for Continue`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-aborted-tool'
      const executions: string[] = []
      f.tools.register({ name: 'fixture_abort', description: '', parameters: { type: 'object', properties: {} },
        execute: async (_args, context) => {
          executions.push(context.toolCallId!)
          if (executions.length > 1) return 'Resumed real result'
          await delay(60_000, undefined, { signal: context.signal })
          throw new Error('Fixture should have been cancelled')
        } })
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'original-call', name: 'fixture_abort', arguments: {} }] })
        await waitFor(() => executions.length === 1)
        await post(f.app, id, 'cancel', { requestId: 'original' })
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        const records = await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!)))
        assert.equal(records.filter(record => record.role === 'tool').length, 0, 'Cancellation must not fabricate a tool result')
        const recovery = f.sessions.getSessionRecovery(id)!
        assert.equal(recovery.pendingToolCalls, 1)
        assert.equal((await post(f.app, id, 'resume', { recoveryId: recovery.id })).status, 409)
        assert.deepEqual(executions, ['original-call'])
        await post(f.app, id, 'resume', { recoveryId: recovery.id, acknowledgeToolReplay: true })
        await waitFor(() => f.calls.length === 2)
        assert.deepEqual(executions, ['original-call', 'original-call'])
        assert.deepEqual(f.calls[1].messages.map(message => message.role), ['system', 'user', 'assistant', 'tool'])
        assert.equal(f.calls[1].messages.at(-1)?.content, 'Resumed real result')
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 2)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: a completed parallel result is durable while a sibling is still running`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-parallel-results'
      const release = Promise.withResolvers<string>()
      let executions = 0
      f.tools.register({ name: 'fixture_parallel', description: '', parameters: { type: 'object', properties: {} }, readonly: true,
        execute: async (_args, context) => {
          executions++
          return context.toolCallId === 'slow' ? release.promise : 'Fast committed receipt'
        } })
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('original'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [
          { id: 'slow', name: 'fixture_parallel', arguments: {} },
          { id: 'fast', name: 'fixture_parallel', arguments: {} },
        ] })
        await waitFor(() => f.toolResults.includes('fast'))
        assert.equal(executions, 2)
        const records = await Array.fromAsync(store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!)))
        assert.deepEqual(records.filter(record => record.role === 'tool').map(record => record.tool_call_id), ['fast'])
        await post(f.app, id, 'cancel', { requestId: 'original' })
        release.resolve('Slow committed receipt')
        await waitFor(() => !!f.sessions.getSessionRecovery(id))
        const recovery = f.sessions.getSessionRecovery(id)!
        await post(f.app, id, 'resume', { recoveryId: recovery.id })
        await waitFor(() => f.calls.length === 2)
        assert.equal(executions, 2)
        assert.deepEqual(f.calls[1].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['fast', 'slow'])
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 2)
      } finally { release.resolve('cleanup'); await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: queued successor consumes its own input and suppresses stale recovery`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const id = 'web:chat-queue'
      try {
        await f.sessions.start()
        await f.sessions.deliver(id, input('first'))
        await waitFor(() => f.calls.length === 1)
        await f.sessions.deliver(id, input('queued'))
        await post(f.app, id, 'cancel', { requestId: 'first' })
        await waitFor(() => f.calls.length === 2)
        assert.equal(f.sessions.getSessionRecovery(id), undefined)
        assert.equal((await post(f.app, id, 'resume', { recoveryId: f.facts[0].turnId })).status, 409)
        assert.equal(f.calls[1].signal.aborted, false)
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 2)
        assert.equal(f.facts[1].inputId, 'queued')
        assert.equal(f.calls.length, 2)
        assert.equal(f.sessions.getSessionRecovery(id), undefined)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })
}
