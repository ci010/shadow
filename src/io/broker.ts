import { resolveLegacyProjectPath } from '../storage/legacy-paths.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  IO_FINALIZE_MS, IO_LEASE_MS, IO_MAX_ARTIFACTS, IO_MAX_BUFFER_BYTES, IO_MAX_CHUNK_BYTES,
  IO_MAX_CLIENTS, IO_MAX_RUNS, IO_TERMINAL, IoError, ioClientSchema, parseIoDefinition, parseIoUi,
  type IoArtifact, type IoClient, type IoPacket, type IoRelayEffect, type IoRelayUpdate, type IoRun, type IoRunStatus,
} from './contracts.ts'
import { IO_EVENT_MAX_BYTES, IO_PROCESSING_MS, IoRelay, parseIoPacket } from './relay.ts'

interface ClientRecord extends IoClient { token: string }
interface Lease { token: string; clientId: string; expires: number }
export interface IoCredentials { clientId: string; clientToken: unknown; leaseToken: unknown }
interface ActiveRun {
  run: IoRun
  lease?: Lease
  relay?: IoRelay
  preparing?: Promise<void>
  tail: Promise<void>
  queued: number
  inputsEnded: boolean
  processingAt?: number
  finishing?: Promise<IoRun>
  journal: Array<{ update: IoRelayUpdate; bytes: number }>
  journalBytes: number
  cursor: number
}

export interface IoBrokerOptions {
  projectId: string
  workspace: string
  assertSession(sessionId: string): void
  sessionDirectory(sessionId: string): string
  changed?(run: IoRun): void
  finished?(run: IoRun): Promise<void>
  now?: () => number
  connectTimeoutMs?: number
  ackTimeoutMs?: number
  processingTimeoutMs?: number
}

