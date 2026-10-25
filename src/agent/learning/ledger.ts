import { projectStoragePath } from '../../utils/data-paths.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { Journal } from '../../watermarks/journal.ts'
import { ConsumptionCore } from '../../watermarks/core.ts'
import type { LearningOutcome } from '../../cron/contracts.ts'

export const pipelines = ['reflector', 'encapsulator', 'soulReflector'] as const
export type Pipeline = typeof pipelines[number]
const text = z.string().trim().min(1).max(8000)
export const outcomeSchema = z.object({
  status: z.enum(['applied', 'no_change', 'partial', 'blocked', 'draft_only']),
  summary: text, artifacts: z.number().int().nonnegative(), events: z.number().int().nonnegative(),
  evaluated: z.number().int().nonnegative(),
}).strict()
const sourceSchema = z.object({
  sessionId: text, physicalId: text, segmentIndex: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
}).strict().refine(value => value.end > value.offset)
export type LearningSource = z.infer<typeof sourceSchema>
const eventSchema = z.object({
  id: text, path: text, origin: text, when: text, who: text, what: text,
  why: z.string().optional(), challenge: z.string().optional(), refs: z.array(z.string()).optional(),
}).strict()
export type LearningEvent = z.infer<typeof eventSchema>
const artifactSchema = z.object({
  path: text, revision: text, kind: z.enum(['memory', 'skill', 'soul']),
}).strict()
export type LearningArtifact = z.infer<typeof artifactSchema>
const batchSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().datetime(), pipeline: z.enum(pipelines), sources: z.array(sourceSchema),
  inputEvents: z.array(eventSchema), events: z.array(eventSchema), artifacts: z.array(artifactSchema),
  attempts: z.array(z.string()), state: z.enum(['pending', 'running', 'done']),
  proposal: outcomeSchema.optional(), evaluated: z.array(z.string()), error: z.string().optional(),
}).strict()
export type LearningBatch = z.infer<typeof batchSchema>
export const retrySchema = z.object({
  attempts: z.number().int().nonnegative(), notBefore: z.number().nonnegative().optional(),
  paused: z.string().optional(), lastError: z.string().optional(),
}).strict()
export type LearningRetry = z.infer<typeof retrySchema>
const stateSchema = z.object({
  version: z.literal(1), projectId: text,
  cursors: z.record(z.string(), z.number().int().nonnegative()),
  legacy: z.record(z.string(), z.object({ segmentIndex: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative() })),
  batches: z.array(batchSchema), outcomes: z.record(z.string(), outcomeSchema),
  consumed: z.object({ encapsulator: z.array(z.string()), soulReflector: z.array(z.string()) }),
  retries: z.record(z.string(), retrySchema),
}).strict()
export const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')

