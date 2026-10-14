import assert from 'node:assert/strict'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { readPresentationEvidence } from './presentation-evidence.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionState } from './session-store.ts'

for (const [name, Store] of [['JSONL', JsonlSessionStore], ['SQLite', SqliteSessionStore]] as const) test(`${name} semantic evidence owns physical provenance and omits tools, child internals and untagged authority`, async () => withTempWorkspace(async home => {
  const store = new Store(home)
  const state = { sessionId: 'web:chat-voice', projectId: 'fixture', segmentIndex: 1 } as SessionState
  try {
    await store.appendMessages(physicalSessionId(state, 0), [
      { timestamp: '2026-10-11T00:00:00Z', role: 'user', content: [{ type: 'text', text: '<sender id="human" name="User" chat="direct" />' }, { type: 'text', text: '先讨论微信输入法' }] },
      { timestamp: '2026-10-11T00:00:00Z', role: 'tool', content: 'private tool trace', tool_call_id: 'call' },
      { timestamp: '2026-10-11T00:00:00Z', role: 'user', content: [{ type: 'text', text: '<sender id="worker" name="sub" source="session" />' }, { type: 'text', text: 'delegate report' }] },
      { timestamp: '2026-10-11T00:00:00Z', role: 'assistant', content: '模型决定采用流式识别，降低延迟；录音和解码分工。', responseContext: { version: 1, turnId: 'internal', responseId: 'internal:0', userInvolved: false, source: { kind: 'session', sessionId: 'child' } } },
      { timestamp: '2026-10-11T00:00:00Z', role: 'user', content: 'untagged ambiguous legacy user' },
    ])
    await store.appendMessages(physicalSessionId(state, 1), [
      { timestamp: '2026-10-11T00:00:00Z', role: 'user', content: [{ type: 'text', text: '<sender id="human" name="User" chat="direct" />' }, { type: 'text', text: '输入法先放弃，做本地 ASR' }] },
      { timestamp: '2026-10-11T00:00:00Z', role: 'assistant', content: '已实现本地 ASR', reasoning_content: 'private thinking', responseContext: { version: 1, turnId: 'user', responseId: 'user:0', userInvolved: true, source: { kind: 'user' } } },
    ])
    const history = await readPresentationEvidence(store, state, new AbortController().signal)
    assert.equal(history.sources.length, 5)
    assert.deepEqual(history.sources.map(source => [source.physicalId, source.id, source.kind]), [
      [physicalSessionId(state, 0), 'record:0', 'human'],
      [physicalSessionId(state, 0), 'record:2', 'report'],
      [physicalSessionId(state, 0), 'record:3', 'assistant'],
      [physicalSessionId(state, 1), 'record:0', 'human'],
      [physicalSessionId(state, 1), 'record:1', 'assistant'],
    ])
    assert(!JSON.stringify(history).includes('private'))
    const giant='PRIVATE_TOOL_SENTINEL'.repeat(100000)
    await store.appendMessages(physicalSessionId(state,1),[
      {timestamp:'2026-10-11T00:00:00Z',role:'tool',tool_call_id:'giant',content:giant},
      {timestamp:'2026-10-11T00:00:00Z',role:'assistant',content:giant,tool_calls:[{id:'giant',type:'function',function:{name:'exec',arguments:'{}'}}]},
    ])
    const afterToolTrace=await readPresentationEvidence(store,state,new AbortController().signal)
    assert.deepEqual(afterToolTrace,history,'Huge tool batch does not enter semantic evidence or increase provider evidence size')
    assert.equal(JSON.stringify(afterToolTrace).length,JSON.stringify(history).length)
    assert.deepEqual((await readPresentationEvidence(store, { ...state, parentSessionId: 'parent' }, new AbortController().signal)).sources, [])
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(readPresentationEvidence(store, state, aborted.signal))
  } finally { if ('close' in store) store.close() }
}))
