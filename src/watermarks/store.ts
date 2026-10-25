import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { projectStoragePath } from '../utils/data-paths.ts'
import { Journal } from './journal.ts'
import { ConsumptionCore } from './core.ts'
const key = z.string().trim().min(1).max(512).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v), 'Reserved key')
const cursor = z.string().max(4096).nullable()
const batch = z.object({ id: z.string().uuid(), source: key, from: cursor, to: cursor,
  state: z.enum(['pending', 'running', 'done']), attempts: z.array(key), error: z.string().max(8000).optional() }).strict()
const schema = z.object({ version: z.literal(1), projectId: key, consumer: key,
  cursors: z.record(z.string(), cursor), batches: z.array(batch) }).strict()
/** Opaque source cursors: ordering and source access are the caller's responsibility. */
export class Watermarks {
  private journal: Journal<z.infer<typeof schema>>
  private state: z.infer<typeof schema>
  constructor(workspace: string, projectId: string, consumer: string) {
    key.parse(projectId); key.parse(consumer)
    const hash = createHash('sha256').update(consumer).digest('hex')
    this.journal = new Journal(projectStoragePath(workspace, '.watermarks', `${hash}.json`), value => schema.parse(value))
    this.state = this.journal.read({ version: 1, projectId, consumer, cursors: {}, batches: [] })
    if (this.state.projectId !== projectId || this.state.consumer !== consumer) throw new Error('Watermark Project/consumer mismatch')
  }
  private core() { return new ConsumptionCore<string | null, z.infer<typeof batch>>({
    batches: () => this.state.batches, cursor: source => this.state.cursors[source] ?? null,
    advance: (source, value) => { this.state.cursors[source] = value },
    consumer: b => b.source, ranges: b => [{ source: b.source, from: b.from, to: b.to }],
  }) }
  inspect() { return structuredClone(this.state) }
  private change<T>(action: () => T): T {
    const old = structuredClone(this.state)
    try { const result = action(); this.journal.save(this.state); return structuredClone(result) }
    catch (error) { this.state = old; throw error }
  }
  /** Explicit initial baseline only; never overrides an existing consumer's progress. */
  initialize(source: string, value: string) {
    key.parse(source); cursor.parse(value)
    return this.change(() => {
      if (Object.hasOwn(this.state.cursors, source) || this.state.batches.some(b=>b.source===source)) throw new Error('Consumer scope already initialized')
      this.state.cursors[source]=value
    })
  }
  prepare(source: string, from: string | null, to: string | null) {
    key.parse(source); cursor.parse(from); cursor.parse(to)
    return this.change(() => {
      const b = batch.parse({ id: randomUUID(), source, from, to, state: 'pending', attempts: [] })
      this.core().create(b); return b
    })
  }
  claim(id: string, attempt: string) {
    key.parse(attempt)
    return this.change(() => { const b = this.core().claim(id, attempt); delete b.error; return b })
  }
  ack(id: string, attempt: string) {
    return this.change(() => {
      return this.core().settle(id, attempt, true)
    })
  }
  retry(id: string, attempt: string, error: string) {
    z.string().min(1).max(8000).parse(error)
    return this.change(() => {
      const b = this.core().settle(id, attempt, false); b.error = error; return b
    })
  }
}
