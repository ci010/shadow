import type { JobEventV1, JobRequestV1 } from '../execution/contracts.ts'
import {
  validateJobEventV1,
  validateJobRequestV1,
} from '../execution/contracts.ts'
import type { VersionHelloV1 } from './contracts.ts'
import type {
  DeviceAuthenticationV1,
  InMemoryPairingNodeRegistry,
  NegotiatedVersionV1,
} from './registry.ts'
import { RegistryError } from './registry.ts'
import {
  type NodeSessionInboundFrameV1,
  type NodeSessionOutboundFrameV1,
  validateNodeSessionInboundFrameV1,
  validateNodeSessionOutboundFrameV1,
} from './node-session-contracts.ts'
import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'

export type NodeConnectionState =
  | 'awaiting-hello'
  | 'awaiting-authentication'
  | 'authenticated'
  | 'closed'

export type NodeSessionErrorCode =
  | 'invalid-frame'
  | 'unexpected-message'
  | 'sequence-mismatch'
  | 'authentication-failed'
  | 'authorization-failed'
  | 'job-correlation-failed'
  | 'job-sequence-mismatch'
  | 'outbound-queue-full'
  | 'heartbeat-timeout'
  | 'transport-failed'

export class NodeSessionError extends Error {
  constructor(readonly code: NodeSessionErrorCode, message: string) {
    super(message)
    this.name = 'NodeSessionError'
  }
}

export interface NodeConnectionSessionOptions {
  maxOutboundQueue: number
  heartbeatTimeoutMs: number
  expectedAuthentication?: DeviceAuthenticationV1
  now?: () => Date
  onJobEvent?: (
    event: JobEventV1,
    request: JobRequestV1,
  ) => void | Promise<void>
  onConnectionChange?: () => void
  onRegistryMutation?: (now: Date) => void | Promise<void>
}

interface TrackedJob {
  request: JobRequestV1
  lastSequence: number
  terminal: boolean
}

type OutboundPayloadV1 =
  | { type: 'authenticated'; negotiated: NegotiatedVersionV1 }
  | { type: 'job-request'; request: JobRequestV1 }
  | { type: 'job-cancel'; jobId: string }
  | { type: 'heartbeat'; sentAt: string }

const TERMINAL_EVENTS = new Set<JobEventV1['type']>([
  'cancel-acknowledged',
  'completed',
  'failed',
  'rejected',
  'expired',
])

export class NodeConnectionSession {
  readonly #registry: InMemoryPairingNodeRegistry
  readonly #transport: NodeMessageDuplex
  readonly #localHello: VersionHelloV1
  readonly #options: NodeConnectionSessionOptions
  readonly #jobs = new Map<string, TrackedJob>()
  readonly #advertisedCapabilities = new Set<string>()
  readonly #outbound: NodeSessionOutboundFrameV1[] = []
  readonly #closedResolver = Promise.withResolvers<DuplexCloseInfo>()
  #writerWake: (() => void) | undefined
  #state: NodeConnectionState = 'awaiting-hello'
  #remoteHello: NodeSessionInboundFrameV1 & { type: 'hello' } | undefined
  #authentication: DeviceAuthenticationV1 | undefined
  #negotiated: NegotiatedVersionV1 | undefined
  #expectedInboundSequence = 0
  #nextOutboundSequence = 0
  #lastSeenAt: Date
  #outboundInFlight = false
  #closeInfo: DuplexCloseInfo | undefined

  readonly closed = this.#closedResolver.promise

