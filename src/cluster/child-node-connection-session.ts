import { assertExecutionSupported, assertExecutionProtocol, validateExecutionSupport, validateWorkdirAdvertisement, type WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import type { Executor } from '../execution/executor.ts'
import type { JobEventV1, JobRequestV2 } from '../execution/contracts.ts'
import { validateJobEventV1 } from '../execution/contracts.ts'
import type { ExecutionSupport, VersionHelloV1 } from './contracts.ts'
import {
  isClusterIdentifier,
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
  | { type: 'workdir-advertise'; workdir: WorkdirAdvertisement }
  | { type: 'workdir-withdraw'; nodeId: string; workdirId: string }
  | { type: 'node-support'; nodeId: string; support: ExecutionSupport }
  | { type: 'job-event'; event: JobEventV1 }
  | { type: 'heartbeat'; sentAt: string }

export class ChildNodeConnectionSession {
  readonly #transport: NodeMessageDuplex
  readonly #localHello: VersionHelloV1
  readonly #authentication: DeviceAuthenticationV1
  readonly #executor: Executor
  readonly #options: ChildNodeConnectionSessionOptions
  #nodeSupport: ExecutionSupport = { operations: [] }
  readonly #workdirs = new Map<string, WorkdirAdvertisement>()
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

  advertiseWorkdir(value: unknown): WorkdirAdvertisement {
    this.#requireAuthenticated()
    assertExecutionProtocol(this.#negotiated?.features)
    const parsed = validateWorkdirAdvertisement(value)
    if (!parsed.success) throw new NodeSessionError('invalid-frame', parsed.errors.join('; '))
    if (parsed.value.nodeId !== this.#authentication.nodeId) throw new NodeSessionError('authorization-failed', 'Workdir belongs to another node')
    this.#enqueue({ type: 'workdir-advertise', workdir: parsed.value })
    this.#workdirs.set(parsed.value.workdirId, structuredClone(parsed.value))
    return parsed.value
  }

  async advertiseWorkdirWhenReady(value: WorkdirAdvertisement): Promise<void> {
    this.#requireAuthenticated()
    while (this.#outbound.length >= this.#options.maxOutboundQueue) {
      await new Promise<void>(resolve => this.#outboundSpace.add(resolve))
      this.#requireAuthenticated()
    }
    this.advertiseWorkdir(value)
  }

  withdrawWorkdir(workdirId: string): boolean {
    this.#requireAuthenticated()
    if (!isClusterIdentifier(workdirId)) throw new NodeSessionError('invalid-frame', 'Invalid workdir ID')
    if (!this.#workdirs.has(workdirId)) return false
    this.#enqueue({ type: 'workdir-withdraw', nodeId: this.#authentication.nodeId, workdirId })
    this.#workdirs.delete(workdirId)
    return true
  }

  advertiseNodeSupport(value: unknown): ExecutionSupport {
    this.#requireAuthenticated()
    assertExecutionProtocol(this.#negotiated?.features)
    const parsed = validateExecutionSupport(value, 'node')
    if (!parsed.success) throw new NodeSessionError('invalid-frame', parsed.errors.join('; '))
    this.#enqueue({ type: 'node-support', nodeId: this.#authentication.nodeId, support: parsed.value })
    this.#nodeSupport = structuredClone(parsed.value)
    return parsed.value
  }

  async advertiseNodeSupportWhenReady(value: ExecutionSupport): Promise<void> {
    this.#requireAuthenticated()
    while (this.#outbound.length >= this.#options.maxOutboundQueue) {
      await new Promise<void>(resolve => this.#outboundSpace.add(resolve))
      this.#requireAuthenticated()
    }
    this.advertiseNodeSupport(value)
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
    assertExecutionProtocol(negotiated.features)
    this.#negotiated = structuredClone(negotiated)
    this.#state = 'authenticated'
    this.#authenticatedResolver.resolve(structuredClone(negotiated))
  }

  async #handleAuthenticated(
    frame: NodeSessionOutboundFrameV1,
  ): Promise<void> {
    if (frame.type === 'job-request') {
      try { this.#acceptJob(frame.request) }
      catch (error) {
        const timestamp = this.#now().toISOString()
        this.#enqueue({ type: 'job-event', event: { version: 1, jobId: frame.request.jobId, sequence: 0, timestamp, type: 'rejected',
          receipt: { version: 1, jobId: frame.request.jobId, nodeId: this.#authentication.nodeId, state: 'rejected', finishedAt: timestamp,
            reason: { code: error instanceof Error && 'code' in error ? String(error.code) : 'admission-denied', message: error instanceof Error ? error.message : 'Admission denied', retryable: false } } } })
      }
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

  #acceptJob(request: JobRequestV2): void {
    if (request.nodeId !== this.#authentication.nodeId) {
      throw this.#fail(
        'job-correlation-failed',
        'job nodeId does not match the child connection',
      )
    }
    assertExecutionProtocol(this.#negotiated?.features)
    assertExecutionSupported(request, [...this.#workdirs.values()], this.#nodeSupport)
    const controller = new AbortController()
    this.#executions.add(controller)
    void this.#executeJob(structuredClone(request), controller)
  }

  async #executeJob(
    request: JobRequestV2,
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
