import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { passiveChannelId, type ChannelSource } from './passive-contract.ts'
import type { SessionState } from '../sessions/session-store.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: additive origin metadata survives refresh/restart, old states remain valid and forged/missing origins fail closed`, async () => {
  await withTempWorkspace(async root => {
    const source: ChannelSource = { version: 1, projectId: 'p', botInstanceId: 'connection', platform: 'feishu', conversationId: 'om_thread', kind: 'thread', parentId: 'oc_group', name: 'Before' }
    const state: SessionState = { ownershipVersion: 2, physicalIdVersion: 2, projectId: 'p', sessionId: passiveChannelId(source), segmentIndex: 0, mode: 'session', channelSource: source }
    let store = new Store(join(root, 'sessions')); await store.init()
    await store.saveState(state.sessionId, state)
    const read = await store.getState(state.sessionId); assert.deepEqual(read?.channelSource, source)
    await store.saveState(state.sessionId, { ...read!, focus: 'Metadata refresh', channelSource: { ...source, name: 'After' } })
    await assert.rejects(() => store.saveState(state.sessionId, { ...state, channelSource: undefined }), /missing/)
    await assert.rejects(() => store.saveState(state.sessionId, { ...state, channelSource: { ...source, projectId: 'foreign' } }), /mismatch/)
    const legacy = { ownershipVersion: 2, projectId: 'p', sessionId: 'bot:p:connection:feishu:oc_legacy', segmentIndex: 0 } as const
    await store.saveState(legacy.sessionId, legacy)
    store.close()
    store = new Store(join(root, 'sessions')); await store.init()
    assert.equal((await store.getState(state.sessionId))?.channelSource?.name, 'After')
    assert.equal((await store.getState(state.sessionId))?.focus, 'Metadata refresh')
    assert.equal((await store.getState(legacy.sessionId))?.channelSource, undefined)
    store.close()
  })
})

test('stable inbox identity separates Projects, connections, channels and public threads, not individual senders', () => {
  const base = { projectId: 'p', botInstanceId: 'c', platform: 'discord', conversationId: 'thread1' }
  const ids = [base, { ...base, projectId: 'q' }, { ...base, botInstanceId: 'other' }, { ...base, conversationId: 'thread2' }, { ...base, platform: 'qq' }].map(passiveChannelId)
  assert.equal(new Set(ids).size, ids.length)
})
