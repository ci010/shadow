import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import { conversationArchiveQueries } from './conversation-archive-worker.ts'
import type { SessionState } from './session-store.ts'

function state(id: string, segmentIndex = 0): SessionState {
  return { sessionId: id, projectId: 'default', ownershipVersion: 2, physicalIdVersion: 2, segmentIndex,
    topic: 'Archived topic', retirement: { retiredAt: new Date().toISOString(), fingerprint: 'a'.repeat(64), assessorSessionId: 'assessor', reason: 'complete' } }
}
for (const backend of ['jsonl', 'sqlite'] as const) {
  const open = (dir: string) => backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
  test(`${backend}: archive restart, raw segment coordinates, pagination and immutable writes`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
    let store = open(dir)
    try {
      await store.init()
      const s = state('conversation:a', 1)
      await store.saveState(s.sessionId, s)
      const saved = (await store.getState(s.sessionId))!
      for (let i = 0; i < 2; i++) await store.createSessionLog(physicalSessionId(s, i), [{ type: 'start', i }, { type: 'message', content: 'x'.repeat(400000), i }, { type: 'end', i }])
      await store.archiveConversation(saved)
      assert.equal(await store.getState(s.sessionId), null)
      assert.deepEqual(await store.listAllStates(), {})
      assert.equal((await store.queryArchivedStates()).length, 0)
      assert.equal((await store.readArchivedState(s.sessionId))?.topic, s.topic)
      for (let i = 0; i < 2; i++) {
        const id = physicalSessionId(s, i)
        assert.equal(await store.countSessionLog(id), 3)
        assert.equal((await store.readFirstRecord(id))?.i, i)
        assert.deepEqual((await store.readArchivedLogRange(id, 2, 1))?.records, [{ type: 'end', i }])
        assert.equal((await Array.fromAsync(store.readSessionLog(id))).length, 3)
        await assert.rejects(store.appendRawEvents(id, [{ bad: true }]), /immutable/)
        await assert.rejects(store.appendMessages(id, []), /immutable/)
        await assert.rejects(store.createSessionLog(id, []), /immutable/)
        await assert.rejects(store.deleteSessionLog(id), /immutable/)
      }
      await assert.rejects(store.saveState(s.sessionId, saved), /immutable/)
      await assert.rejects(store.deleteState(s.sessionId), /immutable/)
      await assert.rejects(store.readArchivedLogRange('missing', 0, 1001), RangeError)
      assert.equal(await store.readArchivedLogRange('missing', 0, 1), null)
      for (const id of ['b', 'c']) { const next = state(id); await store.saveState(id, next); await store.archiveConversation((await store.getState(id))!) }
      const ids: string[] = []; let cursor: string | undefined
      do { const page = await store.queryConversationArchives({ limit: 1, cursor }); ids.push(...page.items.map(i => i.sessionId)); cursor = page.nextCursor } while (cursor)
      assert.equal(new Set(ids).size, 3)
      assert.equal((await store.listArchiveReferences()).length, 1)
      store.close(); store = open(dir); await store.init()
      assert.deepEqual(await store.listSessions(), [])
      assert.equal(await store.isConversationArchived(s.sessionId), true)
      assert.equal(await store.countSessionLog(physicalSessionId(s, 0)), 3)
      assert.equal((await store.queryConversationArchives()).items[0]?.recordCount, 6)
      // Corruption of a non-overlapping block must not affect range reads elsewhere.
      const db = new DatabaseSync(join(dir, '.conversation-archive-v1', 'archive.db')); db.exec('PRAGMA busy_timeout=2000')
      db.prepare('UPDATE blocks SET checksum=? WHERE physical=? AND start=1').run('bad', physicalSessionId(s, 0)); db.close()
      assert.equal((await store.readArchivedLogRange(physicalSessionId(s, 0), 0, 1))?.records.length, 1)
      await assert.rejects(store.readArchivedLogRange(physicalSessionId(s, 0), 1, 1), /checksum/)
      const corrupt = new DatabaseSync(join(dir, '.conversation-archive-v1', 'archive.db')); corrupt.exec('PRAGMA busy_timeout=2000')
      corrupt.prepare('UPDATE blocks SET count=count+1 WHERE physical=? AND start=0').run(physicalSessionId(s, 1))
      await assert.rejects(store.readArchivedLogRange(physicalSessionId(s, 1), 0, 1), /count corruption/)
      corrupt.prepare('DELETE FROM blocks WHERE physical=?').run(physicalSessionId(s, 1)); corrupt.close()
      await assert.rejects(store.readArchivedLogRange(physicalSessionId(s, 1), 0, 1), /missing block corruption/)
      assert.deepEqual((await store.readArchivedLogRange(physicalSessionId(s, 1), 3, 1))?.records, [])
    } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
  })
  test(`${backend}: precommit failure keeps active source; committed pending conflict fails closed and recovers`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
    let store = open(dir)
    try {
      await store.init()
      const s = state('pending'), physical = physicalSessionId(s)
      await store.saveState(s.sessionId, s)
      const saved = (await store.getState(s.sessionId))!
      await store.createSessionLog(physical, [{ content: 'original' }])
      // Snapshot active source for synthetic crash reconstruction, without touching runtime data.
      const activeState = backend === 'jsonl' ? await readFile(join(dir, (await import('../utils/paths.ts')).safeSessionId(s.sessionId) + '.json')) : undefined
      await store.archiveConversation(saved)
      store.close()
      const db = new DatabaseSync(join(dir, '.conversation-archive-v1', 'archive.db')); db.exec('PRAGMA busy_timeout=2000')
      const { createHash } = await import('node:crypto')
      db.prepare('UPDATE archives SET pending=? WHERE id=?').run(JSON.stringify({ state: saved, sources: [{ physical, count: 1, hash: createHash('sha256').update('{"content":"original"}\n').digest('hex') }] }), s.sessionId)
      db.close()
      if (backend === 'jsonl') {
        await writeFile(join(dir, (await import('../utils/paths.ts')).safeSessionId(s.sessionId) + '.json'), activeState!)
        await appendFile(join(dir, physical + '.jsonl'), '{"content":"new version"}\n')
      } else {
        const active = new DatabaseSync(join(dir, 'sessions.db'))
        active.prepare('INSERT INTO session_logs(session_id,data) VALUES(?,?)').run(physical, '{"content":"new version"}'); active.close()
      }
      store = open(dir)
      await assert.rejects(store.init(), /fingerprint conflict/)
      store.close()
      // Repair source to the committed revision; next init processes only durable pending task.
      if (backend === 'jsonl') await writeFile(join(dir, physical + '.jsonl'), '{"content":"original"}\n')
      else { const active = new DatabaseSync(join(dir, 'sessions.db')); active.prepare('UPDATE session_logs SET data=? WHERE session_id=?').run('{"content":"original"}', physical); active.close() }
      store = open(dir); await store.init()
      assert.equal(await store.countSessionLog(physical), 1)
      assert.equal(await store.getState(s.sessionId), null)
      store.close(); store = open(dir); await store.init()
      assert.equal(await store.isConversationArchived(s.sessionId), true)
    } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
  })
}

