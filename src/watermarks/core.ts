import { bindBatch, finishBatch, type Batch } from './journal.ts'

export interface ConsumptionBatch extends Batch { id: string }
export interface Range<C> { source: string; from: C; to: C }
/** In-place consumption engine. The owner supplies its existing document and commits
 * mutations atomically (and rolls them back on failure). No sidecar or domain imports. */
export class ConsumptionCore<C, B extends ConsumptionBatch> {
  constructor(private adapter: {
    batches: () => B[]
    cursor: (source: string, batch?: B) => C
    advance: (source: string, cursor: C) => void
    consumer: (batch: B) => string
    ranges: (batch: B) => Range<C>[]
  }) {}
  cursor(source: string): C { return this.adapter.cursor(source) }
  pending(consumer: string): B | undefined {
    return this.adapter.batches().find(b => this.adapter.consumer(b) === consumer && b.state !== 'done')
  }
  required(id: string): B {
    const b = this.adapter.batches().find(b => b.id === id)
    if (!b) throw new Error('Unknown watermark batch')
    return b
  }
  create(batch: B): void {
    if (this.pending(this.adapter.consumer(batch))) throw new Error('Consumer has unfinished batch')
    this.check(batch)
    this.adapter.batches().push(batch)
  }
  private check(batch: B): void {
    for (const range of this.adapter.ranges(batch)) {
      if (!Object.is(this.adapter.cursor(range.source, batch), range.from)) throw new Error('Cursor conflict')
    }
  }
  claim(id: string, attempt: string): B {
    const b = this.required(id); bindBatch(b, attempt); return b
  }
  settle(id: string, attempt: string, acknowledged: boolean): B {
    const b = this.required(id)
    if (b.attempts.at(-1) !== attempt) throw new Error('Stale attempt')
    if (acknowledged && b.state === 'done') return b
    if (acknowledged) this.check(b)
    finishBatch(b, acknowledged)
    if (acknowledged) for (const r of this.adapter.ranges(b)) this.adapter.advance(r.source, r.to)
    return b
  }
  /** Explicit recovery also permits an already pending batch. Never reopens done work. */
  recover(id: string): B {
    const b = this.required(id)
    if (b.state === 'done') throw new Error('Watermark batch is done')
    if (b.state === 'running') finishBatch(b, false)
    return b
  }
}
