import { readChannelSessionAliases, withChannelSessionAliases } from './channel-session-aliases.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { safeSessionId } from '../utils/paths.ts'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import { passiveChannelId, type ChannelSource } from '../channels/passive-contract.ts'
import { migrateChannelSessions, type ChannelMigrationManifest } from './channel-session-migration.ts'
import type { SessionState } from './session-store.ts'

const source: ChannelSource = { version: 1, projectId: 'p', connectionId: 'c', platform: 'qq', conversationId: 'group:a', kind: 'group' }
const old = 'bot:p:c:qq:group%3Aa', canonical = passiveChannelId(source)
const manifest: ChannelMigrationManifest = { version: 1, projectId: 'p', mappings: [{ from: old, source }] }
for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`offline canonical migration ${Store.name}: raw tool pairs, segments, references, backup and repeat`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-migration-'))
  const directory = join(root, 'sessions'), output = join(root, 'staged'), backup = join(root, 'backup')
  try {
    const store = new Store(directory); await store.init()
    const inbox: SessionState = { projectId: 'p', ownershipVersion: 2, sessionId: canonical, physicalIdVersion: 2, segmentIndex: 0, channelSource: source }
    const bot: SessionState = { projectId: 'p', ownershipVersion: 2, sessionId: old, physicalIdVersion: 2, segmentIndex: 1, mode: 'session' }
    const dependent: SessionState = { projectId: 'p', ownershipVersion: 2, sessionId: 'web:child', physicalIdVersion: 2, segmentIndex: 0, parent: { id: old, physicalId: physicalSessionId(bot, 0), index: 2 }, decisionOwnerSessionId: old }
    for (const state of [inbox, bot, dependent]) await store.saveState(state.sessionId, state)
    const pair = [{ role: 'assistant', content: '', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'unchanged', tool_call_id: 'tool-1' }]
    await store.createSessionLog(physicalSessionId(inbox), [{ sessionId: canonical }, { role: 'user', content: 'passive only', channel_input_id: 'receipt' }])
    await store.createSessionLog(physicalSessionId(bot, 0), [{ sessionId: old }, ...pair])
    await store.createSessionLog(physicalSessionId(bot, 1), [{ sessionId: old, previous_physical_id: physicalSessionId(bot, 0) }, { role: 'user', content: 'old admitted input' }])
    await store.createSessionLog(physicalSessionId(dependent), [{ sessionId: dependent.sessionId }])
    store.close?.()
    const before = (await readdir(directory)).sort()
    const dry = await migrateChannelSessions({ directory, manifest })
    assert.equal(dry.status, 'dry-run'); assert.equal(dry.migrated, 1)
    assert.deepEqual((await readdir(directory)).sort(), before)
    await assert.rejects(migrateChannelSessions({ directory, manifest, output, backup }), /runtimeStopped/)
    const result = await migrateChannelSessions({ directory, manifest, output, backup, runtimeStopped: true })
    assert.equal(result.status, 'staged')
    const original = new Store(directory), saved = new Store(backup), migrated = new Store(output)
    try {
      assert.ok(await original.getState(old)); assert.ok(await saved.getState(old))
      assert.equal(await migrated.getState(old), null)
      const merged = (await migrated.getState(canonical))!
      assert.equal(merged.segmentIndex, 3); assert.equal(merged.physicalIdVersion, 2)
      assert.equal(merged.recovery, undefined)
      assert.equal(merged.channelIdentityMigration, 1)
      const aliases = await readChannelSessionAliases(output, 'p')
      const compatible = withChannelSessionAliases(migrated, aliases)
      assert.equal((await compatible.getState(old))?.sessionId, canonical)
      assert.equal(aliases[physicalSessionId(bot, 0)], physicalSessionId(merged, 1))
      assert.deepEqual((await Array.fromAsync(compatible.readSessionLog(physicalSessionId(bot, 0)))).slice(1), pair)

      assert.deepEqual((await Array.fromAsync(migrated.readSessionLog(physicalSessionId(merged, 1)))).slice(1), pair)
      const child = (await migrated.getState('web:child'))!
      assert.equal(child.parent?.id, canonical); assert.equal(child.parent?.physicalId, physicalSessionId(merged, 1)); assert.equal(child.parent?.index, 2)
      const fresh = await Array.fromAsync(migrated.readSessionLog(physicalSessionId(merged)))
      assert.equal(fresh.length, 1); assert.equal(fresh[0]!.context_reset, true)
      assert.equal((await migrated.listSessions()).length, 2)
    } finally { original.close?.(); saved.close?.(); migrated.close?.() }
    const repeated = await migrateChannelSessions({ directory: output, manifest })
    assert.equal(repeated.status, 'already-migrated')
    await assert.rejects(migrateChannelSessions({ directory, manifest, output, backup, runtimeStopped: true }), /already exists/)
    assert.equal(await readFile(join(output, '.channel-session-migration-v1.receipt'), 'utf8').then(text => JSON.parse(text).projectId), 'p')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('migration rejects unknown archives, cross-project and unsupported reference fields without side effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-migration-refusal-'))
  try {
    const directory = join(root, 'sessions'), store = new JsonlSessionStore(directory); await store.init()
    const state: SessionState = { sessionId: old, projectId: 'p', ownershipVersion: 2, segmentIndex: 0, physicalIdVersion: 2 }
    await store.saveState(old, state); await store.createSessionLog(physicalSessionId(state), [{ sessionId: old }])
    await assert.rejects(migrateChannelSessions({ directory, manifest: { ...manifest, projectId: 'other' } }), /Invalid\/duplicate/)
    await store.appendRawEvents(physicalSessionId(state), [{ unknown_reference: old }])
    await assert.rejects(migrateChannelSessions({ directory, manifest }), /Unrecognized identity reference/)
    await store.deleteSessionLog(physicalSessionId(state)); await store.createSessionLog(physicalSessionId(state),[{sessionId:old}])
    await mkdir(join(directory, '.conversation-archive-v1')); await writeFile(join(directory, '.conversation-archive-v1', 'unsupported.bin'), 'fixture')
    await assert.rejects(migrateChannelSessions({ directory, manifest }), /Unknown auxiliary store file/)
    store.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy platform ID migration and exclusive tooling lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-migration-legacy-'))
  try {
    const directory = join(root, 'sessions'), store = new JsonlSessionStore(directory); await store.init()
    const legacy = 'qq:group:a', state: SessionState = { sessionId: legacy, projectId: 'p', ownershipVersion: 2, segmentIndex: 0 }
    await store.saveState(legacy, state)
    await store.createSessionLog(physicalSessionId(state), [{ sessionId: legacy }, { role: 'user', content: legacy }])
    const legacyManifest: ChannelMigrationManifest = { ...manifest, mappings: [{ from: legacy, source }] }
    await writeFile(`${directory}.channel-migration.lock`, 'other migration')
    await assert.rejects(migrateChannelSessions({ directory, manifest: legacyManifest, output: join(root, 'output'), backup: join(root, 'backup'), runtimeStopped: true }), { code: 'EEXIST' })
    assert.equal(await readFile(`${directory}.channel-migration.lock`, 'utf8'), 'other migration')
    await rm(`${directory}.channel-migration.lock`)
    const result = await migrateChannelSessions({ directory, manifest: legacyManifest, output: join(root, 'output'), backup: join(root, 'backup'), runtimeStopped: true })
    assert.equal(result.migrated, 1)
    const migrated = new JsonlSessionStore(join(root, 'output'))
    try {
      const merged = (await migrated.getState(canonical))!
      const records = await Array.fromAsync(migrated.readSessionLog(physicalSessionId(merged, 0)))
      assert.equal(records[0]!.sessionId, canonical)
      assert.equal(records[0]!.physicalIdVersion, 2)
      assert.equal(records[1]!.content, legacy, 'Evidence text is never rewritten')
    } finally { migrated.close() }
    store.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing physical segments fail before any output or backup is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-migration-missing-'))
  try {
    const directory = join(root, 'sessions'), store = new JsonlSessionStore(directory); await store.init()
    await store.saveState(old, { sessionId: old, projectId: 'p', ownershipVersion: 2, segmentIndex: 0, physicalIdVersion: 2 })
    const before = await readdir(root)
    await assert.rejects(migrateChannelSessions({ directory, manifest, output: join(root, 'output'), backup: join(root, 'backup'), runtimeStopped: true }), /Missing physical segment/)
    assert.deepEqual(await readdir(root), before)
    store.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`startup bot-only history without invented source ${Store.name}`, async () => {
  const { installChannelSessionsAtStartup } = await import('./channel-session-startup.ts')
  const root = await mkdtemp(join(tmpdir(), 'channel-startup-'))
  const directory = join(root, 'sessions')
  try {
    const store = new Store(directory); await store.init()
    const id = 'bot:p:c:discord:123', target = 'channel-inbox:p:c:discord:123'
    const state = { sessionId: id, projectId: 'p', ownershipVersion: 2, physicalIdVersion: 2, segmentIndex: 2,
      discordChannel: { channelId: '123', guildId: 'g' } } as SessionState & { discordChannel: { channelId: string; guildId: string } }
    await store.saveState(id, state)
    for (let segment = 0; segment <= 2; segment++) await store.createSessionLog(physicalSessionId(state, segment), [{ sessionId: id }, { role: 'user', content: `segment ${segment}` }])
    store.close?.()
    if (Store === SqliteSessionStore) {
      const db = new DatabaseSync(join(directory, 'sessions.db'))
      try {
        const row = db.prepare('SELECT prototype FROM session_states WHERE key=?').get(id)!
        const prototype = JSON.parse(String(row.prototype)); prototype.metadata.discordChannel = state.discordChannel
        db.prepare('UPDATE session_states SET prototype=? WHERE key=?').run(JSON.stringify(prototype), id)
      } finally { db.close() }
    }
    const plan = { version: 1, projectId: 'p', exclusiveRestart: true, manifest: { version: 1, projectId: 'p', mappings: [{ from: id,
      address: { projectId: 'p', botInstanceId: 'c', platform: 'discord', conversationId: '123' } }] } }
    await writeFile(`${directory}.channel-migration-plan.json`, JSON.stringify(plan))
    await assert.rejects(installChannelSessionsAtStartup(directory, 'other'), /Invalid/)
    assert.equal(await installChannelSessionsAtStartup(directory, 'p'), true)
    assert.equal(await installChannelSessionsAtStartup(directory, 'p'), false)
    const migrated = new Store(directory)
    try {
      // Inspect migration bytes directly; acceptance of the marker by live stores
      // is covered by the runtime worker's companion change.
      let raw: Record<string, unknown>
      if (Store === JsonlSessionStore) raw = JSON.parse(await readFile(join(directory, `${safeSessionId(target)}.json`), 'utf8'))
      else {
        const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
        try { const row = db.prepare('SELECT prototype, segment_count FROM session_states WHERE key=?').get(target)!; raw = { ...JSON.parse(String(row.prototype)).metadata, sessionId: target, segmentIndex: row.segment_count } } finally { db.close() }
      }
      const current = raw as unknown as SessionState & { channelIdentityMigration: number; discordChannel: unknown }
      assert.equal((await migrated.getState(target))?.channelIdentityMigration, 1, 'Normal runtime store loads a bot-only identity without fabricated origin')
      assert.equal(current.channelSource, undefined)
      assert.equal(current.channelIdentityMigration, 1)
      assert.deepEqual(current.discordChannel, state.discordChannel)
      assert.equal(current.segmentIndex, 3)
      for (let segment = 0; segment <= 2; segment++) assert.match(JSON.stringify(await Array.fromAsync(migrated.readSessionLog(physicalSessionId(current, segment)))), new RegExp(`segment ${segment}`))
      const receipt = JSON.parse(await readFile(join(directory, '.channel-session-migration-v1.receipt'), 'utf8'))
      assert.equal(receipt.aliases[id], target)
    } finally { migrated.close?.() }
    assert.ok((await readdir(`${directory}.pre-canonical`)).length)
    assert.ok((await readdir(`${directory}.canonical-backup`)).length)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`unrelated fresh/archive stores are preserved exactly; intersecting references fail closed (${Store.name})`, async () => {
  const { channelStoreFingerprint } = await import('./channel-session-migration.ts')
  const root = await mkdtemp(join(tmpdir(), 'channel-auxiliary-')), directory = join(root, 'sessions')
  try {
    const store = new Store(directory); await store.init()
    const bot: SessionState = {sessionId:old,projectId:'p',ownershipVersion:2,physicalIdVersion:2,segmentIndex:0}
    await store.saveState(old,bot); await store.createSessionLog(physicalSessionId(bot),[{sessionId:old}])
    const fresh: SessionState = {sessionId:'cron:unrelated',projectId:'p',ownershipVersion:2,physicalIdVersion:2,segmentIndex:0,mode:'task',executionId:'execution:unrelated',executionStatus:'completed',parentSessionId:'web:owner',automationCallerSettled:true,
      automation:{name:'daily',jobId:'daily',runId:'run:unrelated',contextMode:'fresh',startedAt:'2026-01-01T00:00:00.000Z'},statePersistence:{version:1,kind:'fresh-automation',jobId:'daily'}}
    await store.saveState(fresh.sessionId,fresh); await store.archiveState!(fresh)
    const cold: SessionState = {sessionId:'web:archived',projectId:'p',ownershipVersion:2,physicalIdVersion:2,segmentIndex:0,
      retirement:{retiredAt:new Date().toISOString(),fingerprint:'a'.repeat(64),assessorSessionId:'assessor',reason:'complete'}}
    await store.saveState(cold.sessionId,cold)
    await store.createSessionLog(physicalSessionId(cold),[{sessionId:cold.sessionId},{role:'user',content:'Unrelated archived evidence'}])
    await store.archiveConversation!(cold); store.close?.()
    const aux = `.fresh-automation-v1-${Store === JsonlSessionStore ? 'jsonl' : 'sqlite'}`
    const beforeFresh = await channelStoreFingerprint(join(directory,aux)), beforeCold = await channelStoreFingerprint(join(directory,'.conversation-archive-v1'))
    const output=join(root,'staged')
    await migrateChannelSessions({directory,manifest,output,backup:join(root,'backup'),runtimeStopped:true})
    assert.equal(await channelStoreFingerprint(join(output,aux)),beforeFresh)
    assert.equal(await channelStoreFingerprint(join(output,'.conversation-archive-v1')),beforeCold)
    const migrated = new Store(output)
    try {
      assert.equal((await migrated.readArchivedState!(fresh.sessionId))?.executionId,fresh.executionId)
      assert.deepEqual(await Array.fromAsync(migrated.readSessionLog(physicalSessionId(cold))),[{sessionId:cold.sessionId},{role:'user',content:'Unrelated archived evidence'}])
    } finally { migrated.close?.() }
    const db = new DatabaseSync(join(directory,aux,'archive.db'))
    try { db.prepare('UPDATE runs SET parent_id=?').run(old) } finally {db.close()}
    await assert.rejects(migrateChannelSessions({directory,manifest}),/Auxiliary store references/)
    const repair = new DatabaseSync(join(directory,aux,'archive.db'))
    try { repair.prepare('UPDATE runs SET parent_id=?').run('web:owner') } finally {repair.close()}
    const archive = new DatabaseSync(join(directory,'.conversation-archive-v1','archive.db'))
    try {
      const {gzipSync}=await import('node:zlib'),{createHash}=await import('node:crypto')
      const bytes=Buffer.from(JSON.stringify([{sourceSessionId:old}]))
      archive.prepare('UPDATE blocks SET data=?,size=?,checksum=?,count=1').run(gzipSync(bytes),bytes.length,createHash('sha256').update(bytes).digest('hex'))
    } finally {archive.close()}
    await assert.rejects(migrateChannelSessions({directory,manifest}),/Auxiliary store references/)
  } finally {await rm(root,{recursive:true,force:true})}
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`migration hides proven duplicate input without deleting raw coordinates (${Store.name})`, async () => {
  const {isDisplayDuplicate}=await import('../channels/recorded-input.ts')
  const root=await mkdtemp(join(tmpdir(),'channel-duplicate-')),directory=join(root,'sessions')
  try {
    const store=new Store(directory);await store.init()
    const inbox:SessionState={sessionId:canonical,projectId:'p',ownershipVersion:2,physicalIdVersion:2,segmentIndex:0,channelSource:source}
    const bot:SessionState={sessionId:old,projectId:'p',ownershipVersion:2,physicalIdVersion:2,segmentIndex:0}
    for(const state of [inbox,bot])await store.saveState(state.sessionId,state)
    const text='Same inbound', user={role:'user',content:[{type:'text',text:'<sender id="owner" />'},{type:'text',text}]}
    await store.createSessionLog(physicalSessionId(inbox),[{sessionId:canonical},{...user,channel_input_id:'platform-1'}])
    await store.createSessionLog(physicalSessionId(bot),[{sessionId:old},{decision_input:{id:'platform-1',text}},user,
      {role:'assistant',content:'Reply'}, {decision_input:{id:'different-input',text}}, user])
    store.close?.()
    const output=join(root,'output'),report=await migrateChannelSessions({directory,manifest,output,backup:join(root,'backup'),runtimeStopped:true})
    assert.ok('hiddenDuplicateInputs' in report); assert.equal(report.hiddenDuplicateInputs,1)
    const migrated=new Store(output)
    try {
      const state=(await migrated.getState(canonical))!,rows=[]
      for(let index=0;index<state.segmentIndex;index++)rows.push(...await Array.fromAsync(migrated.readSessionLog(physicalSessionId(state,index))))
      assert.equal(rows.filter(row=>row.role==='user').length,3,'Original records are retained')
      assert.equal(rows.filter(row=>row.role==='user'&&!isDisplayDuplicate(row)).length,2,'One receipt plus the genuinely different input remain visible')
      const executed=await Array.fromAsync(migrated.readSessionLog(physicalSessionId(state,1)))
      assert.equal(executed.length,6);assert.equal(executed[2].channel_history_duplicate_of,'platform-1')
      assert.equal(executed[3].content,'Reply');assert.equal(executed[5].channel_history_duplicate_of,undefined)
    }finally{migrated.close?.()}
  }finally{await rm(root,{recursive:true,force:true})}
})
