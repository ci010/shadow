import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTempWorkspace } from '../../testing/workspace.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../../sessions/session-store-sqlite.ts'
import type { SessionState, SessionStore } from '../../sessions/session-store.ts'
import { physicalSessionId } from '../../sessions/session-identity.ts'
import { captureCutoffs, verifyCutoffs } from './maintenance-contracts.ts'
import { SessionStoreMaintenanceHistory } from './maintenance-history.ts'

const projectId = 'synthetic-maintenance'
const state = (sessionId: string, segmentIndex = 0): SessionState => ({
  sessionId, segmentIndex, projectId, ownershipVersion: 2, physicalIdVersion: 2,
  lastActivityAt: '2026-11-17T00:00:00.000Z',
})
const start = { type: 'start', timestamp: '2026-11-16T00:00:00.000Z' }
const oldMessage = { role: 'user', content: 'old evidence', timestamp: '2026-11-16T00:00:00.000Z' }
const newMessage = { role: 'assistant', content: 'new evidence with old time', timestamp: '2000-01-01T00:00:00.000Z' }

for (const format of ['jsonl', 'sqlite'] as const) {
  const open = (directory: string): SessionStore => format === 'jsonl' ? new JsonlSessionStore(directory) : new SqliteSessionStore(directory)
  const fixture = async (run: (store: SessionStore, directory: string) => Promise<void>) => {
    const directory = await createTempWorkspace()
    const store = open(directory)
    try { await store.init(); await run(store, directory) }
    finally { store.close?.(); await rm(directory, { recursive: true }) }
  }
  const adapter = (store: SessionStore, sessionsDirectory: string) => new SessionStoreMaintenanceHistory(store, { projectId, sessionsDirectory, format })
  const populate = async (store: SessionStore, value: SessionState) => {
    await store.saveState(value.sessionId, value)
    for (let index = 0; index <= value.segmentIndex; index++) await store.createSessionLog(physicalSessionId(value, index), [start, oldMessage])
  }

  test(`${format}: persisted unloaded states, all old segments, exact records and stable inventory`, async () => fixture(async (store, directory) => {
    const value = state('web:unloaded', 2)
    await populate(store, value)
    // New store instance: no SessionManager live map or live history involved.
    const reader = open(directory)
    try {
      const history = adapter(reader, directory)
      const first = await history.inventory()
      assert.deepEqual(first, await history.inventory())
      assert.equal(first.sessions.length, 1)
      assert.equal(first.sessions[0].segments.length, 3)
      for (let index = 0; index <= 2; index++) assert.deepEqual(await history.messages(value.sessionId, physicalSessionId(value, index)), [start, oldMessage])
      const captured = await captureCutoffs(projectId, history)
      assert.deepEqual(captured.cutoffs.map(c => c.messageCount), [2, 2, 2])
      await store.appendMessages(physicalSessionId(value, 2), [newMessage])
      await verifyCutoffs(captured.cutoffs, history)
      assert.notEqual((await history.inventory()).revision, first.revision)
      const next = await captureCutoffs(projectId, history)
      assert.deepEqual(next.cutoffs.map(c => c.messageCount), [2, 2, 3])
      assert.deepEqual((await history.messages(value.sessionId, physicalSessionId(value, 2))).at(-1), newMessage)
    } finally { reader.close?.() }
  }))

  test(`${format}: rejects rewritten prefixes, missing segments and unknown physical IDs`, async () => fixture(async (store, directory) => {
    const value = state('web:rewrite', 1)
    await populate(store, value)
    const history = adapter(store, directory)
    const captured = await captureCutoffs(projectId, history)
    const physical = physicalSessionId(value, 0)
    await store.deleteSessionLog(physical)
    await assert.rejects(history.inventory())
    await assert.rejects(history.messages(value.sessionId, physical))
    await store.createSessionLog(physical, [start, { ...oldMessage, content: 'changed' }])
    await assert.rejects(verifyCutoffs(captured.cutoffs, history), /prefix conflict/)
    await assert.rejects(history.messages(value.sessionId, '../escape'), /does not belong/)
    await assert.rejects(history.messages('missing-session', physical), /does not belong/)
  }))

  test(`${format}: foreign Project excluded; unknown ownership and physical collisions rejected`, async () => fixture(async (store, directory) => {
    const own = state('web:own')
    const foreign = { ...state('web:foreign'), projectId: 'other-project' }
    await populate(store, own); await populate(store, foreign)
    const history = adapter(store, directory)
    assert.deepEqual((await history.inventory()).sessions.map(s => s.sessionId), [own.sessionId])
    await assert.rejects(history.messages(foreign.sessionId, physicalSessionId(foreign)), /does not belong/)
    await assert.rejects(history.messages(own.sessionId, physicalSessionId(foreign)), /does not belong/)
    await store.saveState('web:unknown', { ...state('web:unknown'), projectId: undefined })
    await assert.rejects(history.inventory(), /explicit Project ownership/)
    await store.deleteState('web:unknown')
    // Legacy punctuation normalization maps these different logical IDs to one file.
    await store.saveState('legacy:a', { ...state('legacy:a'), physicalIdVersion: undefined })
    await store.saveState('legacy::a', { ...state('legacy::a'), projectId: 'other-project', physicalIdVersion: undefined })
    await assert.rejects(history.inventory(), /ownership collision/)
  }))

  test(`${format}: strict raw read rejects malformed records hidden by ordinary reader`, async () => fixture(async (store, directory) => {
    const value = state('web:malformed')
    await populate(store, value)
    const physical = physicalSessionId(value)
    if (format === 'jsonl') await appendFile(join(directory, `${physical}.jsonl`), '{not-json}\n')
    else {
      const db = new DatabaseSync(join(directory, 'sessions.db'))
      try { db.prepare('INSERT INTO session_logs(session_id, data) VALUES (?, ?)').run(physical, '{not-json}') }
      finally { db.close() }
    }
    assert.equal((await Array.fromAsync(store.readSessionLog(physical))).length, 2)
    await assert.rejects(adapter(store, directory).inventory(), SyntaxError)
    await assert.rejects(adapter(store, directory).messages(value.sessionId, physical), SyntaxError)
  }))

  test(`${format}: ordinary conversation archives included, exact ranges and zero-record segments`, async () => fixture(async (store, directory) => {
    const value: SessionState = { ...state('web:archived', 1), retirement: {
      retiredAt: '2026-11-17T00:00:00.000Z', fingerprint: 'a'.repeat(64), assessorSessionId: 'synthetic-assessor', reason: 'fixture',
    } }
    await populate(store, value)
    const expected = [start, oldMessage, ...Array.from({ length: 1000 }, (_, index) => ({ ...oldMessage, index }))]
    await store.appendRawEvents(physicalSessionId(value, 0), expected.slice(2))
    // Archive's persisted segment table can attest an empty segment on either backend.
    await store.deleteSessionLog(physicalSessionId(value, 1))
    await store.createSessionLog(physicalSessionId(value, 1), [])
    await store.archiveConversation!((await store.getState(value.sessionId))!)
    assert.deepEqual(await store.listAllStates(), {})
    assert.deepEqual(await store.queryArchivedStates!(), [])
    const history = adapter(store, directory)
    const captured = await captureCutoffs(projectId, history)
    assert.deepEqual(captured.cutoffs.map(c => c.messageCount), [1002, 0])
    assert.deepEqual(await history.messages(value.sessionId, physicalSessionId(value, 0)), expected)
    assert.deepEqual(await history.messages(value.sessionId, physicalSessionId(value, 1)), [])
    await verifyCutoffs(captured.cutoffs, history)
  }))

  test(`${format}: finalized fresh automation archive is included alongside persistent ordinary states`, async () => fixture(async (store, directory) => {
    const value: SessionState = { ...state('cron:archived-run', 1), executionId: 'execution:run', executionKey: 'key:run',
      mode: 'task', executionStatus: 'completed', parentSessionId: 'web:owner',
      automation: { jobId: 'daily', runId: 'run', name: 'daily', contextMode: 'fresh', startedAt: '2026-11-17T00:00:00.000Z' },
      statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'daily' }, automationCallerSettled: true,
    }
    await populate(store, value)
    await store.archiveState!(value)
    assert.deepEqual(await store.listAllStates(), {})
    const history = adapter(store, directory)
    assert.deepEqual((await history.inventory()).sessions.map(s => s.sessionId), [value.sessionId])
    assert.deepEqual((await captureCutoffs(projectId, history)).cutoffs.map(c => c.messageCount), [2, 2])
  }))

  test(`${format}: append without metadata update during cutoff capture requires recapture`, async () => fixture(async (store, directory) => {
    const value = state('web:racing')
    await populate(store, value)
    const history = adapter(store, directory)
    const original = history.messages.bind(history)
    let changed = false
    history.messages = async (session, physical) => {
      const records = await original(session, physical)
      if (!changed) { changed = true; await store.appendMessages(physical, [newMessage]) }
      return records
    }
    await assert.rejects(captureCutoffs(projectId, history), /inventory changed/)
    assert.equal((await captureCutoffs(projectId, history)).cutoffs[0].messageCount, 3)
  }))

  test(`${format}: persisted archive enumeration failure is not converted into an empty inventory`, async () => fixture(async (store, directory) => {
    const history = adapter(store, directory)
    store.queryArchivedStates = async () => { throw new Error('synthetic archive read failure') }
    await assert.rejects(history.inventory(), /synthetic archive read failure/)
  }))

  test(`${format}: no source/state writes and missing directory fails closed`, async () => fixture(async (store, directory) => {
    const value = state('web:readonly')
    await populate(store, value)
    const before = await store.getState(value.sessionId)
    const history = adapter(store, directory)
    const captured = await captureCutoffs(projectId, history)
    await verifyCutoffs(captured.cutoffs, history)
    assert.deepEqual(await store.getState(value.sessionId), before)
    assert.deepEqual(await Array.fromAsync(store.readSessionLog(physicalSessionId(value))), [start, oldMessage])
    await assert.rejects(adapter(store, join(directory, 'missing')).inventory(), { code: 'ENOENT' })
  }))
}

