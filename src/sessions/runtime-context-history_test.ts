import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { WorkToolGuard } from './work-alignment.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { isRuntimeContextEvent } from './runtime-context-event.ts'

class EventSession extends BaseSession {
  async run() {
    this.responseContext = { version: 1, turnId: 'fixture', responseId: 'fixture:0', source: { kind: 'user' }, userInvolved: true }
    const signal = new AbortController().signal
    const context: ExecutionContext = { channel: 'web', chatId: 'fixture', senderId: 'owner', messageId: 'fixture',
      sessionId: this.id, physicalSessionId: this.physicalSessionId, tools: this.tools, signal, cwd: this.workspace }
    return this.runLlmLoop(context, { model: 'fixture', contextWindow: 100000, temperature: 0 }, signal)
  }
  record(kind: 'work', content: string) { return this.recordContextEvent(kind, content) }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: runtime events are durable before inference, unchanged on replay and bounded by actual changes`, async t => {
    await withTempWorkspace(async workspace => {
      const directory = join(workspace, 'sessions')
      let store: SessionStore = new Store(directory)
      await store.init()
      const state: SessionState = { sessionId: 'web:fixture', segmentIndex: 0, physicalIdVersion: 2, mode: 'session' }
      const bus = new Bus()
      const base = new Tools(workspace)
      let work = 'Work A'
      let effects = 0
      base.register({ name: 'fixture_step', description: 'Fixture', parameters: { type: 'object', properties: {} },
        execute: async () => { effects++; work = 'Work B'; return `Receipt ${effects}` } })
      const tools = new SessionTools(base, workspace)
      t.mock.method(tools, 'getWorkGuard', () => ({ snapshot: () => [], prompt: () => work, before: () => undefined } as unknown as WorkToolGuard))
      const requests: ChatMessage[][] = []
      const provider: LLMProvider = { name: 'fixture', listModels: () => [], chat: async messages => {
        const persisted = (await Array.fromAsync(store.readSessionLog(physicalSessionId(state)))).filter(row => row.role)
        assert.deepEqual(messages.filter(isRuntimeContextEvent), persisted.filter(row => row.name === 'runtime-context'))
        const previous = requests.at(-1)
        if (previous) assert.deepEqual(messages.slice(0, previous.length), previous)
        requests.push(structuredClone(messages))
        assert.doesNotMatch(JSON.stringify(messages), /Remaining execution budget|inference requests including this one/)
        return requests.length < 3
          ? { content: null, toolCalls: [{ id: `step-${requests.length}`, name: 'fixture_step', arguments: {} }] }
          : { content: 'Done', toolCalls: [] }
      } }
      const system: ChatMessage = { role: 'system', content: 'Stable policy' }
      const make = (history: ChatMessage[]) => new EventSession(workspace, state.sessionId, state, history, provider, tools, bus, store)
      try {
        const session = make([system, { role: 'user', content: 'Task' }])
        await session.run()
        assert.equal(requests.length, 3)
        assert.equal(effects, 2)
        const events = session.history.filter(isRuntimeContextEvent)
        assert.equal(events.length, 2, 'Work A and Work B only; receipts do not trigger repeated work events')
        assert.deepEqual(requests.map(messages => messages.filter(isRuntimeContextEvent).length), [1, 2, 2])
        const saved = await Array.fromAsync(store.readSessionLog(physicalSessionId(state)))
        store.close?.()
        store = new Store(directory)
        await store.init()
        const restored = make([system, ...saved.filter(row => row.role) as unknown as ChatMessage[]])
        const length = restored.history.length
        await restored.record('work', 'Work B')
        assert.equal(restored.history.length, length, 'Reload deduplicates from durable events')
        await restored.record('work', '')
        await restored.record('work', '')
        assert.equal(restored.history.length, length + 1, 'Clearing emits one immutable event')
        // A new physical segment needs its own snapshot even if its current value is unchanged.
        state.segmentIndex++
        const compacted = make([system, { role: 'user', content: 'Compacted summary' }])
        await compacted.record('work', 'Work B')
        assert.equal(compacted.history.filter(isRuntimeContextEvent).length, 1)
        const fail = t.mock.method(store, 'appendMessages', async () => { throw new Error('Synthetic durable write failure') })
        const before = structuredClone(compacted.history)
        await assert.rejects(compacted.record('work', 'Work C'), /durable write failure/)
        assert.deepEqual(compacted.history, before, 'Never send or mark as seen an event that did not persist')
        fail.mock.restore()
      } finally { store.close?.(); bus.stopAll() }
    })
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: recovery retains legacy audience history without emitting new snapshots`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:legacy', segmentIndex: 0, physicalIdVersion: 2, mode: 'session' }
      const legacy: ChatMessage = { role: 'user', name: 'runtime-context', content: [
        { type: 'text', text: '<event type="runtime-context-audience" source="runtime-context" event-id="12345678-1234-4123-8123-123456789abc" />' },
        { type: 'text', text: 'Legacy snapshot: reply to the triggering agent' },
      ] }
      const timestamp = new Date().toISOString()
      await store.appendMessages(physicalSessionId(state), [{ ...legacy, timestamp }])
      const persisted = (await Array.fromAsync(store.readSessionLog(physicalSessionId(state)))).filter(row => row.role) as unknown as ChatMessage[]
      const bus = new Bus()
      const provider: LLMProvider = { name: 'fixture', listModels: () => [], chat: async messages => {
        assert.deepEqual(messages.filter(isRuntimeContextEvent), persisted)
        return { content: 'Substantive result for the conversation reader', toolCalls: [] }
      } }
      const session = new EventSession(workspace, state.sessionId, state, [
        { role: 'system', content: 'Current execution contract; legacy audience records are obsolete.' }, ...persisted,
      ], provider, new SessionTools(new Tools(workspace), workspace), bus, store)
      try {
        await session.run()
        const after = (await Array.fromAsync(store.readSessionLog(physicalSessionId(state)))).filter(row => row.name === 'runtime-context')
        assert.deepEqual(after, persisted, 'Stored legacy record is preserved exactly, never cleared or replaced')
      } finally { store.close?.(); bus.stopAll() }
    })
  })
}
