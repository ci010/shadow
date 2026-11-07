import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { Session } from '../sessions/session.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import type { SessionMessageInput, SessionTurnFact } from '../sessions/input.ts'

const llm = { model: 'fixture', temperature: 0, contextWindow: 128000 }
const done: LLMResponse = { content: 'Private wake analysis must not be sent.', toolCalls: [] }
function input(wake: boolean): SessionMessageInput {
  const id = crypto.randomUUID()
  return { kind: 'message', id, timestamp: new Date().toISOString(), content: wake ? 'Process incremental information.' : 'Ordinary user request.', policy: 'queue',
    source: wake ? { kind: 'event', type: 'bot-wake', source: 'bot-wake', eventId: id, isGroup: true }
      : { kind: 'user', sender: { channel: 'qq', chatId: 'group:fixture', messageId: id, senderId: 'fixture', isGroup: true } },
    replyTo: { channel: 'qq', chatId: 'group:fixture' } }
}
function fixture(workspace: string, store: SessionStore, respond: LLMProvider['chat']) {
  const bus = new Bus(), outbound: OutboundMessage[] = []
  bus.on('message.outbound', message => { outbound.push(message) })
  const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], chat: respond }
  const tools = new Tools(workspace)
  let explicitSends = 0
  tools.register({ name: 'explicit_send', description: 'Synthetic explicit approved send; receipt only, not a platform integration.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { explicitSends++; return 'Explicit send receipt.' } })
  const sessions = new SessionManager({ workspace, store, provider, bus, tools,
    agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }), allNames: () => ['general'] } as unknown as AgentTypesManager,
    handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
    context: { buildSystemPrompt: async () => 'Synthetic output boundary fixture.' }, getLlmRuntimeConfig: () => llm,
  } as unknown as SessionManagerDeps)
  // Use a real durable Session with a group reply address, without mocking its LLM/tool loop.
  const id = 'qq:group:fixture'
  async function begin(value: SessionMessageInput) {
    const finished = Promise.withResolvers<SessionTurnFact>()
    const off = bus.on('session.turn.finished', fact => { if (fact.sessionId === id && fact.inputId === value.id) finished.resolve(fact) })
    try { await sessions.deliver(id, value) } catch (error) { bus.off(off); throw error }
    assert(sessions.getActiveSession(id) instanceof Session)
    return { finished: finished.promise.finally(() => bus.off(off)) }
  }
  async function turn(value: SessionMessageInput) { return await (await begin(value)).finished }
  async function close() { await sessions.stop(); bus.stopAll(); store.close?.() }
  return { bus, store, sessions, id, outbound, begin, turn, close, explicitSends: () => explicitSends }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: wake assistant content is durable but never outbound; later user response is unaffected`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      let calls = 0
      const f = fixture(workspace, store, async () => { calls++; return done })
      try {
        await f.sessions.start()
        const wake = input(true), fact = await f.turn(wake)
        assert.equal(fact.status, 'completed', fact.error)
        assert.equal(calls, 1)
        assert.equal(f.explicitSends(), 0)
        assert.deepEqual([...f.outbound], [])
        const physical = SessionManager.currentPhysicalId(f.sessions.getSessionState(f.id)!)
        const history = await Array.fromAsync(store.readSessionLog(physical))
        assert(history.some(record => record.role === 'assistant' && JSON.stringify(record.content).includes('Private wake analysis')))
        assert.equal((await f.turn(input(false))).status, 'completed')
        assert.equal(calls, 2)
        assert(f.outbound.some(message => message.event === 'response' && message.content.includes('Private wake analysis')))
      } finally { await f.close() }
    })
  })

  test(`${Store.name}: wake tool chatter is suppressed while explicit tool side effect still executes exactly once`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      let calls = 0
      const f = fixture(workspace, store, async () => ++calls === 1
        ? { content: 'Calling the explicit send tool.', toolCalls: [{ id: 'explicit-once', name: 'explicit_send', arguments: {} }] } : done)
      try {
        await f.sessions.start()
        assert.equal((await f.turn(input(true))).status, 'completed')
        assert.equal(calls, 2)
        assert.equal(f.explicitSends(), 1)
        assert.deepEqual([...f.outbound], [], 'No response, tool_call, tool_result or failure chatter may enter platform routing')
        const physical = SessionManager.currentPhysicalId(f.sessions.getSessionState(f.id)!)
        const history = await Array.fromAsync(store.readSessionLog(physical))
        assert(history.some(record => record.role === 'tool' && record.tool_call_id === 'explicit-once' && JSON.stringify(record.content).includes('Explicit send receipt')))
      } finally { await f.close() }
    })
  })

  test(`${Store.name}: failed wake emits no error message and does not silence the following user turn`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      let calls = 0
      const f = fixture(workspace, store, async () => { if (++calls === 1) throw new Error('Synthetic wake provider failure'); return done })
      try {
        await f.sessions.start()
        const fact = await f.turn(input(true))
        assert.equal(fact.status, 'failed')
        assert.match(fact.error ?? '', /Synthetic wake provider failure/)
        assert.deepEqual([...f.outbound], [])
        assert.equal(f.explicitSends(), 0)
        assert.equal((await f.turn(input(false))).status, 'completed')
        assert(f.outbound.some(message => message.event === 'response' && message.done))
      } finally { await f.close() }
    })
  })

  test(`${Store.name}: cancellation during wake inference emits no completion/error and restores ordinary output`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const started = Promise.withResolvers<void>()
      let calls = 0
      const f = fixture(workspace, store, async (_messages, _tools, options) => {
        if (++calls !== 1) return done
        const signal = options.signal!
        started.resolve()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
        })
        throw new Error('Cancelled inference must not resolve')
      })
      try {
        await f.sessions.start()
        const pending = await f.begin(input(true))
        await started.promise
        const session = f.sessions.getActiveSession(f.id)
        assert(session instanceof Session); session.cancel()
        assert.equal((await pending.finished).status, 'cancelled')
        assert.deepEqual([...f.outbound], [])
        assert.equal(f.explicitSends(), 0)
        assert.equal((await f.turn(input(false))).status, 'completed')
        assert(f.outbound.some(message => message.event === 'response' && message.done))
      } finally { await f.close() }
    })
  })
}
