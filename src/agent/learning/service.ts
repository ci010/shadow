import type { Bus } from '../../bus/bus.ts'
import type { ProjectScope } from '../../projects/scope.ts'
import type { CronService, CronJob } from '../../cron/service.ts'
import { LEARNING_AUTOMATIONS } from '../../cron/contracts.ts'

export interface LearningConfig {
  enabled?: boolean
  reflectIntervalMs: number
  encapsulateIntervalMs: number
  soulIntervalMs: number
}

export interface LearningCallbacks {
  reflector(signal: AbortSignal, job: CronJob, accepted: (sessionId: string) => void): Promise<unknown>
  encapsulator(signal: AbortSignal, job: CronJob, accepted: (sessionId: string) => void): Promise<unknown>
  soulReflector(signal: AbortSignal, job: CronJob, accepted: (sessionId: string) => void): Promise<unknown>
}

type Pipeline = keyof LearningCallbacks

export interface LearningPipelineStatus {
  intervalMs: number
  pending: boolean
  dispatching: boolean
  lastStartedAt?: string
  lastCheckedAt?: string
  /** Dispatch acceptance, not completion of the resulting agent session. */
  lastDispatchedAt?: string
  lastError?: string
}

export interface LearningStatus {
  projectId: string
  enabled: boolean
  stopped: boolean
  pipelines: Record<Pipeline, LearningPipelineStatus>
}

const intervalFields = {
  reflector: 'reflectIntervalMs',
  encapsulator: 'encapsulateIntervalMs',
  soulReflector: 'soulIntervalMs',
} as const
const pipelines = Object.keys(intervalFields) as Pipeline[]

function validateConfig(config: LearningConfig): void {
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new TypeError('Learning enabled must be a boolean')
  for (const field of Object.values(intervalFields)) {
    if (!Number.isInteger(config[field]) || config[field] < 1 || config[field] > 2_147_483_647) {
      throw new TypeError(`Learning ${field} must be a positive timer interval`)
    }
  }
}

/** Project-local activity buffers and dispatch lifecycle; persistence stays in its SessionManager. */
export class LearningService {
  private config: LearningConfig
  private stopped = false
  private stopping?: Promise<void>
  private subscriptions: string[] = []
  private running = new Map<Pipeline, { promise: Promise<void>; controller: AbortController }>()
  private states: Record<Pipeline, LearningPipelineStatus>

  constructor(
    private bus: Bus,
    private scope: ProjectScope,
    private callbacks: LearningCallbacks,
    config: LearningConfig,
    private cron: CronService,
    private isLearningSession: (sessionId: string) => boolean = () => false,
  ) {
    validateConfig(config)
    if (scope.closed) throw new Error('Learning requires a live project scope')
    this.config = { ...config }
    this.callbacks = { ...callbacks }
    this.states = {
      reflector: { intervalMs: config.reflectIntervalMs, pending: false, dispatching: false },
      encapsulator: { intervalMs: config.encapsulateIntervalMs, pending: false, dispatching: false },
      soulReflector: { intervalMs: config.soulIntervalMs, pending: false, dispatching: false },
    }
    this.subscriptions.push(bus.on('session.input.accepted', scope.bind((event) => {
      if (!event.sessionId.startsWith('sleep:') && !event.sessionId.startsWith('heartbeat:') && !this.isLearningSession(event.sessionId)) this.enqueue('reflector')
    })))
    this.subscriptions.push(bus.on('session.ended', scope.bind((event) => {
      if (event.agentType === 'reflector') {
        this.enqueue('encapsulator')
        this.enqueue('soulReflector')
      }
    })))
    this.schedule()
  }

  private get enabled(): boolean { return this.config.enabled !== false }

  status(): LearningStatus {
    return {
      projectId: this.scope.projectId,
      enabled: this.enabled,
      stopped: this.stopped,
      pipelines: {
        reflector: { ...this.states.reflector },
        encapsulator: { ...this.states.encapsulator },
        soulReflector: { ...this.states.soulReflector },
      },
    }
  }

  update(config: LearningConfig): void {
    if (this.stopped) throw new Error('LearningService is stopped')
    validateConfig(config)
    this.config = { ...config }
    for (const pipeline of pipelines) {
      this.states[pipeline].intervalMs = config[intervalFields[pipeline]]
      if (!this.enabled) this.states[pipeline].pending = false
    }
    if (!this.enabled) {
      for (const task of this.running.values()) task.controller.abort(new Error('Learning disabled'))
    }
    this.schedule()
  }