function sameSecret(value: unknown, secret: string): boolean {
  if (typeof value !== 'string') return false
  const a = Buffer.from(value), b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function revision(definition: unknown): string { return createHash('sha256').update(JSON.stringify(definition)).digest('hex') }
function active(run: IoRun): ActiveRun {
  return { run, tail: Promise.resolve(), queued: 0, inputsEnded: false, journal: [], journalBytes: 0, cursor: 0 }
}

export class IoBroker {
  private readonly runs = new Map<string, ActiveRun>()
  private readonly clients = new Map<string, ClientRecord>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly root: string
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private shutdownPromise?: Promise<void>
  private bufferedBytes = 0

  constructor(readonly options: IoBrokerOptions) {
    this.root = projectStoragePath(options.workspace, '.io', 'runs')
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const name of await readdir(this.root)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      try {
        const value = JSON.parse(await readFile(join(this.root, name), 'utf8')) as Record<string, unknown>
        if (value.definition && typeof value.definition === 'object' && 'program' in value.definition) {
          console.warn(`[io] Migration: retained legacy program-based run ${name}; it is not loaded or executed.`)
          continue
        }
        if (value.version !== 1 || value.id !== name.slice(0, -5) || value.projectId !== this.options.projectId ||
          typeof value.sessionId !== 'string' || typeof value.status !== 'string' ||
          !['awaiting_consent', 'running', 'stopping', ...IO_TERMINAL].includes(value.status)) throw new Error('Invalid run identity')
        const definition = parseIoDefinition(value.definition)
        if (value.revision !== revision(definition) || typeof value.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(value.createdAt)) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 ||
          !Array.isArray(value.artifacts) || value.artifacts.length > IO_MAX_ARTIFACTS) throw new Error('Invalid persisted run')
        const artifacts = value.artifacts.map((item: IoArtifact) => {
          if (!item || typeof item.id !== 'string' || typeof item.path !== 'string' || !isAbsolute(item.path) ||
            typeof item.name !== 'string' || typeof item.mime !== 'string' ||
            !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.complete !== 'boolean') throw new Error('Invalid artifact record')
          return { id: item.id, name: item.name, mime: item.mime, size: item.size, complete: item.complete, path: item.path }
        })
        const run: IoRun = {
          version: 1, id: String(value.id), projectId: this.options.projectId, sessionId: value.sessionId,
          definition, revision: String(value.revision), status: value.status as IoRunStatus,
          createdAt: value.createdAt, bytes: Number(value.bytes), artifacts, backendStatus: 'disconnected',
          ui: value.ui === undefined ? definition.ui : parseIoUi(value.ui),
          ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
          ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
          ...(typeof value.error === 'string' ? { error: value.error.slice(0, 2000) } : {}),
          ...(typeof value.message === 'string' ? { message: value.message.slice(0, 4000) } : {}),
        }
        const record = active(run)
        this.runs.set(run.id, record)
        if (run.status === 'running' || run.status === 'stopping') {
          run.status = 'interrupted'
          run.error = 'The application restarted; start a new capture with fresh consent.'
          run.finishedAt = new Date(this.now()).toISOString()
          await this.persist(record)
        }
      } catch (error) {
        console.warn(`[io] Retained but skipped invalid I/O run ${name}: ${message(error)}`)
      }
    }
    this.timer = setInterval(() => {
      this.track(this.expire().catch(error => console.error('[io] Lease cleanup failed', message(error))))
    }, 1000)
    this.timer.unref()
  }

  private live(): void { if (this.stopped) throw new IoError('io_stopped', 'I/O runtime is stopped', 503) }
  private record(id: string, sessionId?: string): ActiveRun {
    this.live()
    const record = this.runs.get(id)
    if (!record || (sessionId !== undefined && record.run.sessionId !== sessionId)) throw new IoError('run_not_found', 'I/O run not found', 404)
    this.options.assertSession(record.run.sessionId)
    return record
  }
  private snapshot(record: ActiveRun): IoRun { return structuredClone(record.run) }
  private changed(record: ActiveRun): void { this.options.changed?.(this.snapshot(record)) }

  list(sessionId?: string): IoRun[] {
    this.live()
    if (sessionId !== undefined) this.options.assertSession(sessionId)
    return [...this.runs.values()].filter(record => {
      if (sessionId !== undefined && record.run.sessionId !== sessionId) return false
      try { this.options.assertSession(record.run.sessionId); return true } catch { return false }
    }).slice(-100).map(record => this.snapshot(record))
  }
  get(id: string, sessionId?: string): IoRun { return this.snapshot(this.record(id, sessionId)) }
  capabilities() {
    this.live()
    return {
      clients: [...this.clients.values()].filter(client => this.now() - client.lastSeen < IO_LEASE_MS)
        .map(({ token: _token, ...client }) => structuredClone(client)),
      limits: { maxChunkBytes: IO_MAX_CHUNK_BYTES, maxEventBytes: IO_EVENT_MAX_BYTES, leaseMs: IO_LEASE_MS },
    }
  }
  registerClient(input: unknown): { clientToken: string } {
    this.live()
    const client = ioClientSchema.parse(input)
    for (const [id, record] of this.clients) if (this.now() - record.lastSeen >= IO_LEASE_MS) this.clients.delete(id)
    if (this.clients.has(client.id)) throw new IoError('client_exists', 'Choose a fresh client identity', 409)
    if (this.clients.size >= IO_MAX_CLIENTS) throw new IoError('too_many_clients', 'I/O client limit reached', 429)
    const token = randomUUID()
    this.clients.set(client.id, { ...client, token, lastSeen: this.now() })
    return { clientToken: token }
  }
  private client(id: string, token: unknown): ClientRecord {
    const client = this.clients.get(id)
    if (!client || !sameSecret(token, client.token) || this.now() - client.lastSeen >= IO_LEASE_MS) {
      throw new IoError('client_expired', 'The I/O client expired; reconnect explicitly', 403)
    }
    return client
  }
  heartbeatClient(id: string, token: unknown): void { this.live(); this.client(id, token).lastSeen = this.now() }

  async create(sessionId: string, input: unknown): Promise<IoRun> {
    this.live()
    this.options.assertSession(sessionId)
    const definition = parseIoDefinition(input)
    if ([...this.runs.values()].filter(record => !IO_TERMINAL.has(record.run.status)).length >= IO_MAX_RUNS) {
      throw new IoError('too_many_runs', 'Stop an existing I/O run first', 429)
    }
    const record = active({
      version: 1, id: randomUUID(), projectId: this.options.projectId, sessionId,
      revision: revision(definition), definition, status: 'awaiting_consent', backendStatus: 'disconnected',
      createdAt: new Date(this.now()).toISOString(), bytes: 0, artifacts: [], ui: definition.ui,
    })
    this.runs.set(record.run.id, record)
    try { await this.persist(record) } catch (error) { this.runs.delete(record.run.id); throw error }
    this.changed(record)
    return this.snapshot(record)
  }

  async prepare(id: string, clientId: string, token: unknown, requestedRevision: string): Promise<{ leaseToken: string; run: IoRun }> {
    const record = this.record(id)
    const client = this.client(clientId, token)
    if (record.run.status !== 'awaiting_consent' || requestedRevision !== record.run.revision) {
      throw new IoError('run_conflict', 'Run is no longer awaiting this consent', 409)
    }
    if (record.lease && record.lease.expires > this.now() && record.lease.clientId !== clientId) {
      throw new IoError('run_claimed', 'This run is reserved by another client', 409)
    }
    for (const source of record.run.definition.sources) {
      if (!client.capabilities.some(cap => cap.kind === 'source' && cap.id === source.kind && cap.available)) {
        throw new IoError('source_unavailable', `This client cannot provide ${source.kind}`, 409)
      }
    }
    if (!record.lease || record.lease.expires <= this.now()) {
      record.relay?.close()
      record.relay = undefined
      record.preparing = undefined
      record.lease = { clientId, token: randomUUID(), expires: this.now() + IO_LEASE_MS }
    }
    const lease = record.lease
    if (!record.relay) {
      record.run.backendStatus = 'connecting'
      this.changed(record)
      const relay = record.relay = new IoRelay({
        endpoint: record.run.definition.endpoint, runId: id, sources: record.run.definition.sources,
        connectTimeoutMs: this.options.connectTimeoutMs, ackTimeoutMs: this.options.ackTimeoutMs,
        onEffect: effect => this.effect(record, effect),
        onDone: async () => {
          await this.finish(record, record.run.status === 'awaiting_consent' ? 'failed' : 'completed',
            record.run.status === 'awaiting_consent' ? 'Backend finished before capture was started' : undefined)
        },
        onError: error => { this.track(this.finish(record, 'failed', message(error))) },
      })
      record.preparing = relay.connect().then(async () => {
        if (record.relay !== relay || IO_TERMINAL.has(record.run.status)) throw new IoError('run_stopped', 'Run stopped while connecting', 409)
        record.run.backendStatus = 'ready'
        await this.persist(record)
        this.changed(record)
      })
    }
    await record.preparing
    this.lease(record, clientId, token, lease.token)
    return { leaseToken: lease.token, run: this.snapshot(record) }
  }

  private lease(record: ActiveRun, clientId: string, clientToken: unknown, leaseToken: unknown): Lease {
    this.client(clientId, clientToken)
    const lease = record.lease
    if (!lease || lease.clientId !== clientId || !sameSecret(leaseToken, lease.token) || lease.expires <= this.now()) {
      throw new IoError('lease_expired', 'The capture lease is no longer valid', 403)
    }
    return lease
  }
  async begin(id: string, clientId: string, clientToken: unknown, leaseToken: unknown, requestedRevision: string): Promise<IoRun> {
    const record = this.record(id)
    this.lease(record, clientId, clientToken, leaseToken)
    if (record.run.status !== 'awaiting_consent' || requestedRevision !== record.run.revision || record.run.backendStatus !== 'ready') {
      throw new IoError('run_conflict', 'Consent no longer matches a ready backend', 409)
    }
    record.run.status = 'running'
    record.run.clientId = clientId
    record.run.startedAt = new Date(this.now()).toISOString()
    await this.persist(record)
    this.changed(record)
    return this.snapshot(record)
  }
  heartbeat(id: string, clientId: string, clientToken: unknown, leaseToken: unknown): void {
    const record = this.record(id)
    if (IO_TERMINAL.has(record.run.status)) throw new IoError('run_stopped', 'Run is stopped', 409)
    this.lease(record, clientId, clientToken, leaseToken).expires = this.now() + IO_LEASE_MS
    this.client(clientId, clientToken).lastSeen = this.now()
  }

  async dispatch(id: string, credentials: IoCredentials, input: unknown): Promise<{ accepted: true }> {
    const record = this.record(id)
    this.lease(record, credentials.clientId, credentials.clientToken, credentials.leaseToken)
    if (record.run.status !== 'running' || record.inputsEnded) throw new IoError('run_stopped', 'Run is not collecting input', 409)
    const parsed = parseIoPacket(input, record.run.definition.sources)
    if (record.run.bytes + parsed.bytes > record.run.definition.limits.maxBytes) {
      await this.finish(record, 'failed', 'The approved input byte budget was exceeded')
      throw new IoError('budget_exceeded', 'The approved input byte budget was exceeded', 413)
    }
    if (this.now() - Date.parse(record.run.startedAt!) >= record.run.definition.limits.durationMs + IO_FINALIZE_MS) {
      await this.stop(id, 'completed')
      throw new IoError('duration_exceeded', 'Input capture duration has ended', 409)
    }
    this.checkBuffer(record, parsed.encodedBytes)
    record.run.bytes += parsed.bytes
    if (parsed.event.type === 'end') this.markStopping(record)
    await this.enqueue(record, parsed.event, parsed.encodedBytes)
    return { accepted: true }
  }

  private checkBuffer(record: ActiveRun, bytes: number): void {
    if (record.queued >= 256 || this.bufferedBytes + bytes > IO_MAX_BUFFER_BYTES) {
      throw new IoError('input_buffer_full', 'Wait for the previous input acknowledgement', 429)
    }
  }
  private enqueue(record: ActiveRun, event: IoPacket, bytes: number): Promise<void> {
    record.queued++
    this.bufferedBytes += bytes
    const operation = record.tail.then(async () => {
      if (IO_TERMINAL.has(record.run.status)) throw new IoError('run_stopped', 'Run stopped before input was sent', 409)
      await record.relay!.send(event)
      await this.persist(record)
    })
    const result = operation.catch(async error => {
      if (!IO_TERMINAL.has(record.run.status)) await this.finish(record, 'failed', message(error))
      throw error
    }).finally(() => {
      record.queued--
      this.bufferedBytes -= bytes
    })
    record.tail = result.catch(() => {})
    this.track(result)
    return result
  }
  private markStopping(record: ActiveRun): void {
    record.inputsEnded = true
    record.processingAt = this.now()
    record.run.status = 'stopping'
    record.run.message = 'Input finished; backend processing is still active.'
    this.changed(record)
  }
  async stop(id: string, status: 'completed' | 'cancelled' | 'failed' | 'denied' | 'interrupted', error?: string): Promise<IoRun> {
    const record = this.record(id)
    if (IO_TERMINAL.has(record.run.status)) return this.snapshot(record)
    if (status !== 'completed') return this.finish(record, status, error)
    if (record.run.status === 'awaiting_consent') throw new IoError('run_not_started', 'An unapproved run cannot finish input', 409)
    if (!record.inputsEnded) {
      this.checkBuffer(record, 14)
      this.markStopping(record)
      this.track(this.enqueue(record, { type: 'end' }, 14).catch(() => {}))
    }
    await this.persist(record)
    return this.snapshot(record)
  }

  private async effect(record: ActiveRun, incoming: IoRelayEffect): Promise<void> {
    if (IO_TERMINAL.has(record.run.status)) return
    let effect = incoming
    if (effect.method === 'ui.render') record.run.ui = parseIoUi(effect.args[0])
    if (effect.method === 'status') record.run.message = String(effect.args[0])
    if (effect.method === 'artifact') {
      if (record.run.artifacts.length >= IO_MAX_ARTIFACTS) throw new Error('Artifact count limit reached')
      const input = effect.args[0] as { path: string; name?: string; mime?: string }
      if (!isAbsolute(input.path)) throw new Error('Backend artifact path must be absolute')
      const metadata = await stat(input.path)
      if (!metadata.isFile()) throw new Error('Backend artifact must be a regular file')
      if (IO_TERMINAL.has(record.run.status)) return
      const artifact: IoArtifact = {
        id: randomUUID(), path: input.path,
        name: basename(input.name ?? input.path).replace(/[\u0000-\u001f\u007f"]/g, '_').slice(0, 200) || 'artifact',
        mime: input.mime ?? 'application/octet-stream', size: metadata.size, complete: true,
      }
      record.run.artifacts.push(artifact)
      effect = { method: 'artifact', args: [artifact] }
    }
    const update = { sequence: ++record.cursor, effect: structuredClone(effect) }
    const bytes = Buffer.byteLength(JSON.stringify(update))
    record.journal.push({ update, bytes })
    record.journalBytes += bytes
    while (record.journal.length > 256 || record.journalBytes > IO_MAX_BUFFER_BYTES) {
      record.journalBytes -= record.journal.shift()!.bytes
    }
    if (effect.method === 'artifact' || effect.method === 'ui.render') await this.persist(record)
    this.changed(record)
  }
  updates(id: string, after = 0): { updates: IoRelayUpdate[]; cursor: number; reset?: boolean } {
    const record = this.record(id)
    if (!Number.isSafeInteger(after) || after < 0) throw new IoError('invalid_cursor', 'Use a non-negative update cursor')
    const first = record.journal[0]?.update.sequence ?? record.cursor + 1
    const reset = after < first - 1 || after > record.cursor
    return {
      updates: structuredClone(record.journal.filter(item => reset || item.update.sequence > after).map(item => item.update)),
      cursor: record.cursor, ...(reset ? { reset: true } : {}),
    }
  }
  async artifactPath(id: string, artifactId: string): Promise<{ path: string; artifact: IoArtifact }> {
    const record = this.record(id)
    const artifact = record.run.artifacts.find(item => item.id === artifactId)
    if (!artifact?.path) throw new IoError('artifact_not_found', 'Artifact not found', 404)
    const path = resolveLegacyProjectPath(this.options.workspace, artifact.path)
    let metadata
    try { metadata = await stat(path) } catch { throw new IoError('artifact_not_found', 'Artifact file is unavailable', 404) }
    if (!metadata.isFile()) throw new IoError('artifact_not_found', 'Artifact is not a regular file', 404)
    return { path, artifact: { ...artifact, size: metadata.size } }
  }

  private finish(record: ActiveRun, status: 'completed' | 'cancelled' | 'failed' | 'denied' | 'interrupted', error?: string): Promise<IoRun> {
    if (record.finishing) return record.finishing
    if (IO_TERMINAL.has(record.run.status)) return Promise.resolve(this.snapshot(record))
    record.run.status = status
    record.run.backendStatus = 'disconnected'
    record.run.finishedAt = new Date(this.now()).toISOString()
    if (error) record.run.error = error.slice(0, 2000)
    record.lease = undefined
    record.relay?.close(new Error(error ?? `I/O ${status}`))
    record.finishing = (async () => {
      await this.persist(record)
      this.changed(record)
      try { await this.options.finished?.(this.snapshot(record)) }
      catch (failure) { console.error('[io] Completion notification failed', message(failure)) }
      return this.snapshot(record)
    })()
    return record.finishing
  }
  async expire(): Promise<void> {
    for (const record of this.runs.values()) {
      if (IO_TERMINAL.has(record.run.status)) continue
      try { this.options.assertSession(record.run.sessionId) }
      catch { await this.finish(record, 'interrupted', 'Owning conversation is no longer available'); continue }
      if (record.run.status === 'awaiting_consent') {
        if (record.lease && record.lease.expires <= this.now()) {
          record.relay?.close()
          record.relay = undefined
          record.preparing = undefined
          record.lease = undefined
          record.run.backendStatus = 'disconnected'
          this.changed(record)
        }
        continue
      }
      if (!record.lease || record.lease.expires <= this.now()) {
        await this.finish(record, 'interrupted', 'Capture client disconnected')
      } else if (record.run.status === 'stopping') {
        if (this.now() - record.processingAt! >= (this.options.processingTimeoutMs ?? IO_PROCESSING_MS)) {
          await this.finish(record, 'failed', 'Backend processing timed out after input finished')
        }
      } else if (this.now() - Date.parse(record.run.startedAt!) >= record.run.definition.limits.durationMs + IO_FINALIZE_MS) {
        await this.stop(record.run.id, 'completed')
      }
    }
  }
  private persist(record: ActiveRun): Promise<void> {
    const content = JSON.stringify(record.run)
    const path = join(this.root, `${record.run.id}.json`)
    const previous = this.writes.get(record.run.id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      await writeFile(`${path}.tmp`, content, 'utf8')
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${path}.tmp`, path); break }
        catch (error) {
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          await delay(10 * (attempt + 1))
        }
      }
    })
    this.writes.set(record.run.id, write)
    return write
  }
  private track(promise: Promise<unknown>): void {
    this.pending.add(promise)
    void promise.then(() => this.pending.delete(promise), error => {
      this.pending.delete(promise)
      if (!this.stopped) console.error('[io] Operation ended', message(error))
    })
  }
  shutdown(): Promise<void> { return this.shutdownPromise ??= this.close() }
  private async close(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    for (const record of this.runs.values()) {
      if (record.run.status === 'awaiting_consent') {
        record.relay?.close()
        record.lease = undefined
        record.run.backendStatus = 'disconnected'
        await this.persist(record)
      } else if (!IO_TERMINAL.has(record.run.status)) await this.finish(record, 'interrupted', 'Project runtime stopped')
    }
    await Promise.allSettled(this.pending)
    await Promise.all(this.writes.values())
    this.clients.clear()
  }
}
