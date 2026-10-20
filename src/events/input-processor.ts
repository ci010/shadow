import { z } from 'zod'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { executeAuthoredTool } from '../agent-authoring/tool-runtime.ts'
import { assertPrivateFileBoundary } from '../utils/private-document.ts'
import { InputProcessorSchema, type InputProcessorPolicy } from './input-processor-contract.ts'
export { InputProcessorSchema } from './input-processor-contract.ts'
const processorState = z.record(z.unknown()).nullable()
const semanticSchema = z.object({type:z.string().min(1).max(100),data:z.record(z.unknown())}).strict()
export type ProcessorSemantic = z.infer<typeof semanticSchema>
const decision = z.object({ action: z.enum(['ignore', 'buffer', 'emit']), classify:z.boolean().optional(), state: processorState.optional(), semantic: semanticSchema.optional() }).strict().refine(value => !value.semantic || value.action === 'emit', 'Semantic events require emit')
const stateRow = z.object({ key: z.string(), value: processorState, expires: z.number() }).strict()
const STATE_TTL_MS = 10 * 60_000
const STATE_BYTES = 16_000
export function awaitInputSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
export interface ProcessorClock {
  now?(): number
  setTimeout(callback: () => void, delay: number): { unref(): void }
  clearTimeout(timer: { unref(): void }): void
}
const realClock: ProcessorClock = {
  now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
type Publish<T> = (items: T[], signal: AbortSignal, semantic?: ProcessorSemantic) => Promise<void>
export type ProcessorSubmission<T> = {
  key: string; id: string; event: Record<string, unknown>; item: T; policy: InputProcessorPolicy;
  publish: Publish<T>; signal: AbortSignal;
  classify?: (signal:AbortSignal)=>Promise<import('./input-classifier.ts').Classification>;
}
const rowSchema = z.object({
  key: z.string().max(4096), id: z.string().max(1024), identity: z.string(), event: z.record(z.unknown()), item: z.unknown(),
  policy: InputProcessorSchema, semantic: semanticSchema.optional(), status: z.enum(['classify', 'buffer', 'emit']), due: z.number(), created: z.number(), attempts: z.number().int().min(0).max(3),
}).strict()
type Row<T> = Omit<z.infer<typeof rowSchema>, 'item'> & { item: T }
export interface ProcessorStorage<T> {
  /** Private per-adapter file. Recovery never restores old authorization closures. */
  journalPath: string
  recover(row: { key: string; id: string; event: Record<string, unknown>; item: T; policy: InputProcessorPolicy }):
    { publish: Publish<T>; signal: AbortSignal; classify?:ProcessorSubmission<T>['classify'] } | undefined
}
/** Bounded durable inbox. Ack after atomic journal replacement. Delivery is at-least-once:
 * a crash between downstream acceptance and journal replacement can replay an identical ID.
 * Recovery obtains fresh authority from the host; stored policy bytes are not authorization.
 */
export class InputProcessor<T> {
  private rows = new Map<string, Row<T>>()
  private contexts = new Map<string, { publish: Publish<T>; signal: AbortSignal; classify?:ProcessorSubmission<T>['classify'] }>()
  private waiters = new Map<string, { resolve(): void; reject(error: unknown): void }>()
  private seen = new Set<string>()
  private states = new Map<string, z.infer<typeof stateRow>>()
  private active = new Set<Promise<void>>()
  private busy = new Set<string>()
  private inFlight = new Set<string>()
  private timer?: { unref(): void }
  private closed = false
  private stopping?: Promise<void>
  private controller = new AbortController()
  private storage?: ProcessorStorage<T>
  constructor(private onError: () => void = () => {}, private maxOutstanding = 100, private clock: ProcessorClock = realClock, storage?: ProcessorStorage<T>) {
    if (!Number.isInteger(maxOutstanding) || maxOutstanding < 1 || maxOutstanding > 100) throw new Error('Invalid processor capacity')
    this.storage = storage
    if (storage && existsSync(storage.journalPath)) {
      assertPrivateFileBoundary(storage.journalPath)
      if (readFileSync(storage.journalPath).length > 4_000_000) throw new Error('Processor journal capacity')
      const saved = z.object({ version: z.literal(1), rows: z.array(rowSchema).max(maxOutstanding), seen: z.array(z.string()).max(2000), states: z.array(stateRow).max(100).optional() }).strict().parse(JSON.parse(readFileSync(storage.journalPath, 'utf8')))
      this.seen = new Set(saved.seen)
      for (const row of saved.states ?? []) {
        if (Buffer.byteLength(JSON.stringify(row.value)) > STATE_BYTES) throw new Error('Processor state capacity')
        if (row.expires > this.now()) this.states.set(row.key, row)
      }
      for (const raw of saved.rows) {
        const row = raw as Row<T>, context = storage.recover(row)
        if (context) { this.rows.set(row.identity, row); this.contexts.set(row.identity, context) }
        else this.onError()
      }
      this.save()
      // Host integration is attached synchronously before this microtask runs.
      queueMicrotask(() => this.pump())
    }
  }
  private now() { return this.clock.now?.() ?? Date.now() }
  private save() {
    if (!this.storage) return
    const data = JSON.stringify({ version: 1, rows: [...this.rows.values()], seen: [...this.seen], states: [...this.states.values()] })
    if (Buffer.byteLength(data) > 4_000_000) throw new Error('Processor journal capacity (4000000 bytes)')
    const file = this.storage.journalPath, temp = file + '.tmp'
    assertPrivateFileBoundary(file); assertPrivateFileBoundary(temp)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(temp, data, { mode: 0o600 }); renameSync(temp, file)
  }
  private stateKey(row: Row<T>) { return JSON.stringify([row.key, createHash('sha256').update(row.policy.code).digest('hex')]) }
  private pruneState() { for (const [key, row] of this.states) if (row.expires <= this.now()) this.states.delete(key) }
  private signal(parent: AbortSignal) { return AbortSignal.any([parent, this.controller.signal, AbortSignal.timeout(2000)]) }
  async accept(input: ProcessorSubmission<T>): Promise<void> {
    if (this.closed) throw new Error('Processor stopped')
    input.signal.throwIfAborted()
    const identity = JSON.stringify([input.key, input.id])
    if (this.seen.has(identity) || this.rows.has(identity)) return
    if (this.rows.size >= this.maxOutstanding) throw new Error('Processor inbox capacity; retry input')
    const row: Row<T> = { key: input.key, id: input.id, identity, event: input.event, item: input.item, policy: input.policy,
      status: 'classify', due: this.now(), created: this.now(), attempts: 0 }
    // Size-check even for the volatile runtime; never retain unbounded payloads.
    if (Buffer.byteLength(JSON.stringify(row)) > 256_000) throw new Error('Processor item capacity (256000 bytes)')
    this.rows.set(identity, row); this.contexts.set(identity, input)
    try { this.save() } catch (error) { this.rows.delete(identity); this.contexts.delete(identity); throw error }
    const classified = new Promise<void>((resolve, reject) => this.waiters.set(identity, { resolve, reject }))
    this.pump()
    await classified
    // Let the completed classifier release its lane and arm the fixed-window timer.
    await Promise.resolve(); await Promise.resolve()
  }
  private finish(row: Row<T>) {
    this.rows.delete(row.identity); this.contexts.delete(row.identity)
    this.seen.add(row.identity)
    while (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!)
  }
  private pump() {
    if (this.closed) return
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    const now = this.now()
    // Delivery is independent of queued classifiers. Urgent emits never wait for a batch timer.
    for (const row of this.rows.values()) {
      const lane = JSON.stringify([row.status === 'classify' ? 'classify' : 'publish', row.key])
      if (this.inFlight.has(row.identity) || this.busy.has(lane) || row.due > now || this.active.size >= 10) continue
      const group = row.status === 'buffer' ? [...this.rows.values()].filter(r => r.key === row.key && r.status === 'buffer' && r.due <= now) : [row]
      this.busy.add(lane)
      for (const entry of group) this.inFlight.add(entry.identity)
      const operation = this.run(group)
      this.active.add(operation)
      void operation.catch(() => this.onError()).finally(() => { this.active.delete(operation); this.busy.delete(lane); for (const entry of group) this.inFlight.delete(entry.identity); this.pump() })
    }
    const future = [...this.rows.values()].filter(row => !this.busy.has(JSON.stringify([row.status === 'classify' ? 'classify' : 'publish', row.key]))).map(row => row.due)
    if (future.length) {
      this.timer = this.clock.setTimeout(() => this.pump(), Math.max(1, Math.min(...future) - this.now()))
      this.timer.unref()
    }
  }
  private async run(group: Row<T>[]) {
    const row = group[0]!, context = this.contexts.get(row.identity)!
    const waiter = this.waiters.get(row.identity)
    try {
      const signal = this.signal(context.signal)
      signal.throwIfAborted()
      if (this.now() - row.created > 10 * 60_000) throw new Error('Processor inbox expiry')
      if (row.status === 'classify') {
        this.pruneState()
        const stateKey = this.stateKey(row)
        const previous = this.states.get(stateKey)
        let result = decision.parse(await executeAuthoredTool({ code: row.policy.code,
          args: { event: row.event, state: previous?.value ?? null, now: this.now() }, signal,
          callModule: async () => { throw new Error('Input processors have no capability grants') } }))
        if (result.classify) {
          if (!row.policy.classifier || !context.classify) throw new Error('No reviewed classifier capability')
          const classification = await awaitInputSignal(context.classify(signal), signal)
          if (classification.label === 'unknown') result = {action:'ignore'}
          else {
            result = decision.parse(await executeAuthoredTool({code:row.policy.code,
              args:{event:row.event,state:previous?.value ?? null,now:this.now(),classification},signal,
              callModule:async()=>{throw new Error('Input processors have no capability grants')} }))
            if (result.classify) throw new Error('Recursive classification denied')
            if (result.action === 'emit' && classification.label !== 'semanticwake') throw new Error('Classifier did not authorize semantic wake')
          }
        }
        signal.throwIfAborted()
        const checkpoint = { row: { ...row }, rows: new Map(this.rows), states: new Map(this.states),
          contexts: new Map(this.contexts), seen: new Set(this.seen) }
        try {
          if (result.semantic) {
            if (Buffer.byteLength(JSON.stringify(result.semantic)) > 16000) throw new Error('Processor semantic capacity')
            row.semantic = result.semantic
          }
          if (result.state !== undefined) {
            if (result.state !== null && !previous && this.states.size >= 100) throw new Error('Processor state partition capacity')
            const encoded = JSON.stringify(result.state)
            if (Buffer.byteLength(encoded) > STATE_BYTES) throw new Error('Processor state capacity (16000 bytes)')
            // JSON copy makes the state a value, never a capability or worker-owned reference.
            if (result.state === null) this.states.delete(stateKey)
            else this.states.set(stateKey, { key: stateKey, value: JSON.parse(encoded), expires: this.now() + STATE_TTL_MS })
          }
          if (result.action === 'ignore') this.finish(row)
          else {
            row.status = result.action === 'buffer' ? 'buffer' : 'emit'
            row.due = row.status === 'buffer' ? [...this.rows.values()].find(r => r !== row && r.key === row.key && r.status === 'buffer')?.due ?? this.now() + row.policy.delayMs : this.now()
          }
          this.save()
        } catch (error) {
          delete row.semantic
          Object.assign(row, checkpoint.row)
          this.rows = checkpoint.rows; this.states = checkpoint.states
          this.contexts = checkpoint.contexts; this.seen = checkpoint.seen
          throw error
        }
        // Preserve accept's immediate-emit semantics, without blocking later urgent arrivals on windows.
        if (row.status === 'emit' && this.rows.has(row.identity)) {
          await awaitInputSignal(context.publish([row.item], signal, row.semantic), signal); signal.throwIfAborted(); this.finish(row); this.save()
        }
      } else {
        await awaitInputSignal(context.publish(group.map(r => r.item), signal, row.semantic), signal)
        signal.throwIfAborted()
        for (const entry of group) this.finish(entry)
        this.save()
      }
      waiter?.resolve(); this.waiters.delete(row.identity)
    } catch (error) {
      waiter?.reject(error); this.waiters.delete(row.identity)
      if (this.closed) return // journal retains unacknowledged items for next host instance
      if (context.signal.aborted) { for (const entry of group) this.finish(entry) }
      else {
        for (const entry of group) {
          entry.attempts++
          if (entry.attempts >= 3) this.finish(entry)
          else entry.due = this.now() + entry.attempts * 1000
        }
      }
      this.save(); this.onError()
    }
  }
  stop(): Promise<void> {
    return this.stopping ??= this.close()
  }
  private async close(): Promise<void> {
    this.closed = true; this.controller.abort()
    if (this.timer) this.clock.clearTimeout(this.timer)
    for (const waiter of this.waiters.values()) waiter.reject(new Error('Processor stopped'))
    this.waiters.clear()
    await Promise.allSettled(this.active)
    this.save()
  }
}