  constructor(
    registry: InMemoryPairingNodeRegistry,
    transport: NodeMessageDuplex,
    localHello: VersionHelloV1,
    options: NodeConnectionSessionOptions,
  ) {
    if (
      !Number.isSafeInteger(options.maxOutboundQueue) ||
      options.maxOutboundQueue < 1
    ) {
      throw new TypeError('maxOutboundQueue must be a positive safe integer')
    }
    if (
      !Number.isFinite(options.heartbeatTimeoutMs) ||
      options.heartbeatTimeoutMs <= 0
    ) {
      throw new TypeError('heartbeatTimeoutMs must be positive')
    }
    this.#registry = registry
    this.#transport = transport
    this.#localHello = structuredClone(localHello)
    this.#options = options
    this.#lastSeenAt = this.#now()
    void this.#writeLoop()
  }

  get state(): NodeConnectionState {
    return this.#state
  }

  hasAdvertisedCapability(capabilityId: string): boolean {
    return this.#state === 'authenticated' &&
      this.#advertisedCapabilities.has(capabilityId)
  }

  get authentication(): DeviceAuthenticationV1 | undefined {
    return this.#authentication && structuredClone(this.#authentication)
  }

  get negotiatedVersion(): NegotiatedVersionV1 | undefined {
    return this.#negotiated && structuredClone(this.#negotiated)
  }

  get outboundQueueSize(): number {
    return this.#outbound.length
  }

  get outboundInFlight(): boolean {
    return this.#outboundInFlight
  }

  async run(): Promise<void> {
    try {
      for await (const value of this.#transport.incoming) {
        await this.handleIncoming(value)
      }
      if (this.#state !== 'closed') {
        await this.close({
          code: 'peer-closed',
          reason: 'peer closed the connection',
          clean: true,
        })
      }
    } catch (error) {
      if (this.#state !== 'closed') {
        const reason = error instanceof Error ? error.message : String(error)
        await this.close({ code: 'protocol-error', reason, clean: false })
      }
      throw error
    }
  }

  async handleIncoming(value: unknown): Promise<void> {
    this.#ensureOpen()
    const validation = validateNodeSessionInboundFrameV1(value)
    if (!validation.success) {
      throw this.#fail('invalid-frame', validation.errors.join('; '))
    }
    const frame = validation.value
    if (frame.sequence !== this.#expectedInboundSequence) {
      throw this.#fail(
        'sequence-mismatch',
        `expected inbound sequence ${this.#expectedInboundSequence}, received ${frame.sequence}`,
      )
    }

