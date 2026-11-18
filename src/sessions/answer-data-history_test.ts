import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { ANSWER_DATA_PREFIX, decodeAnswerData, encodeAnswerData } from '../shared/answer-data.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name} round-trips the bounded chart result through tool history`, async () => withTempWorkspace(async workspace => {
    const directory = join(workspace, 'sessions')
    const id = 'answer-data-0'
    const data = { kind: 'line', title: 'Trend', columns: ['Label', 'Count'], rows: [['甲', -1], ['乙', 0], ['丙', 4]] }
    const content = encodeAnswerData(data)
    const responseContext = { version: 1 as const, turnId: 'turn-a', responseId: 'turn-a:0', source: { kind: 'user' as const }, userInvolved: true }
    const timestamp = '2026-01-01T00:00:00.000Z'
    const store: SessionStore = new Store(directory)
    await store.init()
    try {
      await store.createSessionLog(id, [])
      await store.appendMessages(id, [
        { role: 'assistant', content: null, responseContext, timestamp, tool_calls: [
          { id: 'fixture-call', type: 'function', function: { name: 'exec', arguments: '{}' } },
        ] },
        { role: 'tool', name: 'exec', tool_call_id: 'fixture-call', content, timestamp },
        { role: 'assistant', content: '```answer-data\nlatest\n```', responseContext: { ...responseContext, responseId: 'turn-a:1' }, timestamp },
      ])
    } finally { store.close?.() }
    const reader: SessionStore = new Store(directory)
    await reader.init()
    try {
      const history = await Array.fromAsync(reader.readSessionLog(id))
      const result = history.find(record => record.role === 'tool')
      assert.equal(result?.content, content)
      assert.equal(result?.tool_call_id, 'fixture-call')
      const responses = history.filter(record => record.role === 'assistant')
      assert.deepEqual(responses.map(record => (record.responseContext as typeof responseContext).turnId), ['turn-a', 'turn-a'])
      assert.equal(responses[1]?.content, '```answer-data\nlatest\n```')
      assert.deepEqual(decodeAnswerData(result?.content as string), data)
    } finally { reader.close?.() }
  }))
}

test('answer-data rejects unknown properties, ragged and nonfinite numbers, and oversized UTF-8', () => {
  const data = { kind: 'table', title: '', columns: ['A'], rows: [[7]] }
  for (const bad of [{ ...data, path: 'example' }, { ...data, rows: [[1, 2]] }, { ...data, rows: [[Infinity]] }, { ...data, rows: [Array(1)] }, { ...data, kind: 'bar' }]) {
    assert.throws(() => encodeAnswerData(bad), /answerData needs/)
  }
  const oversize = { ...data, rows: Array.from({ length: 40 }, () => ['中'.repeat(160)]) }
  assert.throws(() => encodeAnswerData(oversize), /12 KiB/)
  assert.equal(decodeAnswerData(ANSWER_DATA_PREFIX + JSON.stringify(oversize)), undefined)
})
