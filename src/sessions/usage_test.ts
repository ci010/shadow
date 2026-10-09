import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import { addTokenUsage, readTokenUsage, usageProvider } from './usage.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { HandoffManager } from './handoff/manager.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: real compaction charges its source physical segment, including versioned identities`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:compact', segmentIndex: 2, physicalIdVersion: 2 }
      const tokens = { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
      const manager = new HandoffManager({
        name: 'synthetic', listModels: () => [],
        chat: async () => ({ content: 'Summary', toolCalls: [], usage: tokens }),
      }, 10000, {}, workspace, store)
      try {
        await store.saveState(state.sessionId, state)
        await manager.create(state.sessionId, physicalSessionId(state), 'next-segment', [
          { role: 'user', content: 'Synthetic compaction context' },
        ], 'fixture', undefined, state)
        assert.deepEqual(await readTokenUsage(store, state), { usage: tokens, incomplete: false })
      } finally { await manager.stop(); store.close?.() }
    })
  })
  test(`${Store.name}: failed or unreported calls are explicit and usage persistence failures stop the call`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:usage', segmentIndex: 0 }
      let fails = true
      const provider = usageProvider({
        name: 'synthetic', listModels: () => [],
        chat: async () => {
          if (fails) throw new Error('Synthetic provider interruption')
          return { content: 'Unreported', toolCalls: [] }
        },
      }, store, () => ({ sessionId: state.sessionId, physicalId: physicalSessionId(state) }))
      try {
        await assert.rejects(provider.chat([], [], { model: 'test' }), /provider interruption/)
        fails = false
        await provider.chat([], [], { model: 'test' })
        assert.deepEqual(await readTokenUsage(store, state), { usage: null, incomplete: true })
        const save = t.mock.method(store, 'appendRawEvents', async () => { throw new Error('Synthetic persistence failure') })
        try { await assert.rejects(provider.chat([], [], { model: 'test' }), /persistence failure/) }
        finally { save.mock.restore() }
      } finally { store.close?.() }
    })
  })
  test(`${Store.name}: distinct equal-usage calls survive restart and do not charge repeated assistant snapshots`, async () => {
    await withTempWorkspace(async workspace => {
      const directory = join(workspace, 'sessions')
      let store: SessionStore = new Store(directory)
      await store.init()
      const state: SessionState = { sessionId: 'web:usage', segmentIndex: 0, physicalIdVersion: 2 }
      const tokens = { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
      const provider = usageProvider({
        name: 'synthetic', listModels: () => [],
        chat: async () => ({ content: 'same', toolCalls: [], usage: tokens }),
      }, store, () => ({ sessionId: state.sessionId, physicalId: physicalSessionId(state) }))
      try {
        await provider.chat([], [], { model: 'test' })
        await store.appendMessages(physicalSessionId(state), [
          { role: 'assistant', content: 'repeated snapshot', timestamp: '', usage: tokens },
          { role: 'assistant', content: 'repeated snapshot', timestamp: '', usage: tokens },
        ])
        state.segmentIndex++
        await provider.chat([], [], { model: 'test' })
        const records = await Array.fromAsync(store.readSessionLog(physicalSessionId(state)))
        await store.appendRawEvents(physicalSessionId(state), records)
        store.close?.()
        store = new Store(directory)
        await store.init()
        assert.deepEqual(await readTokenUsage(store, state), {
          usage: { promptTokens: 24, completionTokens: 6, totalTokens: 30 }, incomplete: false,
        })
      } finally { store.close?.() }
    })
  })

  test(`${Store.name}: legacy response IDs deduplicate calls, unknown snapshots stay partial, and foreign call records are excluded`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:usage', segmentIndex: 0 }
      const tokens = { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
      try {
        await store.createSessionLog(physicalSessionId(state), [
          { role: 'assistant', usage: tokens, responseContext: { responseId: 'first' } },
          { role: 'assistant', usage: tokens, responseContext: { responseId: 'first' } },
          { role: 'assistant', usage: tokens, responseContext: { responseId: 'second' } },
          { role: 'assistant', usage: tokens },
          { role: 'assistant', usage: tokens },
          { type: 'model_usage', sessionId: 'unrelated', id: 'foreign', usage: tokens },
          { type: 'model_usage', sessionId: state.sessionId, id: 'new', usage: tokens },
          { role: 'assistant', usage: tokens },
          { type: 'model_usage', sessionId: state.sessionId, id: 'missing', usage: null },
        ])
        assert.deepEqual(await readTokenUsage(store, state), {
          usage: { promptTokens: 48, completionTokens: 12, totalTokens: 60 }, incomplete: true,
        })
      } finally { store.close?.() }
    })
  })
}

test('token totals reject unsafe accumulation instead of silently rounding', () => {
  const first = { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER }
  assert.throws(() => addTokenUsage(first, { promptTokens: 1, completionTokens: 0, totalTokens: 1 }), /supported range/)
})
