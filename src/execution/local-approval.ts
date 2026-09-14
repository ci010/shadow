import type { JobRequestV1 } from './contracts.ts'
import { parseWorkdirProcessArgs, type WorkdirProcessArgs } from './capability-shell.ts'

export type LocalApprovalPolicy = 'always' | 'session' | 'grant'
export type LocalApprovalGrantScope = 'once' | 'session' | 'capability'

export interface LocalApprovalCapability {
  readonly capabilityId: string
  readonly displayName: string
  readonly policy: LocalApprovalPolicy
}

export interface LocalApprovalSummaryV1 {
  readonly version: 1
  readonly operation: string
  readonly capabilityDisplayName: string
  readonly action: string
  readonly target?: string
  readonly detail?: string
  readonly process?: WorkdirProcessArgs
}

export interface PendingLocalApprovalV1 {
  readonly version: 1
  readonly approvalId: string
  readonly jobId: string
  readonly sessionId: string
  readonly capabilityId: string
  readonly operation: string
  readonly requestedAt: string
  readonly deadlineAt: string
  readonly allowedScopes: readonly LocalApprovalGrantScope[]
  readonly summary: LocalApprovalSummaryV1
}

export interface LocalApprovalGrantV1 {
  readonly version: 1
  readonly scope: 'session' | 'capability'
  readonly capabilityId: string
  readonly operation: string
  readonly sessionId?: string
}

export interface LocalApprovalAuthority {
  authorize(
    request: JobRequestV1,
    signal: AbortSignal,
    onPending: () => void,
  ): Promise<boolean>
}

export interface LocalApprovalService extends LocalApprovalAuthority {
  start(signal: AbortSignal): Promise<void>
  shutdown(): Promise<void>
  listPending(): PendingLocalApprovalV1[]
  listGrants(): LocalApprovalGrantV1[]
  approve(approvalId: string, scope: LocalApprovalGrantScope): boolean
  deny(approvalId: string): boolean
  revoke(options: {
    readonly capabilityId: string
    readonly operation?: string
    readonly sessionId?: string
  }): number
}

interface PendingRecord {
  readonly value: PendingLocalApprovalV1
  readonly request: JobRequestV1
  readonly resolve: (approved: boolean) => void
  readonly decision: Promise<boolean>
  readonly signal: AbortSignal
  readonly abort: () => void
}

interface ApprovalGrant {
  readonly scope: Exclude<LocalApprovalGrantScope, 'once'>
  readonly capabilityId: string
  readonly operation: string
  readonly sessionId?: string
}

export class InMemoryLocalApprovalService implements LocalApprovalService {
  readonly #capabilities = new Map<string, LocalApprovalCapability>()
  readonly #pending = new Map<string, PendingRecord>()
  readonly #grants = new Map<string, ApprovalGrant>()
  #lifecycleSignal?: AbortSignal
  #lifecycleAbort?: () => void
  #stopped = false

  constructor(capabilities: readonly LocalApprovalCapability[]) {
    for (const capability of capabilities) {
      if (!capability.capabilityId || !capability.displayName) {
        throw new TypeError(
          'Approval capabilities require IDs and display names',
        )
      }
      if (this.#capabilities.has(capability.capabilityId)) {
        throw new TypeError('Approval capability IDs must be unique')
      }
      this.#capabilities.set(capability.capabilityId, { ...capability })
    }
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#lifecycleSignal !== undefined) {
      throw new Error('Local approval service is already started')
    }
    this.#stopped = false
    this.#lifecycleSignal = signal
    this.#lifecycleAbort = () => this.#stop()
    signal.addEventListener('abort', this.#lifecycleAbort, { once: true })
    if (signal.aborted) this.#stop()
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    this.#stop()
    return Promise.resolve()
  }

