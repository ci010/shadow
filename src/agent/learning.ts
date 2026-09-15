import type { Bus } from '../bus/bus.ts'
import type { OrganizationScope } from '../otel/scope.ts'

export interface LearningConfig {
  enabled?: boolean
  reflectIntervalMs: number
  encapsulateIntervalMs: number
  soulIntervalMs: number
}

export interface LearningCallbacks {
  reflector(signal: AbortSignal): Promise<unknown>
  encapsulator(signal: AbortSignal): Promise<unknown>
  soulReflector(signal: AbortSignal): Promise<unknown>
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
  organizationId: string
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

/** Organization-local activity buffers and dispatch lifecycle; persistence stays in its SessionManager. */
export class LearningService {
  private config: LearningConfig
  private stopped = false
  private stopping?: Promise<void>
  private subscriptions: string[] = []
  private timers = new Map<Pipeline, ReturnType<typeof setInterval>>()
  private running = new Map<Pipeline, { promise: Promise<void>; controller: AbortController }>()
  private states: Record<Pipeline, LearningPipelineStatus>

  constructor(
    private bus: Bus,
    private scope: OrganizationScope,
    private callbacks: LearningCallbacks,
    config: LearningConfig,
  ) {
    validateConfig(config)
    if (scope.closed) throw new Error('Learning requires a live organization scope')
    this.config = { ...config }
    this.callbacks = { ...callbacks }
    this.states = {
      reflector: { intervalMs: config.reflectIntervalMs, pending: false, dispatching: false },
      encapsulator: { intervalMs: config.encapsulateIntervalMs, pending: false, dispatching: false },
      soulReflector: { intervalMs: config.soulIntervalMs, pending: false, dispatching: false },
    }
    this.subscriptions.push(bus.on('session.input.accepted', scope.bind((event) => {
      if (!event.sessionId.startsWith('sleep:') && !event.sessionId.startsWith('heartbeat:')) this.enqueue('reflector')
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
      organizationId: this.scope.organizationId,
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
    this.clearTimers()
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

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
  }

  private schedule(): void {
    if (!this.enabled || this.stopped) return
    for (const pipeline of pipelines) {
      this.timers.set(pipeline, setInterval(this.scope.bind(() => this.dispatch(pipeline)), this.states[pipeline].intervalMs))
    }
  }

  private dispatch(pipeline: Pipeline): void {
    const state = this.states[pipeline]
    if (!this.enabled || this.stopped || !state.pending || this.running.has(pipeline)) return
    state.pending = false
    state.dispatching = true
    state.lastStartedAt = new Date().toISOString()
    const controller = new AbortController()
    // Defer invocation until its running record exists, including synchronously throwing callbacks.
    const promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const result = await this.callbacks[pipeline](controller.signal)
      if (!controller.signal.aborted) {
        state.lastCheckedAt = new Date().toISOString()
        if (result === true || (typeof result === 'string' && result.length > 0)) state.lastDispatchedAt = state.lastCheckedAt
        state.lastError = undefined
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      state.lastError = error instanceof Error ? error.message : String(error)
      this.enqueue(pipeline)
      console.error(`[learning] ${pipeline} dispatch failed (${this.scope.organizationId}):`, error)
    }).finally(() => {
      state.dispatching = false
      this.running.delete(pipeline)
    })
    this.running.set(pipeline, { promise, controller })
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopOwned()
    return this.stopping
  }

  private async stopOwned(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    for (const subscription of this.subscriptions) this.bus.off(subscription)
    this.subscriptions = []
    for (const pipeline of pipelines) this.states[pipeline].pending = false
    for (const task of this.running.values()) task.controller.abort(new Error('Learning stopped'))
    await Promise.all([...this.running.values()].map((task) => task.promise))
  }
}
