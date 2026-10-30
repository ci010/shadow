import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { FreshAutomationStateStore } from './fresh-automation-state.ts'
import type { SessionState } from './session-store.ts'

const legacy = { version: 1, nodeId: 'remote', capabilityId: 'opaque%2F:EXACT' }
const intermediate = { version: 2, nodeId: legacy.nodeId, resourceId: legacy.capabilityId }
const current = { version: 2, nodeId: 'remote', workdirId: legacy.capabilityId }
const events = [{ type: 'working-context', workdir: legacy }, { role: 'assistant', tool_calls: [{ id: 'call', arguments: { capabilityId: legacy.capabilityId } }] }, { role: 'tool', tool_call_id: 'call', content: 'kept' }]

for (const Store of [JsonlSessionStore, SqliteSessionStore]) for (const savedRef of [legacy, intermediate]) {
  test(`${Store.name} ${savedRef.version}: persisted legacy reads V2, active saves V2 and historical logs are unchanged`, async () => withTempWorkspace(async root => {
    const store = new Store(root)
    await store.init()
    const state = { ownershipVersion: 2 as const, projectId: 'default', sessionId: 'web:legacy', segmentIndex: 3,
      workspaceRoot: 'web:owner', parent: { id: 'web:owner', physicalId: 'physical-parent', index: 7 }, workdir: savedRef }
    await store.saveState(state.sessionId, { ...state, workdir: undefined })
    await store.createSessionLog('physical-3', events)
    const path = join(root, `${safeSessionId(state.sessionId)}.json`)
    const saveRaw = async (workdir: unknown) => {
      if (Store === JsonlSessionStore) await writeFile(path, JSON.stringify({ ...state, workdir }))
      else {
        const db = new DatabaseSync(join(root, 'sessions.db'))
        try { db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?').run(JSON.stringify({ version: 1,
          metadata: { ...state, sessionId: undefined, segmentIndex: undefined, workdir } }), state.sessionId) } finally { db.close() }
      }
    }
    const bytes = async () => Store === JsonlSessionStore ? await readFile(path, 'utf8') : (() => {
      const db = new DatabaseSync(join(root, 'sessions.db'))
      try { return (db.prepare('SELECT prototype FROM session_states WHERE key = ?').get(state.sessionId) as { prototype: string }).prototype } finally { db.close() }
    })()
    try {
      await saveRaw(savedRef)
      const raw = await bytes()
      const restored = (await store.getState(state.sessionId))!
      assert.deepEqual(restored.workdir, current)
      assert.equal(restored.segmentIndex, 3)
      assert.deepEqual(restored.parent, state.parent)
      assert.equal(await bytes(), raw, 'reads do not rewrite active storage')
      await store.saveState(state.sessionId, restored)
      const saved = JSON.parse(await bytes())
      assert.deepEqual((Store === JsonlSessionStore ? saved : saved.metadata).workdir, current)
      const readEvents = []
      for await (const event of store.readSessionLog('physical-3')) readEvents.push(event)
      assert.deepEqual(readEvents, events)
      for (const invalid of [null, {}, { ...current, version: 77 }, { version: 2, nodeId: 'remote' }, { ...current, workdirId: '' }, { ...current, resourceId: 'mixed' }, { ...current, capabilityId: 'mixed' }, { ...current, unknown: true }]) {
        await saveRaw(invalid)
        const before = await bytes()
        await assert.rejects(store.getState(state.sessionId), /workdir/)
        await assert.rejects(store.listAllStates(), /workdir/)
        assert.equal(await bytes(), before)
      }
    } finally { store.close() }
  }))
}

