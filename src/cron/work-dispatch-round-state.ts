import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workKeySchema } from '../initiatives/work-key.ts'
import { z } from 'zod'
import { projectDataPaths } from '../utils/data-paths.ts'
import { writePrivateFile } from '../utils/private-file.ts'
import { isNotFoundError } from '../utils/runtime.ts'

export const DISPATCH_RECHECK_MS = 30 * 60_000
export const DISPATCH_FAILURE_RECHECK_MS = 5 * 60_000
const reviewSchema = z.object({
  key: workKeySchema, version: z.number().int().positive(), recipient: z.string().min(1),
  inputId: z.string().min(1), status: z.enum(['unconfirmed', 'accepted']),
}).strict()
export type DispatchReviewReceipt = z.infer<typeof reviewSchema>
const schema = z.object({
  version: z.literal(1),
  round: z.object({ fingerprint: z.string().length(64), nextCheckAt: z.number().finite(),
    outcome: z.enum(['running', 'completed', 'failed']) }).strict().optional(),
  reviews: z.array(reviewSchema).max(5000),
}).strict()
type State = z.infer<typeof schema>

export function dispatchFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Host receipts, not model memory, authority, or an external-operation retry queue.
 * Production owns one instance per Project. Each mutation is serialized and atomic.
 */
export class WorkDispatchRoundState {
  private readonly directory?: string
  private readonly ancestors: string[]
  private state: State = { version: 1, reviews: [] }
  private loaded = false
  private pending: Promise<unknown> = Promise.resolve()

  constructor(home?: string, private readonly now: () => number = Date.now) {
    const paths = home ? projectDataPaths(home) : undefined
    this.directory = paths ? join(paths.state, 'work-dispatch') : undefined
    this.ancestors = paths ? [paths.root, paths.state, this.directory!] : []
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation)
    this.pending = result.catch(() => {})
    return result
  }

  private async checkPath(): Promise<void> {
    if (!this.directory) return
    const file = join(this.directory, 'round-state.json')
    for (const path of [...this.ancestors, file]) {
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error('Dispatcher receipts cannot follow filesystem aliases')
        if (path === file ? !info.isFile() : !info.isDirectory()) throw new Error('Invalid dispatcher receipt path type')
      } catch (error) { if (!isNotFoundError(error)) throw error }
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.directory) {
      await this.checkPath()
      try { this.state = schema.parse(JSON.parse(await readFile(join(this.directory, 'round-state.json'), 'utf8'))) }
      catch (error) { if (!isNotFoundError(error)) throw error }
    }
    this.loaded = true
  }

  private async save(next: State): Promise<void> {
    schema.parse(next)
    if (this.directory) {
      await this.checkPath()
      await mkdir(this.directory, { recursive: true })
      await this.checkPath()
      writePrivateFile(join(this.directory, 'round-state.json'), JSON.stringify(next))
    }
    this.state = next
  }

  /** Write ahead: interruption cannot create a fresh model session every tick. */
  begin(fingerprint: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.load()
      if (this.state.round?.fingerprint === fingerprint && this.state.round.nextCheckAt > this.now()) return false
      await this.save({ ...this.state, round: { fingerprint, nextCheckAt: this.now() + DISPATCH_FAILURE_RECHECK_MS, outcome: 'running' } })
      return true
    })
  }

  finish(fingerprint: string, success: boolean): Promise<void> {
    return this.exclusive(async () => {
      await this.load()
      if (this.state.round?.fingerprint !== fingerprint) return
      await this.save({ ...this.state, round: { fingerprint, outcome: success ? 'completed' : 'failed',
        nextCheckAt: this.now() + (success ? DISPATCH_RECHECK_MS : DISPATCH_FAILURE_RECHECK_MS) } })
    })
  }

  /** One coordinator notification attempt per exact Work version/recipient.
   * Persist unconfirmed BEFORE delivery; a transport error is never safe to replay.
   */
  reserveReview(receipt: Omit<DispatchReviewReceipt, 'status'>): Promise<{ send: boolean; receipt: DispatchReviewReceipt }> {
    return this.exclusive(async () => {
      await this.load()
      const previous = this.state.reviews.find(item => item.key === receipt.key)
      if (previous && previous.version === receipt.version && previous.recipient === receipt.recipient) return { send: false, receipt: previous }
      const next: DispatchReviewReceipt = { ...receipt, status: 'unconfirmed' }
      await this.save({ ...this.state, reviews: [...this.state.reviews.filter(item => item.key !== receipt.key), next] })
      return { send: true, receipt: next }
    })
  }

  /** Caller proved sessions.deliver was never invoked. A crash/transport failure
   * cannot use this path: those reservations remain unconfirmed and non-replayable.
   */
  releaseUnattemptedReview(inputId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.load()
      await this.save({ ...this.state, reviews: this.state.reviews.filter(item => item.inputId !== inputId || item.status !== 'unconfirmed') })
    })
  }

  reviewFor(key: string, version: number): Promise<DispatchReviewReceipt | undefined> {
    return this.exclusive(async () => {
      await this.load()
      const receipt = this.state.reviews.find(item => item.key === key && item.version === version)
      return receipt ? { ...receipt } : undefined
    })
  }

  acceptReview(inputId: string): Promise<DispatchReviewReceipt> {
    return this.exclusive(async () => {
      await this.load()
      const receipt = this.state.reviews.find(item => item.inputId === inputId)
      if (!receipt) throw new Error('Dispatcher review receipt missing')
      const accepted: DispatchReviewReceipt = { ...receipt, status: 'accepted' }
      await this.save({ ...this.state, reviews: this.state.reviews.map(item => item.inputId === inputId ? accepted : item) })
      return accepted
    })
  }
}