test('sqlite read-only archive access and absent archive never creates files', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  try {
    const active = new SqliteSessionStore(dir); await active.init(); active.close()
    const reader = new SqliteSessionStore(dir, { readOnly: true })
    try {
      await reader.init()
      assert.deepEqual(await reader.queryConversationArchives(), { items: [] })
      await assert.rejects(reader.saveState('x', state('x')), /Read-only/)
      const { readdir } = await import('node:fs/promises')
      assert.equal((await readdir(dir)).includes('.conversation-archive-v1'), false)
    } finally { reader.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const backend of ['jsonl', 'sqlite'] as const) test(`${backend}: huge record, bounded range, uncommitted crash retry, oversize leaves source`, async () => {
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  const store = backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
  try {
    await store.init()
    const s = state('large'), physical = physicalSessionId(s)
    const { retirement, ...activeState } = s
    await store.saveState(s.sessionId, activeState)
    const { ConversationArchive } = await import('./conversation-archive.ts')
    const abandoned = new ConversationArchive(dir)
    await (abandoned as any).rpc('begin', { state: s, at: new Date().toISOString() })
    abandoned.close()
    assert.equal(await store.isConversationArchived(s.sessionId), false)
    const content = 'x'.repeat(2 * 1024 * 1024)
    for (let i = 0; i < 10; i++) await store.appendRawEvents(physical, [{ i, content }])
    // Natural manager call: retirement receipt is not first written to active state.
    await store.archiveConversation({ ...(await store.getState(s.sessionId))!, retirement })
    const page = await store.readArchivedLogRange(physical, 0, 1000)
    assert.equal(page?.total, 10)
    assert.ok(page!.records.length < 10)
    assert.equal(page?.nextOffset, page?.records.length)
    await assert.rejects(store.queryConversationArchives({ cursor: 'not-json' }), TypeError)
    const huge = state('oversize'), hugeId = physicalSessionId(huge)
    await store.saveState(huge.sessionId, huge)
    const raw = JSON.stringify({ content: 'z'.repeat(16 * 1024 * 1024) })
    if (backend === 'jsonl') await writeFile(join(dir, hugeId + '.jsonl'), raw + '\n')
    else { const active = new DatabaseSync(join(dir, 'sessions.db')); active.prepare('INSERT INTO session_logs(session_id,data) VALUES(?,?)').run(hugeId, raw); active.close() }
    await assert.rejects(store.archiveConversation((await store.getState(huge.sessionId))!), /16MiB/)
    assert.ok(await store.getState(huge.sessionId))
    assert.equal(await store.isConversationArchived(huge.sessionId), false)
    assert.equal(await store.countSessionLog(hugeId), 1)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const backend of ['jsonl', 'sqlite'] as const) test(`${backend}: strict malformed source, deep indexed range, clone and partial-cleanup restart`, async () => {
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  let store = backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
  const putRaw = async (id: string, raw: string) => {
    if (backend === 'jsonl') await writeFile(join(dir, id + '.jsonl'), raw + '\n')
    else { const active = new DatabaseSync(join(dir, 'sessions.db')); active.prepare('INSERT INTO session_logs(session_id,data) VALUES(?,?)').run(id, raw); active.close() }
  }
  try {
    await store.init()
    const bad = state('bad'), badPhysical = physicalSessionId(bad)
    await store.saveState(bad.sessionId, bad)
    await putRaw(badPhysical, '{broken')
    await assert.rejects(store.archiveConversation((await store.getState(bad.sessionId))!))
    assert.ok(await store.getState(bad.sessionId))
    assert.equal(await store.isConversationArchived(bad.sessionId), false)
    const s = state('deep', 1)
    await store.saveState(s.sessionId, s)
    await store.appendRawEvents(physicalSessionId(s, 0), [{ content: 'first' }])
    await store.appendRawEvents(physicalSessionId(s, 1), Array.from({ length: 10000 }, (_, i) => ({ i })))
    const snapshot = (await store.getState(s.sessionId))!
    const operation = store.archiveConversation(snapshot)
    snapshot.topic = 'caller mutated input after admission'
    await operation
    assert.equal((await store.readArchivedState(s.sessionId))?.topic, 'Archived topic')
    assert.deepEqual((await store.readArchivedLogRange(physicalSessionId(s, 1), 9500, 3))?.records, [{ i: 9500 }, { i: 9501 }, { i: 9502 }])
    const archive = new DatabaseSync(join(dir, '.conversation-archive-v1', 'archive.db')); archive.exec('PRAGMA busy_timeout=2000')
    const plan = archive.prepare('EXPLAIN QUERY PLAN SELECT * FROM blocks WHERE physical=? AND start>=? AND start<? ORDER BY start').all(physicalSessionId(s, 1), 9000, 9503) as { detail: string }[]
    assert.match(plan.map(p => p.detail).join('\n'), /physical=\? AND start>\? AND start<\?/)
    for (const [sql, args] of [[conversationArchiveQueries.all, ['9999', 'deep-cursor', 2]], [conversationArchiveQueries.project, ['default', '9999', 'deep-cursor', 2]]] as const) {
      const pagePlan = archive.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args) as { detail: string }[]
      assert.match(pagePlan.map(p => p.detail).join('\n'), /SEARCH archives USING INDEX archive_(?:project_)?page/)
      assert.match(pagePlan.map(p => p.detail).join('\n'), /(?:at>\?|\(at,id\)>\(\?,\?\))/)
    }
    const { createHash } = await import('node:crypto')
    const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
    const archivedState = JSON.parse((archive.prepare('SELECT state FROM archives WHERE id=?').get(s.sessionId) as { state: string }).state).state
    archive.prepare('UPDATE archives SET pending=? WHERE id=?').run(JSON.stringify({ state: archivedState, sources: [
      { physical: physicalSessionId(s, 0), count: 1, hash: hash('{"content":"first"}\n') },
      { physical: physicalSessionId(s, 1), count: 10000, hash: hash(Array.from({ length: 10000 }, (_, i) => JSON.stringify({ i }) + '\n').join('')) },
    ] }), s.sessionId)
    archive.close()
    // Synthetic crash after first source was deleted: restore only the second source.
    if (backend === 'jsonl') await writeFile(join(dir, physicalSessionId(s, 1) + '.jsonl'), Array.from({ length: 10000 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n')
    else { const active = new DatabaseSync(join(dir, 'sessions.db')); const insert = active.prepare('INSERT INTO session_logs(session_id,data) VALUES(?,?)'); active.exec('BEGIN'); for (let i = 0; i < 10000; i++) insert.run(physicalSessionId(s, 1), JSON.stringify({ i })); active.exec('COMMIT'); active.close() }
    store.close(); store = backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
    await store.init()
    assert.equal(await store.countSessionLog(physicalSessionId(s, 1)), 10000)
    assert.equal((await store.readArchivedLogRange(physicalSessionId(s, 0), 0, 1))?.records[0]?.content, 'first')
    const queued = store.queryConversationArchives(); store.close(); await assert.rejects(queued, /closed/)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const backend of ['jsonl', 'sqlite'] as const) test(`${backend}: ambiguous legacy physical identity cannot delete a shared source`, async () => {
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  const store = backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
  try {
    await store.init()
    const legacy = { ...state('legacy:' + 'long'.repeat(30)), physicalIdVersion: undefined }
    await store.saveState(legacy.sessionId, legacy)
    const physical = physicalSessionId(legacy)
    await store.createSessionLog(physical, [{ content: 'potentially shared legacy source' }])
    await assert.rejects(store.archiveConversation((await store.getState(legacy.sessionId))!), /truncated legacy/)
    assert.ok(await store.getState(legacy.sessionId))
    assert.equal(await store.isConversationArchived(legacy.sessionId), false)
    assert.equal(await store.countSessionLog(physical), 1)
    assert.equal((await store.readFirstRecord(physical))?.content, 'potentially shared legacy source')
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('sqlite independent public and strict source iterators can interleave', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  const store = new SqliteSessionStore(dir)
  try {
    await store.init()
    await store.appendRawEvents('a', [{ n: 1 }, { n: 2 }])
    await store.appendRawEvents('b', [{ n: 3 }, { n: 4 }])
    const a = store.readSessionLog('a')[Symbol.asyncIterator]()
    const b = store.readSessionLog('b')[Symbol.asyncIterator]()
    const strict = (store as any).readArchiveSource('a')[Symbol.asyncIterator]()
    assert.deepEqual((await a.next()).value, { n: 1 })
    assert.deepEqual((await b.next()).value, { n: 3 })
    assert.deepEqual((await strict.next()).value, { n: 1 })
    assert.deepEqual((await a.next()).value, { n: 2 })
    assert.deepEqual((await b.next()).value, { n: 4 })
    assert.deepEqual((await strict.next()).value, { n: 2 })
    await a.return?.(); await b.return?.(); await strict.return?.()
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const backend of ['jsonl', 'sqlite'] as const) test(`${backend}: unrelated active chat completes while large transfer is paused`, async () => {
  const { ConversationArchive } = await import('./conversation-archive.ts')
  const prototype = backend === 'jsonl' ? ConversationArchive.prototype as any : SqliteSessionStore.prototype as any
  const method = backend === 'jsonl' ? 'strictJsonl' : 'readArchiveSource'
  const original = prototype[method]
  let release!: () => void, paused!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { paused = resolve })
  const archived = state('transfer'), physical = physicalSessionId(archived)
  prototype[method] = async function* (id: string) {
    let first = true
    for await (const record of original.call(this, id)) {
      yield record
      if (id === physical && first) { first = false; paused(); await gate }
    }
  }
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  const store = backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
  let transfer: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    await store.init()
    await store.saveState(archived.sessionId, archived)
    await store.createSessionLog(physical, Array.from({ length: 10 }, (_, n) => ({ n, content: 'x'.repeat(300000) })))
    await store.saveState('chat', { ...state('chat'), retirement: undefined })
    await store.createSessionLog('chat-physical', [{ n: 0 }])
    let complete = false
    transfer = store.archiveConversation((await store.getState(archived.sessionId))!).then(() => { complete = true })
    await reached
    const otherChat = async () => {
      // More operations than the former whole-store queue cap, while transfer cannot finish.
      for (let n = 1; n <= 40; n++) {
        await store.appendRawEvents('chat-physical', [{ n }])
        await store.saveState('chat', { ...(await store.getState('chat'))!, lastKnownTokens: n })
      }
      assert.equal(await store.countSessionLog('chat-physical'), 41)
      assert.equal((await store.getState('chat'))?.lastKnownTokens, 40)
    }
    await Promise.race([otherChat(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Unrelated active chat blocked behind transfer')), 2000) })])
    assert.equal(complete, false)
    release(); await transfer
    assert.equal(await store.isConversationArchived(archived.sessionId), true)
  } finally {
    if (timer) clearTimeout(timer)
    release(); await transfer?.catch(() => {})
    prototype[method] = original
    store.close(); await rm(dir, { recursive: true, force: true })
  }
})

for (const backend of ['jsonl', 'sqlite'] as const) test(`${backend}: pending recovery verifies archive corruption before deleting intact sources`, async () => {
  const dir = await mkdtemp(join(process.cwd(), '.archive-test-'))
  const open = () => backend === 'jsonl' ? new JsonlSessionStore(dir) : new SqliteSessionStore(dir)
  let store = open()
  try {
    await store.init()
    const s = state('corrupt-pending'), physical = physicalSessionId(s)
    await store.saveState(s.sessionId, s)
    const sourceState = (await store.getState(s.sessionId))!
    await store.createSessionLog(physical, [{ n: 1 }])
    await store.archiveConversation(sourceState)
    store.close()
    const { createHash } = await import('node:crypto')
    const db = new DatabaseSync(join(dir, '.conversation-archive-v1', 'archive.db')); db.exec('PRAGMA busy_timeout=2000')
    const block = db.prepare('SELECT checksum FROM blocks WHERE physical=?').get(physical) as { checksum: string }
    db.prepare('UPDATE archives SET pending=? WHERE id=?').run(JSON.stringify({ state: sourceState, sources: [{ physical, count: 1, hash: createHash('sha256').update('{"n":1}\n').digest('hex') }] }), s.sessionId)
    db.prepare('UPDATE blocks SET checksum=? WHERE physical=?').run('damaged', physical); db.close()
    if (backend === 'jsonl') {
      const { safeSessionId } = await import('../utils/paths.ts')
      await writeFile(join(dir, safeSessionId(s.sessionId) + '.json'), JSON.stringify(sourceState))
      await writeFile(join(dir, physical + '.jsonl'), '{"n":1}\n')
    } else {
      const active = new DatabaseSync(join(dir, 'sessions.db'))
      active.prepare('INSERT INTO session_logs(session_id,data) VALUES(?,?)').run(physical, '{"n":1}'); active.close()
    }
    store = open()
    await assert.rejects(store.init(), /checksum/)
    if (backend === 'jsonl') assert.equal(await readFile(join(dir, physical + '.jsonl'), 'utf8'), '{"n":1}\n')
    else { const active = new DatabaseSync(join(dir, 'sessions.db')); assert.equal((active.prepare('SELECT COUNT(*) AS n FROM session_logs WHERE session_id=?').get(physical) as { n: number }).n, 1); active.close() }
    const retained = new DatabaseSync(join(dir, '.conversation-archive-v1', 'archive.db')); retained.exec('PRAGMA busy_timeout=2000')
    assert.ok((retained.prepare('SELECT pending FROM archives WHERE id=?').get(s.sessionId) as { pending: string }).pending)
    retained.prepare('UPDATE blocks SET checksum=? WHERE physical=?').run(block.checksum, physical); retained.close()
    store.close(); store = open(); await store.init()
    assert.equal(await store.countSessionLog(physical), 1)
    assert.equal(await store.getState(s.sessionId), null)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
