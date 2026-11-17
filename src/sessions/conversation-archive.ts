import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { physicalSessionId, hasTruncatedLegacyHistory } from './session-identity.ts'
import { retirementReceiptSchema } from './retirement-contract.ts'
import type { SessionStore, SessionState, ConversationArchiveQuery, ConversationArchivePage, ConversationArchiveRange, ArchiveReference } from './session-store.ts'
import { conversationArchiveWorkerSource } from './conversation-archive-worker.ts'

const MAX_RECORD = 16 * 1024 * 1024 - 2
const BLOCK_BYTES = 256 * 1024
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
}
interface Source { physical: string; hash: string; count: number }
interface Pending { id: string; state: SessionState; sources: Source[] }

/**
 * Version 1 ordinary cold storage; fresh automation retains its separate index.
 * Archive SQLite/gzip lives exclusively in a self-contained worker. One RPC is
 * outstanding; admission is capped at 32 operations / 32MiB retained input.
 * Blocks target 256KiB / 1000 records; a single record may grow to <16MiB.
 * State is limited to 1MiB and 4097 segments. Range output targets 16MiB
 * (plus small JSON envelope), with nextOffset whenever more raw records exist.
 *
 * Commit and verify precede source deletion. Durable pending tasks retain the
 * original active revision and per-physical canonical record fingerprints.
 * Startup visits only the partial pending index, in batches of 16. Missing
 * sources represent already-completed cleanup; changed sources fail closed.
 * Transfers have a separate bounded queue (one transfer buffer at a time).
 * Only worker RPCs serialize with reads; transfers lock their own IDs.
 * Known active IDs bypass archive RPCs, so unrelated chats remain writable.
 * This is not a cross-process locking protocol for external file editors.
 */
