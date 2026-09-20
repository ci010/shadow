import type { Executor } from '../execution/executor.ts'
import type { JobEventV1, JobRequestV1 } from '../execution/contracts.ts'
import { validateJobEventV1 } from '../execution/contracts.ts'
import type { CapabilityDescriptorV1, VersionHelloV1 } from './contracts.ts'
import {
  isClusterIdentifier,
  validateCapabilityDescriptorV1,
} from './contracts.ts'
import {
  NodeSessionError,
  type NodeSessionErrorCode,
} from './node-connection-session.ts'
import type { DeviceAuthenticationV1, NegotiatedVersionV1 } from './registry.ts'
import {
  type NodeSessionInboundFrameV1,
  type NodeSessionOutboundFrameV1,
  validateNodeSessionInboundFrameV1,
  validateNodeSessionOutboundFrameV1,
} from './node-session-contracts.ts'
import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'

export type ChildNodeConnectionState =
  | 'created'
  | 'awaiting-authentication'
  | 'authenticated'
  | 'closed'

export interface ChildNodeConnectionSessionOptions {
  maxOutboundQueue: number
  heartbeatTimeoutMs: number
  now?: () => Date
}

type ChildOutboundPayloadV1 =
  | { type: 'capability-advertise'; capability: CapabilityDescriptorV1 }
  | { type: 'capability-withdraw'; nodeId: string; capabilityId: string }
  | { type: 'job-event'; event: JobEventV1 }
  | { type: 'heartbeat'; sentAt: string }

export class ChildNodeConnectionSession {
  readonly #transport: NodeMessageDuplex
  readonly #localHello: VersionHelloV1
  readonly #authentication: DeviceAuthenticationV1
  readonly #executor: Executor
  readonly #options: ChildNodeConnectionSessionOptions
  readonly #capabilities = new Map<string, CapabilityDescriptorV1>()
  readonly #outbound: NodeSessionInboundFrameV1[] = []
  readonly #outboundSpace = new Set<() => void>()
  readonly #executions = new Set<AbortController>()
  readonly #closedResolver = Promise.withResolvers<DuplexCloseInfo>()
  readonly #authenticatedResolver = Promise.withResolvers<NegotiatedVersionV1>()
  #writerWake: (() => void) | undefined
  #state: ChildNodeConnectionState = 'created'
  #negotiated: NegotiatedVersionV1 | undefined
  #expectedInboundSequence = 0
  #nextOutboundSequence = 0
  #lastSeenAt: Date
  #outboundInFlight = false
  #closeInfo: DuplexCloseInfo | undefined
  #started = false

  readonly closed = this.#closedResolver.promise
  readonly authenticated = this.#authenticatedResolver.promise

  constructor(
    transport: NodeMessageDuplex,
    localHello: VersionHelloV1,
    authentication: DeviceAuthenticationV1,
    executor: Executor,
    options: ChildNodeConnectionSessionOptions,
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
    this.#transport = transport
    this.#localHello = structuredClone(localHello)
    this.#authentication = structuredClone(authentication)
    this.#executor = executor
    this.#options = options
    this.#lastSeenAt = this.#now()
    this.authenticated.catch(() => {})
  }

