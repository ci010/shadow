import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConversationSnapshot } from './conversation-snapshot.ts'
import type { SessionManager } from './session-manager.ts'

function fixture() {
  const state = { sessionId: 'web:existing', segmentIndex: 0 }
  const calls: string[] = []
  const manager = {
    getSessionState: (id: string) => id === state.sessionId ? state : undefined,
    readSessionState: async (id: string) => id === state.sessionId ? { ...state } : undefined,
    assertHistoricalFolderAccess: async () => { calls.push('folder') },
    getHistory: async () => {
      calls.push('history')
      return { messages: Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `${i}`, provider_state: 'private' })) }
    },
    getCommandResults: async () => [],
    getYieldRecords: async () => [],
    getSessionDetails: async () => ({}),
    getActiveSession: () => undefined,
  }
  return { manager, state, calls, read: (id = state.sessionId) => readConversationSnapshot(manager as unknown as SessionManager, id) }
}

test('snapshot checks folder access before reading and projects only recent display history', async () => {
  const { calls, read } = fixture()
  const result = await read()
  assert.deepEqual(calls, ['folder', 'history'])
  assert.ok(result.data && 'chat' in result.data)
  assert.equal(result.data.chat.historyStart, 20)
  assert.equal(result.data.chat.history.length, 40)
  assert.deepEqual(result.data.chat.history[0], { role: 'user', content: '20' })
})

test('snapshot does not read a missing session or serve a segment that rolled over', async () => {
  const { manager, state, calls, read } = fixture()
  assert.deepEqual(await read('web:missing'), { error: 'session_not_found', status: 404 })
  assert.deepEqual(calls, [])
  manager.getSessionDetails = async () => { state.segmentIndex++; return {} }
  assert.deepEqual(await read(), { error: 'session_segment_changed', status: 409 })
})

test('read-only logical snapshot shares shallow display history without attempting Web input', async () => {
  const { state, manager, read } = fixture()
  state.sessionId = 'discord:fixture'
  let shallow = false
  const original = manager.getHistory
  const readonlyManager = { ...manager, getHistory: (_id: string, options: { shallow?: boolean }) => {
    shallow = options.shallow === true
    return original()
  } }
  const result = await readConversationSnapshot(readonlyManager as unknown as SessionManager, state.sessionId)
  assert.ok(result.data && 'chat' in result.data)
  assert.equal(result.data.chat.chatId, state.sessionId)
  assert.equal(shallow, true)
  assert.deepEqual(result.data.inputDelivery, [])
  assert.deepEqual(await read('web:missing'), { error: 'session_not_found', status: 404 })
})
