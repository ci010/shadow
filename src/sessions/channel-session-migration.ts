import { channelAuxiliaryDirectories, inspectChannelAuxiliary } from './channel-session-auxiliary.ts'
import { cp, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decodeChannelSource, passiveChannelId, type ChannelSource } from '../channels/passive-contract.ts'
import { physicalSessionId, hasTruncatedLegacyHistory } from './session-identity.ts'
import { safeSessionId } from '../utils/paths.ts'
import type { SessionState } from './session-store.ts'

/** Explicit operator-reviewed mapping; never infer a Connection from a display name. */
export interface ChannelMigrationManifest {
  version: 1
  projectId: string
  mappings: Array<{ from: string; source?: ChannelSource; address?: { projectId: string; botInstanceId: string; platform: string; conversationId: string } }>
}
interface Image {
  states: Map<string, Record<string, unknown>>
  logs: Map<string, Record<string, unknown>[]>
  format: 'jsonl' | 'sqlite'
}
export const channelMigrationReceipt = '.channel-session-migration-v1.receipt'
const marker = channelMigrationReceipt
const referenceKeys = new Set(['sessionId', 'session_id', 'sourceSessionId', 'targetSessionId', 'parentSessionId', 'createdBySessionId', 'decisionOwnerSessionId', 'workspaceRoot', 'reportTo', 'originUser', 'creatorSessionId', 'workerSessionId', 'reviewerSessionId', 'actorSessionId', 'physicalId', 'physicalSessionId', 'previous_physical_id', 'parent_physical_id', 'ownerSessionId', 'originSessionId', 'inboxSessionId'])
function rewrite(value: unknown, ids: Map<string, string>, key = '', parent = ''): unknown {
  if (['content', 'text', 'arguments', 'result'].includes(key)) return value
  if (typeof value === 'string') {
    const replacement = ids.get(value)
    if (!replacement || replacement === value) return value
    if (referenceKeys.has(key) || key === 'children' || key === 'id' && ['parent', 'origin', 'session'].includes(parent)) return replacement
    // Free text and provider/tool payloads are evidence, not identity fields.
    if (['content', 'text', 'arguments', 'result', 'description', 'name', 'senderName'].includes(key)) return value
    throw new Error(`Unrecognized identity reference field ${parent}.${key}; explicit migration support required`)
  }
  if (Array.isArray(value)) return value.map(item => rewrite(item, ids, key, parent))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, ids, k, key)]))
  return value
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
export async function channelStoreFingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256')
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported')
    if (entry.isDirectory()) hash.update(await channelStoreFingerprint(join(directory, entry.name)))
    else hash.update(await readFile(join(directory, entry.name)))
  }
  return hash.digest('hex')
}
async function load(directory: string): Promise<Image> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported')
    // Cold archive and fresh-automation have independent identity/index formats.
    // Never silently leave their references behind.
    if (entry.isDirectory()) {
      if (!channelAuxiliaryDirectories.has(entry.name) && (await readdir(join(directory, entry.name))).length) throw new Error('Unknown nonempty auxiliary directory')
    } else if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl') && !['sessions.db', 'sessions.db-wal', 'sessions.db-shm', marker].includes(entry.name)) {
      throw new Error(`Unknown session-store file ${entry.name}`)
    }
  }
  const image: Image = { states: new Map(), logs: new Map(), format: await exists(join(directory, 'sessions.db')) ? 'sqlite' : 'jsonl' }
  if (image.format === 'sqlite') {
    if (entries.some(e => e.name.endsWith('.jsonl') || e.name.endsWith('.json') && e.name !== marker)) throw new Error('Mixed JSONL/SQLite store is unsupported')
    // Opening a WAL database read-only may still create -shm/-wal files. Work
    // only on a disposable snapshot, including any committed WAL frames.
    const snapshot = await mkdtemp(join(tmpdir(), 'shadow-channel-migration-read-'))
    for (const suffix of ['', '-wal', '-shm']) if (await exists(join(directory, `sessions.db${suffix}`))) await cp(join(directory, `sessions.db${suffix}`), join(snapshot, `sessions.db${suffix}`))
    const db = new DatabaseSync(join(snapshot, 'sessions.db'), { readOnly: true })
    try {
      const columns = db.prepare('PRAGMA table_info(session_states)').all().map(row => String(row.name))
      if (columns.some(name => !['key', 'segment_count', 'last_activity_at', 'last_known_tokens', 'prototype'].includes(name))) throw new Error('Legacy/additional SQLite columns require an explicit migration')
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name)
      if (tables.some(name => !['session_states', 'session_logs'].includes(String(name)))) throw new Error('Additional SQLite tables require an explicit reference migration')
      for (const row of db.prepare('SELECT * FROM session_states').all()) {
        const prototype = JSON.parse(String(row.prototype))
        if (prototype.version !== 1 || !prototype.metadata) throw new Error('Unsupported SQLite prototype')
        image.states.set(String(row.key), { ...prototype.metadata, sessionId: row.key, segmentIndex: row.segment_count, lastActivityAt: row.last_activity_at ?? undefined, lastKnownTokens: row.last_known_tokens ?? undefined })
      }
      for (const row of db.prepare('SELECT session_id, data FROM session_logs ORDER BY seq').all()) {
        const id = String(row.session_id), records = image.logs.get(id) ?? []
        records.push(JSON.parse(String(row.data))); image.logs.set(id, records)
      }
    } finally { db.close(); await rm(snapshot, { recursive: true, force: true }) }
  } else {
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === marker) continue
      if (entry.name.endsWith('.json')) {
        const state = JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
        if (typeof state.sessionId !== 'string' || entry.name !== `${safeSessionId(state.sessionId)}.json`) throw new Error(`Invalid state filename ${entry.name}`)
        image.states.set(state.sessionId, state)
      } else if (entry.name.endsWith('.jsonl')) {
        const raw = await readFile(join(directory, entry.name), 'utf8')
        image.logs.set(entry.name.slice(0, -6), raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)))
      }
    }
  }
  return image
}
function plan(image: Image, manifest: ChannelMigrationManifest): { image: Image; ids: Map<string, string>; migrated: number; hiddenDuplicateInputs: number } {
  if (manifest.version !== 1 || !manifest.projectId || !Array.isArray(manifest.mappings) || !manifest.mappings.length) throw new Error('Invalid migration manifest')
  const ids = new Map<string, string>(), consumed = new Set<string>()
  const states = new Map(image.states), logs = new Map(image.logs)
  const groups = new Map<string, { source?: ChannelSource; from: string[] }>()
  for (const mapping of manifest.mappings) {
    const source = mapping.source === undefined ? undefined : decodeChannelSource(mapping.source)
    const address = source ?? (mapping.address && { ...mapping.address, connectionId: mapping.address.botInstanceId })
    if (!address || !['qq', 'discord', 'feishu', 'wechat'].includes(address.platform) || [address.projectId, address.connectionId, address.conversationId].some(v => typeof v !== 'string' || !v || /[\x00-\x1f\x7f]/.test(v))) throw new Error('Reviewed channel address required')
    const target = passiveChannelId(address)
    if (address.projectId !== manifest.projectId || typeof mapping.from !== 'string' || mapping.from === target || consumed.has(mapping.from)) throw new Error('Invalid/duplicate source mapping')
    const encoded = [address.projectId, address.connectionId, address.platform, address.conversationId].map(encodeURIComponent).join(':')
    if (mapping.from !== `bot:${encoded}` && mapping.from !== `${address.platform}:${address.conversationId}`) throw new Error('Source ID does not match the reviewed platform address')
    consumed.add(mapping.from)
    const group = groups.get(target) ?? { source, from: [] }
    if (group.source && source && JSON.stringify({ ...group.source, name: undefined }) !== JSON.stringify({ ...source, name: undefined })) throw new Error('Conflicting channel ancestry')
    group.source ??= source
    group.from.push(mapping.from); groups.set(target, group)
  }
  let migrated = 0, hiddenDuplicateInputs = 0
  for (const [target, group] of groups) {
    const present = group.from.filter(id => states.has(id))
    if (!present.length) {
      const existing = states.get(target)
      if (!existing) throw new Error(`Neither source nor canonical session exists: ${target}`)
      if (existing.projectId !== manifest.projectId || (existing.channelSource ? passiveChannelId(decodeChannelSource(existing.channelSource)) !== target : existing.channelIdentityMigration !== 1)) throw new Error('Canonical session metadata mismatch')
      continue
    }
    const participants = [...(states.has(target) ? [target] : []), ...present]
    let nextIndex = 0
    const combined: Record<string, unknown>[] = []
    for (const id of participants) {
      const state = states.get(id)!
      if (state.projectId !== manifest.projectId || !Number.isSafeInteger(state.segmentIndex) || Number(state.segmentIndex) < 0 || Number(state.segmentIndex) > 4096) throw new Error(`Invalid Project/segment metadata: ${id}`)
      if (hasTruncatedLegacyHistory(state as unknown as SessionState)) throw new Error(`Ambiguous truncated physical identity: ${id}`)
      if (state.statePersistence || state.automaticWork || state.automation || state.retirement) throw new Error(`Unsupported automated/retired participant: ${id}`)
      if (state.channelSource) {
        const existingSource = decodeChannelSource(state.channelSource)
        if (passiveChannelId(existingSource) !== target || group.source && ['kind', 'parentId', 'guildId', 'recipientId', 'botUserId'].some(key => existingSource[key as keyof ChannelSource] !== group.source![key as keyof ChannelSource])) throw new Error('Existing channel source/ancestry mismatch')
        group.source ??= existingSource
      }
      ids.set(id, target)
      for (let index = 0; index <= Number(state.segmentIndex); index++) {
        const old = physicalSessionId(state as unknown as SessionState, index)
        const fresh = physicalSessionId({ sessionId: target, segmentIndex: nextIndex++, physicalIdVersion: 2 })
        const records = logs.get(old)
        if (!records) throw new Error(`Missing physical segment ${old}`)
        if (ids.has(old) && ids.get(old) !== fresh) throw new Error('Physical identity collision')
        ids.set(old, fresh); logs.delete(old)
        combined.push({ old, fresh, records })
      }
      states.delete(id)
    }
    // Preserve each original segment verbatim in order (never interleave tools).
    for (const segment of combined) {
      if (logs.has(String(segment.fresh))) throw new Error('Destination physical identity already exists')
      logs.set(String(segment.fresh), segment.records as Record<string, unknown>[])
    }
    // Preserve raw coordinates/tool pairs. Hide only a provably duplicated
    // executed user row: same platform input ID as a common receipt, followed
    // through its host decision_input marker and exact normalized text.
    const receiptIds = new Set<string>()
    for (const segment of combined) for (const record of segment.records as Record<string, unknown>[]) {
      if (typeof record.channel_input_id === 'string') receiptIds.add(record.channel_input_id)
    }
    for (const segment of combined) {
      let pending: {id:string;text:string} | undefined
      for (const record of segment.records as Record<string, unknown>[]) {
        if (record.decision_input && typeof record.decision_input === 'object') {
          const input = record.decision_input as Record<string, unknown>
          pending = typeof input.id === 'string' && typeof input.text === 'string' && receiptIds.has(input.id) ? {id:input.id,text:input.text} : undefined
        }
        if (record.role !== 'user' || record.channel_input_id || !pending) continue
        const parts = Array.isArray(record.content) ? record.content as Array<{type?:string;text?:string}> : []
        if (parts[0]?.type === 'text' && /^<sender\s/.test(parts[0].text ?? '') && parts[1]?.type === 'text' && parts[1].text === pending.text) {
          record.channel_history_duplicate_of = pending.id
          hiddenDuplicateInputs++
          pending = undefined
        }
      }
    }
    // Start clean: migration is history/navigation only, never replay old input or
    // pending tool calls. The next live admission still verifies current policy.
    const winner = image.states.get(present.at(-1)!)!
    const timestamp = new Date().toISOString()
    const merged = { ...winner, sessionId: target, physicalIdVersion: 2, segmentIndex: nextIndex,
      channelSource: group.source, channelIdentityMigration: 1, contextResetAt: timestamp, lastKnownTokens: 0, executionStatus: 'pending',
      recovery: undefined, preloadTools: undefined, serviceGeneration: undefined, channelBoundary: undefined }
    states.set(target, merged)
    const freshPhysical = physicalSessionId(merged as unknown as SessionState)
    if (logs.has(freshPhysical)) throw new Error('Fresh physical identity already exists')
    logs.set(freshPhysical, [{ sessionId: target, timestamp, context_reset: true, channel_identity_migration: 1 }])
    migrated += present.length
  }
  const rewrittenStates = new Map([...states].map(([id, state]) => [id, rewrite(state, ids) as Record<string, unknown>]))
  const rewrittenLogs = new Map([...logs].map(([id, records]) => [id, records.map(record => {
    const rewritten = rewrite(record, ids) as Record<string, unknown>
    return typeof record.sessionId === 'string' && ids.has(record.sessionId)
      ? { ...rewritten, physicalIdVersion: 2 } : rewritten
  })]))
  return { image: { ...image, states: rewrittenStates, logs: rewrittenLogs }, ids, migrated, hiddenDuplicateInputs }
}
async function save(directory: string, original: Image, image: Image): Promise<void> {
  if (image.format === 'jsonl') {
    for (const id of original.states.keys()) await rm(join(directory, `${safeSessionId(id)}.json`))
    for (const id of original.logs.keys()) await rm(join(directory, `${id}.jsonl`))
    const filenames = new Set<string>()
    for (const [id, state] of image.states) {
      const filename = `${safeSessionId(id)}.json`
      if (filenames.has(filename)) throw new Error('State filename collision')
      filenames.add(filename); await writeFile(join(directory, filename), JSON.stringify(state, null, 2))
    }
    for (const [id, records] of image.logs) await writeFile(join(directory, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  } else {
    const db = new DatabaseSync(join(directory, 'sessions.db'))
    try {
      db.exec('BEGIN IMMEDIATE; DELETE FROM session_states; DELETE FROM session_logs;')
      const stateInsert = db.prepare('INSERT INTO session_states(key,segment_count,last_activity_at,last_known_tokens,prototype) VALUES (?,?,?,?,?)')
      for (const [id, state] of image.states) {
        const { sessionId: _id, segmentIndex, lastActivityAt, lastKnownTokens, ...metadata } = state
        stateInsert.run(id, Number(segmentIndex), String(lastActivityAt ?? '') || null, lastKnownTokens === undefined ? null : Number(lastKnownTokens), JSON.stringify({ version: 1, metadata }))
      }
      const logInsert = db.prepare('INSERT INTO session_logs(session_id,data) VALUES (?,?)')
      for (const [id, records] of image.logs) for (const record of records) logInsert.run(id, JSON.stringify(record))
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);')
    } finally { db.close() }
  }
}
export interface ChannelMigrationOptions {
  directory: string
  manifest: ChannelMigrationManifest
  /** Apply only builds a new store and backup; it NEVER replaces a live directory. */
  output?: string
  backup?: string
  runtimeStopped?: boolean
}
/** Offline, fail-closed export. Dry-run is read-only and the default. */
export async function migrateChannelSessions(options: ChannelMigrationOptions) {
  const directory = resolve(options.directory)
  const digest = createHash('sha256').update(JSON.stringify(options.manifest)).digest('hex')
  if (await exists(join(directory, marker))) {
    const receipt = JSON.parse(await readFile(join(directory, marker), 'utf8'))
    if (receipt.manifestHash !== digest) throw new Error('Store already migrated with a different manifest')
    return { status: 'already-migrated', migrated: 0 }
  }
  if (options.output && (!options.runtimeStopped || !options.backup)) throw new Error('Apply requires runtimeStopped and an explicit backup path')
  const lockPath = `${directory}.channel-migration.lock`
  const lock = options.output ? await open(lockPath, 'wx') : undefined
  try {
    const originalHash = await channelStoreFingerprint(directory)
    const original = await load(directory), result = plan(original, options.manifest)
    for (const id of result.image.logs.keys()) if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Unsupported physical log filename')
    const auxiliary = await inspectChannelAuxiliary(directory, result.ids)
    const sourceStable = await channelStoreFingerprint(directory) === originalHash
    if (!sourceStable) throw new Error('Source changed during migration planning; stop all writers')
    const report = { status: options.output ? 'staged' : 'dry-run', migrated: result.migrated, identities: Object.fromEntries(result.ids), format: original.format, auxiliary, sourceStable, hiddenDuplicateInputs: result.hiddenDuplicateInputs }
    if (!options.output) return report
    const output = resolve(options.output), backup = resolve(options.backup!)
    if ([output, backup].some(path => path === directory || path.startsWith(directory + '/') || directory.startsWith(path + '/')) || output === backup || output.startsWith(backup + '/') || backup.startsWith(output + '/')) throw new Error('Source/output/backup must be distinct, non-nested directories')
    if (await exists(output) || await exists(backup)) throw new Error('Output/backup already exists; refusing overwrite')
    const temporary = `${output}.pending-${crypto.randomUUID()}`
    try {
      await cp(directory, backup, { recursive: true, errorOnExist: true, force: false })
      await cp(directory, temporary, { recursive: true, errorOnExist: true, force: false })
      await save(temporary, original, result.image)
      for (const entry of await readdir(directory, {withFileTypes:true})) if (entry.isDirectory()) {
        const before = await channelStoreFingerprint(join(directory,entry.name))
        if (before !== await channelStoreFingerprint(join(temporary,entry.name))) throw new Error('Auxiliary preservation verification failed')
      }
      const verified = await load(temporary)
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value))
      const { isDeepStrictEqual } = await import('node:util')
      if (!isDeepStrictEqual(normalize([...verified.states].sort()), normalize([...result.image.states].sort()))
        || !isDeepStrictEqual(normalize([...verified.logs].sort()), normalize([...result.image.logs].sort()))) throw new Error('Staged store verification failed')
      await writeFile(join(temporary, marker), JSON.stringify({ version: 1, manifestHash: digest, projectId: options.manifest.projectId, aliases: Object.fromEntries([...result.ids].filter(([id]) => original.states.has(id))), report }, null, 2))
      if (await channelStoreFingerprint(directory) !== originalHash || await channelStoreFingerprint(backup) !== originalHash) throw new Error('Source changed or backup verification failed; stop all writers and use new output/backup paths')
      await rename(temporary, output)
    } finally { await rm(temporary, { recursive: true, force: true }) }
    return { ...report, output, backup }
  } finally { await lock?.close(); if (lock) await rm(lockPath) }
}