  private enqueue(pipeline: Pipeline): void {
    if (this.enabled && !this.stopped) this.states[pipeline].pending = true
  }

  async trigger(pipeline: Pipeline): Promise<unknown> {
    if (this.stopped) throw new Error('LearningService is stopped')
    const accepted = this.accepted.get(pipeline)
    if (accepted) return accepted
    const admission = Promise.withResolvers<string>()
    const waiters = this.admissions.get(pipeline) ?? new Set<(sessionId: string) => void>()
    waiters.add(admission.resolve)
    this.admissions.set(pipeline, waiters)
    if (!this.running.has(pipeline)) this.states[pipeline].pending = true
    this.manual.add(pipeline)
    const execution = this.cron.runNow(LEARNING_AUTOMATIONS[pipeline].id).then(() => {
      if (this.states[pipeline].lastError) throw new Error(this.states[pipeline].lastError)
      return this.results.get(pipeline)
    })
    try { return await Promise.race([admission.promise, execution]) }
    finally {
      waiters.delete(admission.resolve)
      if (!waiters.size) this.admissions.delete(pipeline)
      this.manual.delete(pipeline)
    }
  }
  private manual = new Set<Pipeline>()
  private results = new Map<Pipeline, unknown>()
  private accepted = new Map<Pipeline, string>()
  private admissions = new Map<Pipeline, Set<(sessionId: string) => void>>()

  private schedule(): void {
    if (this.stopped) return
    for (const pipeline of pipelines) {
      const builtin = LEARNING_AUTOMATIONS[pipeline]
      const intervalMs = this.states[pipeline].intervalMs
      this.cron.registerManagedJob(builtin.id, {
        name: builtin.name, agentType: builtin.agentType, source: 'learning',
        session: 'fresh', schedule: `every ${intervalMs}ms`, enabled: this.enabled,
      }, intervalMs, (job, signal) => this.dispatch(pipeline, job, signal))
    }
  }

  private async dispatch(pipeline: Pipeline, job: CronJob, signal: AbortSignal): Promise<void> {
    const state = this.states[pipeline]
    if ((!this.enabled && !this.manual.has(pipeline)) || this.stopped || !state.pending || this.running.has(pipeline)) return
    state.pending = false
    this.results.delete(pipeline)
    state.dispatching = true
    state.lastStartedAt = new Date().toISOString()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    // Defer invocation until its running record exists, including synchronously throwing callbacks.
    const promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const result = await this.callbacks[pipeline](controller.signal, job, sessionId => {
        this.accepted.set(pipeline, sessionId)
        state.lastDispatchedAt = new Date().toISOString()
        for (const resolve of this.admissions.get(pipeline) ?? []) resolve(sessionId)
      })
      controller.signal.throwIfAborted()
      this.results.set(pipeline, result)
      if (!controller.signal.aborted) {
        state.lastCheckedAt = new Date().toISOString()
        if (!this.accepted.has(pipeline) && (result === true || (typeof result === 'string' && result.length > 0))) state.lastDispatchedAt = state.lastCheckedAt
        state.lastError = undefined
      }
    }).catch((error: unknown) => {
      state.lastError = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) return
      this.enqueue(pipeline)
      console.error(`[learning] ${pipeline} dispatch failed (${this.scope.projectId}):`, error)
    }).finally(() => {
      state.dispatching = false
      this.running.delete(pipeline)
      this.accepted.delete(pipeline)
      signal.removeEventListener('abort', abort)
    })
    this.running.set(pipeline, { promise, controller })
    await promise
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopOwned()
    return this.stopping
  }

  private async stopOwned(): Promise<void> {
    this.stopped = true
    for (const pipeline of pipelines) this.cron.unregisterManagedJob(LEARNING_AUTOMATIONS[pipeline].id)
    for (const subscription of this.subscriptions) this.bus.off(subscription)
    this.subscriptions = []
    for (const pipeline of pipelines) this.states[pipeline].pending = false
    for (const task of this.running.values()) task.controller.abort(new Error('Learning stopped'))
    await Promise.all([...this.running.values()].map((task) => task.promise))
  }
}