test('JSONL: existing empty segment supported; torn final line rejects and raw bytes untouched', async () => {
  const directory = await createTempWorkspace()
  const store = new JsonlSessionStore(directory)
  try {
    await store.init()
    const value = state('web:empty')
    await store.saveState(value.sessionId, value)
    const physical = physicalSessionId(value)
    await store.createSessionLog(physical, [])
    const history = new SessionStoreMaintenanceHistory(store, { projectId, sessionsDirectory: directory, format: 'jsonl' })
    assert.equal((await captureCutoffs(projectId, history)).cutoffs[0].messageCount, 0)
    const file = join(directory, `${physical}.jsonl`)
    await writeFile(file, JSON.stringify(oldMessage))
    const before = await readFile(file)
    await assert.rejects(history.inventory(), /Incomplete physical history line/)
    assert.deepEqual(await readFile(file), before)
  } finally { store.close(); await rm(directory, { recursive: true }) }
})

test('SQLite: zero-row live segment is unprovable, not silently counted as empty', async () => {
  const directory = await createTempWorkspace()
  const store = new SqliteSessionStore(directory)
  try {
    await store.init()
    const value = state('web:empty')
    await store.saveState(value.sessionId, value)
    await store.createSessionLog(physicalSessionId(value), [])
    const history = new SessionStoreMaintenanceHistory(store, { projectId, sessionsDirectory: directory, format: 'sqlite' })
    await assert.rejects(history.inventory(), /unprovable empty SQLite/)
  } finally { store.close(); await rm(directory, { recursive: true }) }
})

test('JSONL: aliased duplicate state files cannot hide old segments through listAllStates map overwrite', async () => {
  const directory = await createTempWorkspace(), store = new JsonlSessionStore(directory)
  try {
    await store.init()
    const value = state('web:duplicate', 1)
    await store.saveState(value.sessionId, value)
    for (let index = 0; index <= 1; index++) await store.createSessionLog(physicalSessionId(value, index), [start])
    // Ordinary map hydration overwrites equal logical IDs; strict inventory must
    // reject the physical alias before relying on that lossy map.
    await writeFile(join(directory, 'stray-alias.json'), JSON.stringify({ ...value, segmentIndex: 0 }))
    const history = new SessionStoreMaintenanceHistory(store, { projectId, sessionsDirectory: directory, format: 'jsonl' })
    await assert.rejects(history.inventory(), /aliased persisted history state/)
  } finally { store.close(); await rm(directory, { recursive: true }) }
})