  get state(): ChildNodeConnectionState {
    return this.#state
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
    if (this.#started) {
      throw new NodeSessionError(
        'unexpected-message',
        'child node connection has already started',
      )
    }
    this.#started = true
    this.#state = 'awaiting-authentication'
    try {
      await this.#sendHandshakeFrame({
        type: 'hello',
        hello: structuredClone(this.#localHello),
      })
      await this.#sendHandshakeFrame({
        type: 'authenticate',
        authentication: structuredClone(this.#authentication),
      })
      this.#lastSeenAt = this.#now()
      void this.#writeLoop()
      for await (const value of this.#transport.incoming) {
        await this.handleIncoming(value)
      }
      if (this.state !== 'closed') {
        await this.close({
          code: 'peer-closed',
          reason: 'peer closed the connection',
          clean: true,
        })
      }
    } catch (error) {
      if (this.state !== 'closed') {
        const reason = error instanceof Error ? error.message : String(error)
        await this.close({ code: 'protocol-error', reason, clean: false })
      }
      throw error
    }
  }

  async handleIncoming(value: unknown): Promise<void> {
    this.#ensureOpen()
    const validation = validateNodeSessionOutboundFrameV1(value)
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

    if (this.#state === 'awaiting-authentication') {
      if (frame.type !== 'authenticated') {
        throw this.#fail(
          'unexpected-message',
          'authentication result must precede node control messages',
        )
      }
      this.#acceptAuthentication(frame.negotiated)
    } else if (this.#state === 'authenticated') {
      await this.#handleAuthenticated(frame)
    } else {
      throw this.#fail(
        'unexpected-message',
        'child node connection has not started',
      )
    }

    this.#expectedInboundSequence++
    this.#lastSeenAt = this.#now()
  }

  advertiseCapability(value: unknown): CapabilityDescriptorV1 {
    this.#requireAuthenticated()
    const validation = validateCapabilityDescriptorV1(value)
    if (!validation.success) {
      throw new NodeSessionError('invalid-frame', validation.errors.join('; '))
    }
    const capability = validation.value
    if (capability.nodeId !== this.#authentication.nodeId) {
      throw new NodeSessionError(
        'authorization-failed',
        'capability nodeId does not match the child connection',
      )
    }
    const advertised = structuredClone(capability)
    // Older Main versions reject unknown descriptor keys.
    if (!this.#negotiated?.features.includes('workdir-display-v1')) {
      delete advertised.displayPath
    }
    this.#enqueue({
      type: 'capability-advertise',
      capability: advertised,
    })
    this.#capabilities.set(capability.capabilityId, structuredClone(capability))
    return structuredClone(capability)
  }

  async advertiseCapabilityWhenReady(value: CapabilityDescriptorV1): Promise<void> {
    this.#requireAuthenticated()
    while (this.#outbound.length >= this.#options.maxOutboundQueue) {
      await new Promise<void>(resolve => this.#outboundSpace.add(resolve))
      this.#requireAuthenticated()
    }
    this.advertiseCapability(value)
  }

  withdrawCapability(capabilityId: string): boolean {
    this.#requireAuthenticated()
    if (!isClusterIdentifier(capabilityId)) {
      throw new NodeSessionError(
        'invalid-frame',
        'capabilityId must be a valid identifier',
      )
    }
    if (!this.#capabilities.has(capabilityId)) return false
    this.#enqueue({
      type: 'capability-withdraw',
      nodeId: this.#authentication.nodeId,
      capabilityId,
    })
    this.#capabilities.delete(capabilityId)
    return true
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
      reason: 'main heartbeat timeout exceeded',
      clean: false,
    })
    return false
  }

  async close(info: DuplexCloseInfo): Promise<void> {
    if (this.#state === 'closed') return
    const authenticated = this.#state === 'authenticated'
    this.#state = 'closed'
    this.#closeInfo = structuredClone(info)
    this.#outbound.splice(0)
    this.#releaseOutboundSpace()
    for (const execution of this.#executions) execution.abort(info.reason)
    this.#writerWake?.()
    if (!authenticated) {
      this.#authenticatedResolver.reject(
        new NodeSessionError(
          'authentication-failed',
          `child node connection closed before authentication: ${info.reason}`,
        ),
      )
    }
    this.#closedResolver.resolve(structuredClone(info))
    await this.#transport.close(info)
  }

  #acceptAuthentication(negotiated: NegotiatedVersionV1): void {
    if (negotiated.protocolMajor !== this.#localHello.protocolMajor) {
      throw this.#fail(
        'authentication-failed',
        'negotiated protocol major does not match the child',
      )
    }
    if (negotiated.protocolMinor > this.#localHello.protocolMinor) {
      throw this.#fail(
        'authentication-failed',
        'negotiated protocol minor exceeds the child version',
      )
    }
    if (
      negotiated.features.some((feature) =>
        !this.#localHello.features.includes(feature)
      )
    ) {
      throw this.#fail(
        'authentication-failed',
        'negotiated features are not supported by the child',
      )
    }
    this.#negotiated = structuredClone(negotiated)
    this.#state = 'authenticated'
    this.#authenticatedResolver.resolve(structuredClone(negotiated))
  }

  async #handleAuthenticated(
    frame: NodeSessionOutboundFrameV1,
  ): Promise<void> {
    if (frame.type === 'job-request') {
      this.#acceptJob(frame.request)
    } else if (frame.type === 'job-cancel') {
      await this.#executor.cancel(frame.jobId)
    } else if (frame.type === 'heartbeat') {
      return
    } else {
      throw this.#fail(
        'unexpected-message',
        `${frame.type} is not valid after authentication`,
      )
    }
  }

  #acceptJob(request: JobRequestV1): void {
    if (request.nodeId !== this.#authentication.nodeId) {
      throw this.#fail(
        'job-correlation-failed',
        'job nodeId does not match the child connection',
      )
    }
    if (!this.#capabilities.has(request.capabilityId)) {
      throw this.#fail(
        'job-correlation-failed',
        'job capability is not advertised by the child',
      )
    }
    const controller = new AbortController()
    this.#executions.add(controller)
    void this.#executeJob(structuredClone(request), controller)
  }

  async #executeJob(
    request: JobRequestV1,
    controller: AbortController,
  ): Promise<void> {
    let expectedSequence = 0
    try {
      for await (
        const event of this.#executor.execute(request, controller.signal)
      ) {
        const validation = validateJobEventV1(event)
        if (!validation.success) {
          throw new NodeSessionError(
            'invalid-frame',
            `executor emitted an invalid event: ${
              validation.errors.join('; ')
            }`,
          )
        }
        if (event.jobId !== request.jobId) {
          throw new NodeSessionError(
            'job-correlation-failed',
            'executor event jobId does not match its request',
          )
        }
        if (event.sequence !== expectedSequence) {
          throw new NodeSessionError(
            'job-sequence-mismatch',
            `expected executor event sequence ${expectedSequence}, received ${event.sequence}`,
          )
        }
        expectedSequence++
        while (this.#outbound.length >= this.#options.maxOutboundQueue) {
          await new Promise<void>(resolve => this.#outboundSpace.add(resolve))
          this.#ensureOpen()
        }
        this.#enqueue({ type: 'job-event', event: structuredClone(event) })
      }
    } catch (error) {
      if (this.#state !== 'closed') {
        const code = error instanceof NodeSessionError
          ? error.code
          : 'transport-failed'
        const reason = error instanceof Error ? error.message : String(error)
        await this.close({ code, reason, clean: false })
      }
    } finally {
      this.#executions.delete(controller)
    }
  }

  async #sendHandshakeFrame(
    payload:
      | { type: 'hello'; hello: VersionHelloV1 }
      | { type: 'authenticate'; authentication: DeviceAuthenticationV1 },
  ): Promise<void> {
    const frame = {
      version: 1,
      sequence: this.#nextOutboundSequence++,
      ...payload,
    }
    const validation = validateNodeSessionInboundFrameV1(frame)
    if (!validation.success) {
      throw new NodeSessionError('invalid-frame', validation.errors.join('; '))
    }
    await this.#transport.send(validation.value)
  }

  #enqueue(payload: ChildOutboundPayloadV1): void {
    this.#ensureOpen()
    if (this.#outbound.length >= this.#options.maxOutboundQueue) {
      throw new NodeSessionError(
        'outbound-queue-full',
        'child node outbound queue is full',
      )
    }
    const frame = {
      version: 1,
      sequence: this.#nextOutboundSequence++,
      ...payload,
    } as NodeSessionInboundFrameV1
    const validation = validateNodeSessionInboundFrameV1(frame)
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
      this.#releaseOutboundSpace()
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

  #releaseOutboundSpace(): void {
    for (const resolve of this.#outboundSpace) resolve()
    this.#outboundSpace.clear()
  }

  #requireAuthenticated(): void {
    this.#ensureOpen()
    if (this.#state !== 'authenticated') {
      throw new NodeSessionError(
        'unexpected-message',
        'child node connection is not authenticated',
      )
    }
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
