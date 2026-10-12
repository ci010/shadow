import { projectStoragePath } from '../utils/data-paths.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CapabilityGrantSchema, type CapabilityGrant } from '../agent-authoring/contracts.ts'
import { CapabilityBroker } from '../agent-authoring/capabilities.ts'
import { writePrivateFile } from '../config/store.ts'
import { executeAuthoredTool } from '../agent-authoring/tool-runtime.ts'
import type { EventService } from './service.ts'

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const httpGrant = CapabilityGrantSchema.refine(
  (grant): grant is Extract<CapabilityGrant, { kind: 'http' }> => grant.kind === 'http' && grant.id === 'fetch',
  'Event sources require an HTTP grant named fetch',
)
const event = z.object({
  id: z.string().min(1).max(256),
  type: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/),
  content: z.string().max(32_768),
  meta: z.record(z.unknown()).optional(),
}).strict()
const result = z.object({
  events: z.array(event).max(100),
  checkpoint: z.unknown(),
}).strict()
const definition = z.object({
  id: identifier,
  ownerSessionId: z.string().min(1),
  code: z.string().min(1).max(512_000),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  intervalMs: z.number().int().min(30_000).max(86_400_000),
  grant: httpGrant,
  checkpoint: z.unknown(),
  seen: z.array(z.string()).max(1000),
}).strict()
export type PollingSource = z.infer<typeof definition>
export type NewPollingSource = Pick<PollingSource, 'id' | 'ownerSessionId' | 'code' | 'intervalMs' | 'grant'>

function hash(source: Pick<PollingSource, 'id' | 'ownerSessionId' | 'code' | 'intervalMs' | 'grant'>): string {
  return createHash('sha256').update(JSON.stringify([
    source.id, source.ownerSessionId, source.code, source.intervalMs, source.grant,
  ])).digest('hex')
}