    if (this.#state === 'awaiting-hello') {
      if (frame.type !== 'hello') {
        throw this.#fail(
          'unexpected-message',
          'version hello must be the first message',
        )
      }
      this.#remoteHello = frame
      this.#state = 'awaiting-authentication'
    } else if (this.#state === 'awaiting-authentication') {
      if (frame.type !== 'authenticate') {
        throw this.#fail(
          'unexpected-message',
          'authentication must follow version hello',
        )
      }
      this.#authenticate(frame.authentication)
    } else {
      await this.#handleAuthenticated(frame)
    }

    this.#expectedInboundSequence++
    this.#lastSeenAt = this.#now()
  }

  dispatchJob(value: unknown): JobRequestV1 {
    const auth = this.#requireAuthenticated()
    this.#registry.authenticate(auth)
    const validation = validateJobRequestV1(value)
    if (!validation.success) {
      throw new NodeSessionError('invalid-frame', validation.errors.join('; '))
    }
    const request = validation.value
    if (request.nodeId !== auth.nodeId) {
      throw new NodeSessionError(
        'job-correlation-failed',
        'job nodeId does not match the connection',
      )
    }
    if (
      !this.#registry.listCapabilities(auth.nodeId).some((capability) =>
        capability.capabilityId === request.capabilityId && capability.online
      )
    ) {
      throw new NodeSessionError(
        'job-correlation-failed',
        'job capability is not advertised and online',
      )
    }
    if (this.#jobs.has(request.jobId)) {
      throw new NodeSessionError(
        'job-correlation-failed',
        'jobId is already tracked by this connection',
      )
    }
    this.#enqueue({ type: 'job-request', request: structuredClone(request) })
    this.#jobs.set(request.jobId, {
      request: structuredClone(request),
      lastSequence: -1,
      terminal: false,
    })
    return structuredClone(request)
  }

  dispatchCancellation(jobId: string): void {
    this.#requireAuthenticated()
    const tracked = this.#jobs.get(jobId)
    if (!tracked) {
      throw new NodeSessionError(
        'job-correlation-failed',
        'cancellation references an unknown job',
      )
    }
    if (tracked.terminal) {
      throw new NodeSessionError(
        'job-correlation-failed',
        'cancellation references a terminal job',
      )
    }
    this.#enqueue({ type: 'job-cancel', jobId })
  }

  sendHeartbeat(now = this.#now()): void {
    this.#requireAuthenticated()
    this.#enqueue({ type: 'heartbeat', sentAt: now.toISOString() })
  }

  async checkLiveness(now = this.#now()): Promise<boolean> {
    if (this.#state === 'closed') return false
    if (
      now.getTime() - this.#lastSeenAt.getTime() <=
        this.#options.heartbeatTimeoutMs
    ) return true
    await this.close({
      code: 'heartbeat-timeout',
      reason: 'node heartbeat timeout exceeded',
      clean: false,
    })
    return false
  }

  async checkAuthorization(): Promise<boolean> {
    if (!this.#authentication || this.#state === 'closed') return false
    try {
      this.#registry.authenticate(this.#authentication)
      return true
    } catch (error) {
      if (error instanceof RegistryError && error.code === 'node-revoked') {
        await this.close({
          code: 'revoked',
          reason: error.message,
          clean: true,
        })
        return false
      }
      throw error
    }
  }

  async revoke(reason: string, now = this.#now()): Promise<void> {
    const auth = this.#requireAuthenticated()
    this.#registry.revoke(auth, reason, now)
    await this.#options.onRegistryMutation?.(now)
    await this.close({ code: 'revoked', reason, clean: true })
  }

  #notifyConnectionChange(): void {
    try { this.#options.onConnectionChange?.() } catch {
      console.warn('[cluster] Connection observer failed')
    }
  }

  async close(info: DuplexCloseInfo): Promise<void> {
    if (this.#state === 'closed') return
    const wasAuthenticated = this.#state === 'authenticated'
    this.#state = 'closed'
    if (wasAuthenticated) this.#notifyConnectionChange()
    this.#closeInfo = structuredClone(info)
    this.#outbound.splice(0)
    this.#writerWake?.()
    this.#closedResolver.resolve(structuredClone(info))
    await this.#transport.close(info)
  }

  #authenticate(authentication: DeviceAuthenticationV1): void {
    try {
      const expected = this.#options.expectedAuthentication
      if (
        expected &&
        (
          expected.deviceId !== authentication.deviceId ||
          expected.nodeId !== authentication.nodeId ||
          expected.credentialId !== authentication.credentialId
        )
      ) {
        throw new RegistryError(
          'credential-mismatch',
          'session authentication does not match the verified upgrade identity',
        )
      }
      this.#negotiated = this.#registry.reconnect(
        authentication,
        this.#localHello,
        this.#remoteHello?.hello,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.#fail('authentication-failed', message)
    }
    this.#authentication = structuredClone(authentication)
    this.#state = 'authenticated'
    this.#notifyConnectionChange()
    this.#enqueue({
      type: 'authenticated',
      negotiated: structuredClone(this.#negotiated),
    })
  }

  async #handleAuthenticated(frame: NodeSessionInboundFrameV1): Promise<void> {
    const auth = this.#requireAuthenticated()
    try {
      if (frame.type === 'capability-advertise') {
        this.#registry.advertiseCapability(auth, frame.capability)
        this.#advertisedCapabilities.add(frame.capability.capabilityId)
        await this.#options.onRegistryMutation?.(this.#now())
      } else if (frame.type === 'capability-withdraw') {
        this.#registry.withdrawCapability(
          auth,
          frame.nodeId,
          frame.capabilityId,
        )
        this.#advertisedCapabilities.delete(frame.capabilityId)
        await this.#options.onRegistryMutation?.(this.#now())
      } else if (frame.type === 'job-event') {
        this.#registry.authenticate(auth)
        await this.#acceptJobEvent(frame.event, auth)
      } else if (frame.type === 'heartbeat') {
        return
      } else {
        throw this.#fail(
          'unexpected-message',
          `${frame.type} is not valid after authentication`,
        )
      }
    } catch (error) {
      if (error instanceof NodeSessionError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw this.#fail('authorization-failed', message)
    }
  }

  async #acceptJobEvent(
    event: JobEventV1,
    auth: DeviceAuthenticationV1,
  ): Promise<void> {
    const validation = validateJobEventV1(event)
    if (!validation.success) {
      throw this.#fail('invalid-frame', validation.errors.join('; '))
    }
    const tracked = this.#jobs.get(event.jobId)
    if (!tracked) {
      throw this.#fail(
        'job-correlation-failed',
        'job event references an unknown job',
      )
    }
    if (tracked.terminal) {
      throw this.#fail(
        'job-correlation-failed',
        'job event follows a terminal event',
      )
    }
    if (event.sequence !== tracked.lastSequence + 1) {
      throw this.#fail(
        'job-sequence-mismatch',
        `expected job sequence ${
          tracked.lastSequence + 1
        }, received ${event.sequence}`,
      )
    }
    if ('receipt' in event) {
      if (
        event.receipt.jobId !== event.jobId ||
        event.receipt.nodeId !== auth.nodeId
      ) {
        throw this.#fail(
          'job-correlation-failed',
          'job receipt does not match its job and node',
        )
      }
    }
    tracked.lastSequence = event.sequence
    tracked.terminal = TERMINAL_EVENTS.has(event.type)
    await this.#options.onJobEvent?.(
      structuredClone(event),
      structuredClone(tracked.request),
    )
  }

  #enqueue(
    payload: OutboundPayloadV1,
  ): void {
    this.#ensureOpen()
    if (this.#outbound.length >= this.#options.maxOutboundQueue) {
      throw new NodeSessionError(
        'outbound-queue-full',
        'node outbound queue is full',
      )
    }
    const frame = {
      version: 1,
      sequence: this.#nextOutboundSequence++,
      ...payload,
    } as NodeSessionOutboundFrameV1
    const validation = validateNodeSessionOutboundFrameV1(frame)
    if (!validation.success) {
      throw new NodeSessionError('invalid-frame', validation.errors.join('; '))
    }
    this.#outbound.push(frame)
    this.#writerWake?.()
  }

  async #writeLoop(): Promise<void> {
    while (this.#state !== 'closed') {
      const frame = this.#outbound.shift()
      if (!frame) {
        await new Promise<void>((resolve) => this.#writerWake = resolve)
        this.#writerWake = undefined
        continue
      }
      try {
        this.#outboundInFlight = true
        await this.#transport.send(frame)
      } catch (error) {
        if (!this.#closeInfo) {
          const reason = error instanceof Error ? error.message : String(error)
          await this.close({ code: 'transport-failed', reason, clean: false })
        }
      } finally {
        this.#outboundInFlight = false
      }
    }
  }

  #requireAuthenticated(): DeviceAuthenticationV1 {
    this.#ensureOpen()
    if (this.#state !== 'authenticated' || !this.#authentication) {
      throw new NodeSessionError(
        'unexpected-message',
        'node connection is not authenticated',
      )
    }
    return this.#authentication
  }

  #ensureOpen(): void {
    if (this.#state === 'closed') {
      throw new NodeSessionError('unexpected-message', 'session is closed')
    }
  }

  #fail(code: NodeSessionErrorCode, message: string): NodeSessionError {
    void this.close({ code, reason: message, clean: false })
    return new NodeSessionError(code, message)
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date()
  }
}