export class ConversationArchive {
  private worker?: Worker
  private closed = false
  private sequence = 0
  private requests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private queued = 0
  private queuedBytes = 0
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private directory: string, private readOnly = false, private format: 'jsonl' | 'sqlite' = 'jsonl') {}
  private send<T>(op: string, args: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Archive closed'))
    if (this.requests.size) return Promise.reject(new Error('Archive worker request already outstanding'))
    if (!this.worker) {
      const worker = new Worker(conversationArchiveWorkerSource, { eval: true, execArgv: [], workerData: { path: join(this.directory, '.conversation-archive-v1', 'archive.db'), readOnly: this.readOnly } })
      worker.unref()
      this.worker = worker
      const fail = (error: Error) => { if (this.worker !== worker) return; for (const r of this.requests.values()) r.reject(error); this.requests.clear(); if (this.worker === worker) this.worker = undefined }
      worker.on('error', fail)
      worker.on('exit', () => fail(new Error('Archive worker exited')))
      worker.on('message', ({ id, result, error }) => {
        const r = this.requests.get(id); this.requests.delete(id)
        if (!this.requests.size) worker.unref()
        if (error) r?.reject(new Error(error)); else r?.resolve(result)
      })
    }
    const worker = this.worker
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.requests.set(id, { resolve, reject }); worker.ref()
      try { worker.postMessage({ id, op, args }) } catch (e) { this.requests.delete(id); worker.unref(); reject(e) }
    })
  }
  private rpc<T>(op: string, args: unknown = {}): Promise<T> {
    const bytes = Buffer.byteLength(JSON.stringify(args))
    return this.serial(() => this.send<T>(op, args), bytes)
  }
  private keyTails = new Map<string, Promise<unknown>>()
  private keyCounts = new Map<string, number>()
  private retainedBytes = 0
  private membership = new Map<string, boolean>()
  private async has(id: string): Promise<boolean> {
    if (this.closed) throw new Error('Archive closed')
    const cached = this.membership.get(id)
    if (cached !== undefined) return cached
    const archived = await this.rpc<boolean>('has', { id })
    this.membership.set(id, archived)
    return archived
  }
  private operation<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.resolve().then(() => { if (this.closed) throw new Error('Archive closed'); return fn() })
  }
  /** Transfer locks only the logical ID and its physical sources, not other chats. */
  private withKeys<T>(keys: string[], fn: () => Promise<T>, bytes = 0): Promise<T> {
    keys = [...new Set(keys)]
    if (this.retainedBytes + bytes > 32 * 1024 * 1024 || keys.some(k => (this.keyCounts.get(k) ?? 0) >= 32)) return Promise.reject(new Error('Session operation queue full'))
    this.retainedBytes += bytes
    const previous = keys.map(k => this.keyTails.get(k) ?? Promise.resolve())
    for (const k of keys) this.keyCounts.set(k, (this.keyCounts.get(k) ?? 0) + 1)
    const result = Promise.all(previous).then(() => this.operation(fn))
    const done = result.then(() => {}, () => {}).finally(() => {
      this.retainedBytes -= bytes
      for (const k of keys) {
        const count = this.keyCounts.get(k)! - 1
        if (count) this.keyCounts.set(k, count); else this.keyCounts.delete(k)
        if (this.keyTails.get(k) === done) this.keyTails.delete(k)
      }
    })
    for (const k of keys) this.keyTails.set(k, done)
    return result
  }
  private transferTail: Promise<unknown> = Promise.resolve()
  private transfers = 0
  /** Bound transfer buffers separately; unrelated active operations never join this queue. */
  private transfer<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transfers >= 32) return Promise.reject(new Error('Archive transfer queue full (32)'))
    this.transfers++
    const result = this.transferTail.then(() => this.operation(fn))
    this.transferTail = result.then(() => {}, () => {}).finally(() => { this.transfers-- })
    return result
  }
  private serial<T>(fn: () => Promise<T>, bytes = 0): Promise<T> {
    if (this.queued >= 32 || this.queuedBytes + bytes > 32 * 1024 * 1024) return Promise.reject(new Error('Archive operation queue full (32)'))
    this.queued++; this.queuedBytes += bytes
    const result = this.tail.then(() => { if (this.closed) throw new Error('Archive closed'); return fn() })
    this.tail = result.catch(() => {}).finally(() => { this.queued--; this.queuedBytes -= bytes })
    return result
  }
  close(): void {
    this.closed = true
    for (const r of this.requests.values()) r.reject(new Error('Archive closed'))
    this.requests.clear()
    const worker = this.worker
    this.worker = undefined
    if (!worker) return
    // SessionStore.close is synchronous. Terminate alone returns before Windows
    // releases SQLite/WAL handles, so acknowledge database closure off-thread.
    // Only teardown waits here; normal archive work never blocks this thread.
    const closed = new Int32Array(new SharedArrayBuffer(4))
    try {
      worker.postMessage({ id: ++this.sequence, op: 'close', args: { closed: closed.buffer } })
      if (Atomics.wait(closed, 0, 0, 5000) === 'timed-out') throw new Error('Archive worker close timed out')
      if (Atomics.load(closed, 0) !== 1) throw new Error('Archive worker database close failed')
    } finally { void worker.terminate() }
  }
  private async *strictJsonl(physical: string): AsyncIterable<Record<string, unknown>> {
    const stream = createReadStream(join(this.directory, physical + '.jsonl'), { encoding: 'utf8', highWaterMark: 64 * 1024 })
    let buffer = ''
    const parse = (line: string) => {
      if (Buffer.byteLength(line) > MAX_RECORD) throw new RangeError('Archive record exceeds 16MiB limit')
      const record: unknown = JSON.parse(line)
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Invalid archive raw record')
      return record as Record<string, unknown>
    }
    try {
      for await (const chunk of stream) {
        buffer += chunk
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          if (line.trim()) yield parse(line)
        }
        if (Buffer.byteLength(buffer) > MAX_RECORD) throw new RangeError('Archive record exceeds 16MiB limit')
      }
      if (buffer.trim()) yield parse(buffer)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    finally { stream.destroy() }
  }
  install(store: SessionStore, strictSource?: (id: string) => AsyncIterable<Record<string, unknown>>): void {
    // Capture private active-backend routes before exposing immutable archive-aware routes.
    const get = store.getState.bind(store), read = store.readSessionLog.bind(store)
    const sourceRead = strictSource ?? this.strictJsonl.bind(this)
    const deleteState = store.deleteState.bind(store), deleteLog = store.deleteSessionLog.bind(store)
    const oldInit = store.init.bind(store), oldClose = store.close?.bind(store)
    const oldArchived = store.readArchivedState?.bind(store), oldRefs = store.listArchiveReferences?.bind(store)
    const fingerprint = async (physical: string): Promise<Source> => {
      const hash = createHash('sha256'); let count = 0
      for await (const record of sourceRead(physical)) { hash.update(canonical(record) + '\n'); count++ }
      return { physical, hash: hash.digest('hex'), count }
    }
    const cleanup = async (pending: Pending) => {
      await this.rpc('verify', { id: pending.id, pending })
      const current = await get(pending.id)
      if (current && !isDeepStrictEqual(JSON.parse(canonical(current)), JSON.parse(canonical(pending.state)))) throw new Error('Archive cleanup state revision conflict')
      // Preflight every remaining source before touching any source. Missing means already removed.
      for (const source of pending.sources) {
        const now = await fingerprint(source.physical)
        let exists = now.count > 0
        if (this.format === 'jsonl') { try { await stat(join(this.directory, source.physical + '.jsonl')); exists = true } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } }
        if (exists && (now.hash !== source.hash || now.count !== source.count)) throw new Error('Archive cleanup source fingerprint conflict')
      }
      for (const source of pending.sources) await deleteLog(source.physical)
      if (current) {
        const latest = await get(pending.id)
        if (latest && canonical(latest) !== canonical(pending.state)) throw new Error('Archive cleanup state revision conflict')
        if (latest) await deleteState(pending.id)
      }
      await this.rpc('done', { id: pending.id })
    }
    store.init = async () => {
      await oldInit()
      if (!this.readOnly) await this.operation(async () => {
        while (true) {
          const pending = await this.rpc<Pending[]>('pending')
          if (!pending.length) break
          for (const p of pending) await this.withKeys([p.id, ...p.sources.map(s => s.physical)], () => cleanup(p))
        }
      })
    }
    store.close = () => { if (this.closed) return; this.close(); oldClose?.() }
    store.isConversationArchived = id => this.operation(() => this.rpc<boolean>('has', { id }))
    store.readArchivedState = id => this.operation(async () => await this.rpc<SessionState | null>('state', { id }) ?? await oldArchived?.(id) ?? null)
    store.listArchiveReferences = () => this.operation(async () => {
      const refs = [...await this.rpc<ArchiveReference[]>('references'), ...await oldRefs?.() ?? []]
      return [...new Map(refs.map(ref => [canonical(ref), ref])).values()]
    })
    store.queryConversationArchives = (query: ConversationArchiveQuery = {}) => this.operation(async () => {
      const limit = query.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Archive page limit must be 1..200')
      let at = '', id = ''
      if (query.cursor) {
        try {
          if (query.cursor.length > 4096) throw new TypeError('Invalid archive cursor')
          const c: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
          if (!Array.isArray(c) || c.length !== 2 || c.some(v => typeof v !== 'string')) throw new TypeError('Invalid archive cursor')
          ;[at, id] = c
        } catch { throw new TypeError('Invalid archive cursor') }
      }
      return this.rpc<ConversationArchivePage>('query', { ...query, limit, at, id })
    })
    const range = (id: string, offset: number, limit: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Archive range offset >=0 and limit 1..1000 required')
      return this.rpc<ConversationArchiveRange | null>('range', { id, offset, limit })
    }
    store.readArchivedLogRange = (id, offset, limit) => this.operation(() => range(id, offset, limit))
    store.getState = id => this.operation(async () => await this.has(id) ? null : get(id))
    for (const method of ['listAllStates', 'listSessions'] as const) {
      const original = store[method].bind(store)
      ;(store as any)[method] = () => this.operation(async () => {
        const result = await original()
        if (Array.isArray(result)) { const out = []; for (const row of result) if (!await this.has(row.sessionId)) out.push(row); return out }
        for (const id of Object.keys(result)) if (await this.has(id)) delete result[id]
        return result
      })
    }
    for (const method of ['saveState', 'deleteState', 'appendMessages', 'appendRawEvents', 'createSessionLog', 'deleteSessionLog'] as const) {
      const original = store[method].bind(store) as (...args: any[]) => Promise<void>
      ;(store as any)[method] = (...args: any[]) => {
        const admissionBytes = Buffer.byteLength(JSON.stringify(args))
        if (admissionBytes > 16 * 1024 * 1024) return Promise.reject(new RangeError('Store mutation exceeds 16MiB admission limit'))
        return this.withKeys(method === 'saveState' ? [args[0], args[1].sessionId] : [args[0]], async () => {
        if (this.readOnly) throw new Error('Read-only store')
        if (await this.has(args[0]) || (method === 'saveState' && await this.has(args[1].sessionId))) throw new Error('Conversation archive is immutable')
        await original(...args)
        }, admissionBytes)
      }
    }
    const hasArchive = (id: string) => this.has(id)
    store.readSessionLog = async function* (id) {
      if (!await hasArchive(id)) { yield* read(id); return }
      let offset = 0
      while (true) {
        const page = await store.readArchivedLogRange!(id, offset, 128)
        if (!page) { yield* read(id); return }
        yield* page.records; offset += page.records.length
        if (offset >= page.total) return
      }
    }
    const oldCount = store.countSessionLog.bind(store), oldFirst = store.readFirstRecord.bind(store)
    store.countSessionLog = id => this.operation(async () => !await this.has(id) ? oldCount(id) : (await range(id, 0, 1))?.total ?? 0)
    store.readFirstRecord = id => this.operation(async () => { if (!await this.has(id)) return oldFirst(id); const r = await range(id, 0, 1); return r ? r.records[0] ?? null : oldFirst(id) })
    store.archiveConversation = input => {
      const snapshot = JSON.stringify(input)
      const admissionBytes = Buffer.byteLength(snapshot)
      if (admissionBytes > 1024 * 1024) return Promise.reject(new RangeError('Archive state exceeds 1MiB'))
      const state: SessionState = JSON.parse(snapshot)
      if (!Number.isSafeInteger(state.segmentIndex) || state.segmentIndex < 0 || state.segmentIndex > 4096) return Promise.reject(new Error('Invalid segment index'))
      const keys = [state.sessionId, ...Array.from({ length: state.segmentIndex + 1 }, (_, i) => physicalSessionId(state, i))]
      return this.transfer(() => this.withKeys(keys, async () => {
      if (this.readOnly) throw new Error('Read-only store')
      if (!state.retirement || state.statePersistence) throw new Error('Only retired ordinary conversations can be archived')
      retirementReceiptSchema.parse(state.retirement)
      if (hasTruncatedLegacyHistory(state)) throw new Error('Ambiguous truncated legacy history cannot be archived')
      if (!Number.isSafeInteger(state.segmentIndex) || state.segmentIndex < 0 || state.segmentIndex > 4096) throw new Error('Invalid segment index')
      if (await this.has(state.sessionId)) throw new Error('Conversation already archived')
      const current = await get(state.sessionId)
      if (!current || canonical({ ...current, retirement: undefined }) !== canonical({ ...state, retirement: undefined })) throw new Error('Archive state revision conflict')
      const at = new Date().toISOString(), sources: Source[] = []
      let recordCount = 0, byteLength = 0
      if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new RangeError('Archive state exceeds 1MiB')
      await this.rpc('abort', { id: state.sessionId })
      await this.rpc('begin', { state, at })
      try {
        for (let i = 0; i <= state.segmentIndex; i++) {
          const physical = physicalSessionId(state, i), hash = createHash('sha256')
          await this.rpc('segment', { physical, owner: state.sessionId })
          let records: Record<string, unknown>[] = [], bytes = 2, count = 0
          const flush = async () => { if (!records.length) return; await this.rpc('block', { physical, start: count - records.length, records }); records = []; bytes = 2 }
          for await (const record of sourceRead(physical)) {
            const text = canonical(record), size = Buffer.byteLength(text)
            if (size > MAX_RECORD) throw new Error('Archive record exceeds 16MiB limit')
            if (bytes + size + 1 > BLOCK_BYTES) await flush()
            records.push(record); bytes += size + 1; count++; recordCount++; byteLength += size + 1; hash.update(text + '\n')
            if (bytes >= BLOCK_BYTES || records.length >= 1000) await flush()
          }
          await flush(); sources.push({ physical, hash: hash.digest('hex'), count })
        }
        const pending = { state: current, sources }
        await this.rpc('commit', { id: state.sessionId, pending, summary: { sessionId: state.sessionId, projectId: state.projectId, topic: state.topic, name: state.name, archivedAt: at, lastActivityAt: state.lastActivityAt, segmentIndex: state.segmentIndex, recordCount, byteLength }, reference: state.projectId ? { projectId: state.projectId, folderId: state.folderId, workdir: state.workdir } : undefined })
      } catch (error) { for (const id of keys) this.membership.delete(id); await this.rpc('abort', { id: state.sessionId }); throw error }
      for (const id of keys) this.membership.set(id, true)
      await cleanup({ id: state.sessionId, state: current, sources })
      }, admissionBytes))
    }
  }
}