for (const format of ['jsonl', 'sqlite'] as const) for (const savedRef of [legacy, intermediate]) {
  test(`${format} ${savedRef.version}: FreshAutomation legacy slots/runs/claims normalize without archive rewrites or false revision conflicts`, async () => withTempWorkspace(async root => {
    let store = new FreshAutomationStateStore(root, format)
    const run: SessionState = { sessionId: 'cron:migrate', executionId: 'execution:migrate', ownershipVersion: 2, projectId: 'default',
      mode: 'task', segmentIndex: 0, executionStatus: 'completed', automationCallerSettled: true,
      automation: { jobId: 'job', runId: 'run', contextMode: 'fresh', name: 'job', startedAt: '2026-01-01T00:00:00.000Z' },
      statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'job' }, workdir: current as SessionState['workdir'],
      description: undefined }
    await store.save(run)
    await store.archive(run)
    store.close()
    const directory = join(root, `.fresh-automation-v1-${format}`)
    const database = join(directory, 'archive.db')
    const db = new DatabaseSync(database)
    const old = JSON.stringify({ ...run, workdir: savedRef })
    try {
      db.prepare('UPDATE runs SET state = ?, workdir = ?').run(old, JSON.stringify(savedRef))
      db.prepare('UPDATE claims SET workdir = ?').run(JSON.stringify(savedRef))
    } finally { db.close() }
    if (format === 'jsonl') {
      const slotPath = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!)
      const slot = JSON.parse(await readFile(slotPath, 'utf8'))
      slot.active[run.sessionId] = { ...run, workdir: savedRef }
      await writeFile(slotPath, JSON.stringify(slot)) // archive-first interrupted pointer removal
    }
    const rows = () => {
      const db = new DatabaseSync(database)
      try { return [db.prepare('SELECT * FROM runs').all(), db.prepare('SELECT * FROM claims').all()] } finally { db.close() }
    }
    const before = rows()
    store = new FreshAutomationStateStore(root, format)
    try {
      assert.deepEqual((await store.archived(run.sessionId))?.workdir, current)
      assert.deepEqual((await store.references())[0]?.workdir, current)
      if (format === 'jsonl') assert.deepEqual((await store.listActive())[run.sessionId]?.workdir, current)
      await store.archive(run)
      await store.archive(run)
      assert.deepEqual(rows(), before, 'finalized rows and claims remain byte-for-byte unchanged')
      assert.deepEqual(await store.listActive(), {})
      await assert.rejects(store.archive({ ...run, description: 'a real revision change' }), /revision conflict/)
    } finally { store.close() }
  }))
}

for (const format of ['jsonl', 'sqlite'] as const) test(`${format}: FreshAutomation active V1 and malformed index refs never become absent targets`, async () => withTempWorkspace(async root => {
  let store = new FreshAutomationStateStore(root, format)
  const run: SessionState = { sessionId: 'cron:active', executionId: 'execution:active', ownershipVersion: 2, projectId: 'default',
    mode: 'task', segmentIndex: 0, executionStatus: 'running', automationCallerSettled: false,
    automation: { jobId: 'job', runId: 'run-active', contextMode: 'fresh', name: 'job', startedAt: '2026-01-01T00:00:00.000Z' },
    statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'job' }, workdir: current as SessionState['workdir'] }
  await store.save(run); store.close()
  const directory = join(root, `.fresh-automation-v1-${format}`), database = join(directory, 'archive.db')
  const db = new DatabaseSync(database)
  try { db.prepare('UPDATE runs SET state = ?, workdir = ?').run(JSON.stringify({ ...run, workdir: legacy }), JSON.stringify(legacy)) } finally { db.close() }
  const slotPath = format === 'jsonl' ? join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!) : undefined
  if (slotPath) {
    const slot = JSON.parse(await readFile(slotPath, 'utf8')); slot.active[run.sessionId].workdir = legacy
    await writeFile(slotPath, JSON.stringify(slot))
  }
  store = new FreshAutomationStateStore(root, format)
  try {
    assert.deepEqual((await store.listActive())[run.sessionId]?.workdir, current)
    await store.save((await store.getActive(run.sessionId))!)
    if (slotPath) assert.deepEqual(JSON.parse(await readFile(slotPath, 'utf8')).active[run.sessionId].workdir, current)
    for (const table of ['runs', 'claims']) {
      const db = new DatabaseSync(database)
      try { db.prepare(`UPDATE ${table} SET workdir = ?`).run('{"version":99,"nodeId":"remote","workdirId":"unknown"}') } finally { db.close() }
      await assert.rejects(store.references(), /workdir claim/)
      if (table === 'runs') {
        await assert.rejects(store.getActive(run.sessionId), /workdir claim/)
        await assert.rejects(store.listActive(), /workdir claim/)
        await assert.rejects(store.save(run), /workdir claim/)
      }
      const restore = new DatabaseSync(database)
      try { restore.prepare(`UPDATE ${table} SET workdir = ?`).run(JSON.stringify(current)) } finally { restore.close() }
    }
  } finally { store.close() }
}))