/** Project-owned journal, independent of the JSONL/SQLite session-store choice. */
export class LearningLedger {
  private state: z.infer<typeof stateSchema>
  private committed: z.infer<typeof stateSchema>
  private readonly file: string
  private readonly journal: Journal<z.infer<typeof stateSchema>>
  constructor(readonly workspace: string, readonly projectId: string) {
    this.file = projectStoragePath(workspace, '.learning', 'state.v1.json')
    this.journal = new Journal(this.file, value => stateSchema.parse(value))
    if (existsSync(this.file)) {
      this.state = this.journal.read(undefined as never)
      if (this.state.projectId !== projectId) throw new Error('Learning journal belongs to a different Project')
    } else {
      const legacyFile = projectStoragePath(workspace, 'memory', '.reflect-watermark.json')
      const legacy = existsSync(legacyFile) ? z.object({
        lastRunAt: z.string(), sessions: stateSchema.shape.legacy,
      }).parse(JSON.parse(readFileSync(legacyFile, 'utf8'))).sessions : {}
      this.state = { version: 1, projectId, cursors: {}, legacy, batches: [], outcomes: {},
        consumed: { encapsulator: [], soulReflector: [] }, retries: {} }
    }
    this.committed = structuredClone(this.state)
  }
  private save(): void {
    try {
      stateSchema.parse(this.state)
      this.journal.save(this.state)
      this.committed = structuredClone(this.state)
    } catch (error) {
      this.state = structuredClone(this.committed)
      throw error
    }
  }
  private sourceCursor(source: Omit<LearningSource, 'offset' | 'end'>): number {
    const known = this.state.cursors[source.physicalId]
    if (known !== undefined) return known
    const legacy = this.state.legacy[source.sessionId]
    if (!legacy || source.segmentIndex > legacy.segmentIndex) return 0
    return source.segmentIndex < legacy.segmentIndex ? Number.MAX_SAFE_INTEGER : legacy.messageCount
  }
  private core(knownSource?: Omit<LearningSource, 'offset' | 'end'>) {
    return new ConsumptionCore<number, LearningBatch>({
      batches: () => this.state.batches,
      cursor: (key, batch) => {
        const source = knownSource?.physicalId === key ? knownSource : batch?.sources.find(s => s.physicalId === key)
        return source ? this.sourceCursor(source) : (this.state.cursors[key] ?? 0)
      },
      advance: (key, value) => { this.state.cursors[key] = value },
      consumer: batch => batch.pipeline,
      ranges: batch => batch.sources.map(s => ({ source: s.physicalId, from: s.offset, to: s.end })),
    })
  }
  cursor(source: Omit<LearningSource, 'offset' | 'end'>): number {
    return this.core(source).cursor(source.physicalId)
  }
  pending(pipeline: Pipeline): LearningBatch | undefined {
    return structuredClone(this.core().pending(pipeline))
  }
  batchFor(sessionId: string): LearningBatch | undefined {
    return structuredClone(this.state.batches.find(batch => batch.attempts.at(-1) === sessionId && batch.state === 'running'))
  }
  unfinished(): LearningBatch[] { return structuredClone(this.state.batches.filter(batch => batch.state !== 'done')) }
  outcome(sessionId: string): LearningOutcome | undefined { return structuredClone(this.state.outcomes[sessionId]) }
  retry(pipeline: Pipeline): LearningRetry { return structuredClone(this.state.retries[pipeline] ?? { attempts: 0 }) }
  setRetry(pipeline: Pipeline, retry: LearningRetry): void { this.state.retries[pipeline] = retrySchema.parse(retry); this.save() }
  eventsFor(pipeline: 'encapsulator' | 'soulReflector'): LearningEvent[] {
    const consumed = new Set(this.state.consumed[pipeline])
    return structuredClone(this.state.batches.filter(batch => batch.pipeline === 'reflector' && batch.state === 'done')
      .flatMap(batch => batch.events).filter(event => !consumed.has(event.id)).slice(0, 40))
  }
  create(pipeline: Pipeline, sources: LearningSource[], inputEvents: LearningEvent[]): LearningBatch {
    const batch = batchSchema.parse({ id: randomUUID(), createdAt: new Date().toISOString(), pipeline, sources, inputEvents,
      events: [], artifacts: [], evaluated: [], attempts: [], state: 'pending' })
    this.core().create(batch); this.save()
    return structuredClone(batch)
  }
  bind(id: string, sessionId: string): void {
    const batch = this.required(id)
    this.core().claim(id, sessionId); delete batch.proposal
    this.save()
  }
  private required(id: string): LearningBatch {
    return this.core().required(id)
  }
  artifact(id: string, artifact: LearningArtifact, evaluation?: string): void {
    const batch = this.required(id)
    batch.artifacts = [...batch.artifacts.filter(item => item.path !== artifact.path), artifactSchema.parse(artifact)]
    if (evaluation && !batch.evaluated.includes(evaluation)) batch.evaluated.push(evaluation)
    this.save()
  }
  event(id: string, event: LearningEvent): void {
    const batch = this.required(id)
    if (!batch.events.some(item => item.id === event.id)) batch.events.push(eventSchema.parse(event))
    this.save()
  }
  propose(id: string, status: LearningOutcome['status'], summary: string): void {
    const batch = this.required(id)
    batch.proposal = outcomeSchema.parse({ status, summary, artifacts: batch.artifacts.length,
      events: batch.events.length, evaluated: batch.evaluated.length })
    this.save()
  }
  complete(id: string): LearningOutcome {
    const batch = this.required(id)
    const outcome = batch.proposal
    if (!outcome) throw new Error('Learning result was not submitted')
    const sessionId = batch.attempts.at(-1)
    if (!sessionId) throw new Error('Learning batch has no execution')
    this.state.outcomes[sessionId] = outcome
    if (outcome.status === 'applied' || outcome.status === 'no_change') {
      if (batch.pipeline !== 'reflector') {
        this.state.consumed[batch.pipeline] = [...new Set([
          ...this.state.consumed[batch.pipeline], ...batch.inputEvents.map(event => event.id),
        ])]
      }
      this.core().settle(id, sessionId, true)
    } else this.core().settle(id, sessionId, false)
    this.save()
    return structuredClone(outcome)
  }
  interrupt(id: string, error: string): void {
    error = error.trim().slice(0, 8000) || 'Learning execution interrupted without a diagnostic.'
    const batch = this.required(id)
    const sessionId = batch.attempts.at(-1)
    if (sessionId) this.state.outcomes[sessionId] = {
      status: batch.artifacts.length || batch.events.length ? 'partial' : 'blocked',
      summary: error, artifacts: batch.artifacts.length, events: batch.events.length, evaluated: batch.evaluated.length,
    }
    this.core().recover(id); batch.error = error; delete batch.proposal
    this.save()
  }
}