  authorize(
    request: JobRequestV1,
    signal: AbortSignal,
    onPending: () => void,
  ): Promise<boolean> {
    const capability = this.#capabilities.get(request.capabilityId)
    if (!capability || this.#stopped) return Promise.resolve(false)
    const forcePrompt = request.approval === 'local-required'
    if (!forcePrompt && this.#hasGrant(request, capability.policy)) {
      return Promise.resolve(true)
    }
    const approvalId = request.jobId
    const existing = this.#pending.get(approvalId)
    if (existing) return existing.decision

    const decision = Promise.withResolvers<boolean>()
    const abort = () => {
      const record = this.#pending.get(approvalId)
      if (record?.resolve !== decision.resolve) return
      this.#pending.delete(approvalId)
      decision.resolve(false)
    }
    const record: PendingRecord = {
      value: {
        version: 1,
        approvalId,
        jobId: request.jobId,
        sessionId: request.sessionId,
        capabilityId: request.capabilityId,
        operation: request.operation,
        requestedAt: new Date().toISOString(),
        deadlineAt: request.deadlineAt,
        allowedScopes: allowedScopes(capability.policy),
        summary: summarizeRequest(request, capability.displayName),
      },
      request: structuredClone(request),
      resolve: decision.resolve,
      decision: decision.promise,
      signal,
      abort,
    }
    this.#pending.set(approvalId, record)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else onPending()
    return decision.promise.finally(() => {
      signal.removeEventListener('abort', abort)
    })
  }

  listPending(): PendingLocalApprovalV1[] {
    return [...this.#pending.values()].map((record) =>
      structuredClone(record.value)
    )
  }

  listGrants(): LocalApprovalGrantV1[] {
    return [...this.#grants.values()].map((grant) => ({
      version: 1,
      ...structuredClone(grant),
    }))
  }

  approve(approvalId: string, scope: LocalApprovalGrantScope): boolean {
    const record = this.#pending.get(approvalId)
    if (!record || !record.value.allowedScopes.includes(scope)) return false
    this.#pending.delete(approvalId)
    record.signal.removeEventListener('abort', record.abort)
    if (scope !== 'once') this.#storeGrant(record.request, scope)
    record.resolve(true)
    return true
  }

  deny(approvalId: string): boolean {
    const record = this.#pending.get(approvalId)
    if (!record) return false
    this.#pending.delete(approvalId)
    record.signal.removeEventListener('abort', record.abort)
    record.resolve(false)
    return true
  }

  revoke(options: {
    readonly capabilityId: string
    readonly operation?: string
    readonly sessionId?: string
  }): number {
    let revoked = 0
    for (const [key, grant] of this.#grants) {
      if (grant.capabilityId !== options.capabilityId) continue
      if (
        options.operation !== undefined && grant.operation !== options.operation
      ) {
        continue
      }
      if (
        options.sessionId !== undefined && grant.sessionId !== options.sessionId
      ) {
        continue
      }
      this.#grants.delete(key)
      revoked++
    }
    return revoked
  }

  #hasGrant(request: JobRequestV1, policy: LocalApprovalPolicy): boolean {
    if (policy === 'always') return false
    if (policy === 'session') {
      return this.#grants.has(grantKey({
        scope: 'session',
        capabilityId: request.capabilityId,
        operation: request.operation,
        sessionId: request.sessionId,
      }))
    }
    return this.#grants.has(grantKey({
      scope: 'capability',
      capabilityId: request.capabilityId,
      operation: request.operation,
    })) || this.#grants.has(grantKey({
      scope: 'session',
      capabilityId: request.capabilityId,
      operation: request.operation,
      sessionId: request.sessionId,
    }))
  }

  #storeGrant(
    request: JobRequestV1,
    scope: Exclude<LocalApprovalGrantScope, 'once'>,
  ): void {
    const grant: ApprovalGrant = {
      scope,
      capabilityId: request.capabilityId,
      operation: request.operation,
      ...(scope === 'session' ? { sessionId: request.sessionId } : {}),
    }
    this.#grants.set(grantKey(grant), grant)
  }

  #stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#lifecycleSignal && this.#lifecycleAbort) {
      this.#lifecycleSignal.removeEventListener('abort', this.#lifecycleAbort)
    }
    this.#lifecycleSignal = undefined
    this.#lifecycleAbort = undefined
    for (const record of this.#pending.values()) {
      record.signal.removeEventListener('abort', record.abort)
      record.resolve(false)
    }
    this.#pending.clear()
    this.#grants.clear()
  }
}

function allowedScopes(policy: LocalApprovalPolicy): LocalApprovalGrantScope[] {
  if (policy === 'always') return ['once']
  if (policy === 'session') return ['once', 'session']
  return ['once', 'session', 'capability']
}

function grantKey(grant: ApprovalGrant): string {
  return [
    grant.scope,
    grant.capabilityId,
    grant.operation,
    grant.sessionId ?? '',
  ].join('\0')
}

function summarizeRequest(
  request: JobRequestV1,
  capabilityDisplayName: string,
): LocalApprovalSummaryV1 {
  const args = isRecord(request.args) ? request.args : {}
  if (request.operation === 'workdir.process.execute') {
    let process: WorkdirProcessArgs | undefined
    try { process = parseWorkdirProcessArgs(args) } catch { /* Invalid arguments cannot be approved by exact process matching. */ }
    return {
      version: 1,
      operation: request.operation,
      capabilityDisplayName,
      action: 'Run a shell as the Child user (not sandboxed)',
      ...(typeof args.script === 'string' ? { target: boundedSingleLine(args.script) } : {}),
      detail: `Initial directory: capability root${typeof args.cwd === 'string' ? ` / ${boundedSingleLine(args.cwd)}` : ''}. Shell can access resources outside this directory.`,
      ...(process ? { process: structuredClone(process) } : {}),
    }
  }
  if (request.operation === 'process.execute') {
    return {
      version: 1,
      operation: request.operation,
      capabilityDisplayName,
      action: 'Run a local process',
      ...(typeof args.script === 'string'
        ? { target: boundedSingleLine(args.script) }
        : {}),
      ...(typeof args.cwd === 'string'
        ? { detail: `Working directory: ${boundedSingleLine(args.cwd)}` }
        : {}),
    }
  }
  if (request.operation === 'filesystem.read') {
    return {
      version: 1,
      operation: request.operation,
      capabilityDisplayName,
      action: 'Read a local file',
      ...(typeof args.path === 'string'
        ? { target: boundedSingleLine(args.path) }
        : {}),
    }
  }
  if (request.operation === 'filesystem.write') {
    const bytes = typeof args.content === 'string'
      ? new TextEncoder().encode(args.content).length
      : undefined
    return {
      version: 1,
      operation: request.operation,
      capabilityDisplayName,
      action: 'Write a local file',
      ...(typeof args.path === 'string'
        ? { target: boundedSingleLine(args.path) }
        : {}),
      ...(bytes === undefined ? {} : { detail: `${bytes} UTF-8 bytes` }),
    }
  }
  return {
    version: 1,
    operation: request.operation,
    capabilityDisplayName,
    action: 'Run a local capability operation',
  }
}

function boundedSingleLine(value: string): string {
  const singleLine = value.replaceAll(/\s+/g, ' ').trim()
  return singleLine.length <= 200
    ? singleLine
    : `${singleLine.slice(0, 197)}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