/** Project-owned polling sources; scripts run only in disposable restricted children. */
export class PollingSources {
  private readonly path: string
  private readonly sources = new Map<string, PollingSource>()
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<number> }>()
  private readonly status = new Map<string, { lastRunAt?: string; lastError?: string; lastDelivered?: number }>()
  private stopped = true

  constructor(
    workspace: string,
    private events: EventService,
    private broker: CapabilityBroker,
    private canDeliver: (sessionId: string) => boolean,
    private hasCredential: (ref: string) => boolean,
  ) {
    const directory = projectStoragePath(workspace, '.events')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'polling-sources.json')
  }

  start(): void {
    if (!this.stopped) return
    let saved: unknown
    try {
      saved = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      saved = []
    }
    const parsed = z.array(definition).parse(saved)
    this.sources.clear()
    for (const source of parsed) {
      if (source.hash !== hash(source)) throw new Error(`Event source ${source.id} changed on disk`)
      if (this.sources.has(source.id)) throw new Error(`Duplicate event source ${source.id}`)
      this.sources.set(source.id, source)
      this.events.registerManagedSource({
        source: `custom:${source.id}`, kind: 'custom', ownerSessionId: source.ownerSessionId,
        description: `Polling source ${source.id}`,
      })
    }
    this.stopped = false
    for (const source of this.sources.values()) this.schedule(source)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    for (const run of this.running.values()) run.controller.abort()
    await Promise.allSettled([...this.running.values()].map(run => run.promise))
  }

  list(ownerSessionId?: string): Array<Omit<PollingSource, 'code' | 'checkpoint' | 'seen'> & {
    running: boolean; lastRunAt?: string; lastError?: string; lastDelivered?: number
  }> {
    return [...this.sources.values()]
      .filter(source => !ownerSessionId || source.ownerSessionId === ownerSessionId)
      .map(({ code: _code, checkpoint: _checkpoint, seen: _seen, ...details }) =>
        ({ ...structuredClone(details), running: this.running.has(details.id), ...this.status.get(details.id) }))
  }

  create(input: NewPollingSource): PollingSource {
    if (this.stopped) throw new Error('Polling sources are stopped')
    const grant = httpGrant.parse(input.grant)
    const source = definition.parse({
      ...input, grant, hash: hash({ ...input, grant }), checkpoint: null, seen: [],
    })
    if (this.sources.has(source.id)) throw new Error(`Event source ${source.id} already exists; remove it before replacing its permissions`)
    if (!this.canDeliver(source.ownerSessionId)) throw new Error('Event source owner must be a durable session in this Project')
    if (source.grant.credential && !this.hasCredential(source.grant.credential.secretRef)) {
      throw new Error(`Credential reference ${source.grant.credential.secretRef} is not provisioned`)
    }
    this.events.registerManagedSource({
      source: `custom:${source.id}`, kind: 'custom', ownerSessionId: source.ownerSessionId,
      description: `Polling source ${source.id}`,
    })
    this.sources.set(source.id, source)
    try { this.save() } catch (error) {
      this.sources.delete(source.id)
      this.events.unregisterManagedSource(`custom:${source.id}`)
      throw error
    }
    this.schedule(source)
    return structuredClone(source)
  }

  async remove(id: string, ownerSessionId: string): Promise<boolean> {
    const source = this.sources.get(id)
    if (!source || source.ownerSessionId !== ownerSessionId) return false
    const timer = this.timers.get(id)
    if (timer) clearInterval(timer)
    this.timers.delete(id)
    const run = this.running.get(id)
    if (run) {
      run.controller.abort()
      await Promise.allSettled([run.promise])
    }
    this.sources.delete(id)
    try { this.save() } catch (error) { this.sources.set(id, source); this.schedule(source); throw error }
    this.events.unregisterManagedSource(`custom:${id}`)
    await this.events.flush()
    this.status.delete(id)
    return true
  }

  async run(id: string, ownerSessionId: string): Promise<number> {
    const source = this.sources.get(id)
    if (!source || source.ownerSessionId !== ownerSessionId) throw new Error('Event source not found for this session')
    if (this.stopped) throw new Error('Polling sources are stopped')
    const previous = this.running.get(id)
    if (previous) return previous.promise
    const controller = new AbortController()
    const promise = this.poll(source, controller.signal).then(
      count => {
        this.status.set(id, { lastRunAt: new Date().toISOString(), lastDelivered: count })
        return count
      },
      error => {
        const message = error instanceof Error && error.message.startsWith('Subscribe this session')
          ? 'missing_subscription'
          : error instanceof Error && error.message.startsWith('No owner subscription')
          ? 'no_matching_subscription'
          : error instanceof Error && /^Script [a-z_]+\.$/.test(error.message)
          ? error.message
          : error instanceof z.ZodError ? 'invalid_output' : 'execution_failed'
        this.status.set(id, { lastRunAt: new Date().toISOString(), lastError: message })
        throw error
      },
    ).finally(() => this.running.delete(id))
    this.running.set(id, { controller, promise })
    return promise
  }

  private schedule(source: PollingSource): void {
    const timer = setInterval(() => {
      void this.run(source.id, source.ownerSessionId).catch(error => {
        console.error('[events] Polling source failed', { id: source.id, error: error instanceof Error ? error.name : 'Error' })
      })
    }, source.intervalMs)
    timer.unref()
    this.timers.set(source.id, timer)
  }

  private async poll(source: PollingSource, signal: AbortSignal): Promise<number> {
    if (!this.canDeliver(source.ownerSessionId)) throw new Error('Event source owner is unavailable')
    if (hash(source) !== source.hash) throw new Error('Event source checksum mismatch')
    if (!this.events.list(source.ownerSessionId).some(subscription => subscription.source === `custom:${source.id}` &&
      !subscription.channel && !subscription.chatId)) {
      throw new Error(`Subscribe this session to custom:${source.id} before polling`)
    }
    const output = await executeAuthoredTool({
      code: source.code, args: { checkpoint: structuredClone(source.checkpoint) },
      signal, imports: ['@shadow/fetch'], allowedModules: ['@shadow/fetch'],
      callModule: (name, input, callSignal) => {
        if (name !== 'fetch') throw new Error('Unknown event source capability')
        if (!this.canDeliver(source.ownerSessionId) || this.stopped || this.sources.get(source.id) !== source) {
          throw new Error('Event source authorization changed')
        }
        return this.broker.execute(source.grant, input, {
          sessionId: source.ownerSessionId, inputId: `event-source:${source.id}`,
          toolCallId: `event-source:${source.id}`, bindingKey: `event-source:${source.id}`,
          revision: source.hash, signal: callSignal,
          assertCurrent: () => {
            if (this.stopped || this.sources.get(source.id) !== source || !this.canDeliver(source.ownerSessionId)) {
              throw new Error('Event source authorization changed')
            }
          },
        })
      },
    })
    const data = result.parse(output)
    const checkpoint = JSON.stringify(data.checkpoint)
    if (checkpoint === undefined || Buffer.byteLength(checkpoint) > 65_536) throw new Error('Invalid event source checkpoint')
    const ids = new Set<string>()
    let delivered = 0
    for (const item of data.events) {
      signal.throwIfAborted()
      if (ids.has(item.id)) throw new Error(`Duplicate event ID in poll: ${item.id}`)
      ids.add(item.id)
      if (source.seen.includes(item.id)) continue
      const subscribed = this.events.list(source.ownerSessionId).some(subscription =>
        (subscription.event === '*' || subscription.event === item.type) &&
        (!subscription.source || subscription.source === `custom:${source.id}`) &&
        !subscription.channel && !subscription.chatId)
      if (!subscribed) throw new Error(`No owner subscription for event type ${item.type}`)
      await this.events.emit({
        id: `${source.id}:${item.id}`, type: item.type, source: `custom:${source.id}`,
        content: item.content, meta: item.meta, audienceSessionIds: [source.ownerSessionId],
      })
      const previousSeen = source.seen
      source.seen = [...source.seen, item.id].slice(-1000)
      try { this.save() } catch (error) { source.seen = previousSeen; throw error }
      delivered++
    }
    const previousCheckpoint = source.checkpoint
    source.checkpoint = JSON.parse(checkpoint)
    try { this.save() } catch (error) { source.checkpoint = previousCheckpoint; throw error }
    return delivered
  }

  private save(): void {
    writePrivateFile(this.path, JSON.stringify([...this.sources.values()]))
  }
}
