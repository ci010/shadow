import { randomUUID } from 'node:crypto'
import type { AgentCredentialStore } from './credentials.ts'
import { CredentialRequestError, parseCredentialRequest,
  type CredentialRequest, type CredentialRequestResult } from './credential-request-contract.ts'

export { CredentialRequestError } from './credential-request-contract.ts'

interface PendingRequest {
  metadata: CredentialRequest
  signal: AbortSignal
  abort: () => void
  resolve: (result: CredentialRequestResult) => void
  reject: (error: CredentialRequestError) => void
}

const pendingProjects = new Map<string, PendingRequest>()

/** One project-scoped owner prompt; neither requests nor results contain secret values. */
export class CredentialRequests {
  private active: PendingRequest | null = null
  private stopped = false
  private readonly projectId: string
  private readonly credentials: Pick<AgentCredentialStore, 'names' | 'put'>

  constructor(options: { projectId: string; credentials: Pick<AgentCredentialStore, 'names' | 'put'> }) {
    if (typeof options.projectId !== 'string' || options.projectId.length === 0 || options.projectId.length > 200) {
      throw new CredentialRequestError('invalid_project', 400, 'Invalid credential request project.')
    }
    this.projectId = options.projectId
    this.credentials = options.credentials
  }

  async request(input: { name: string; purpose: string }, signal: AbortSignal, sessionId: string): Promise<CredentialRequestResult> {
    if (this.stopped) throw new CredentialRequestError('stopped', 503, 'Credential requests are stopped.')
    if (signal.aborted) throw new CredentialRequestError('aborted', 409, 'Credential request was aborted.')
    if (pendingProjects.has(this.projectId)) throw new CredentialRequestError('request_pending', 409, 'A credential request is already pending for this project.')
    let name: string
    let purpose: string
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Reflect.ownKeys(input).length !== 2 || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'purpose') ||
        typeof input.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.name) ||
        typeof input.purpose !== 'string') throw new Error()
      name = input.name
      purpose = input.purpose.trim()
      if (!purpose || purpose.length > 500) throw new Error()
    } catch {
      throw new CredentialRequestError('invalid_request', 400, 'Provide a valid credential name and a purpose of 1 to 500 characters.')
    }
    let replacesExisting: boolean
    try { replacesExisting = this.credentials.names().includes(name) } catch {
      throw new CredentialRequestError('storage_error', 500, 'Credential storage is unavailable. Please retry.')
    }
    if (signal.aborted) throw new CredentialRequestError('aborted', 409, 'Credential request was aborted.')
    const metadata = parseCredentialRequest({
      id: randomUUID(), projectId: this.projectId, sessionId,
      secretRef: name, purpose, createdAt: new Date().toISOString(), replacesExisting,
    }, this.projectId)
    return new Promise<CredentialRequestResult>((resolve, reject) => {
      const pending: PendingRequest = {
        metadata, signal, resolve, reject,
        abort: () => {
          if (this.active !== pending) return
          this.clear(pending)
          reject(new CredentialRequestError('aborted', 409, 'Credential request was aborted.'))
        },
      }
      this.active = pending
      pendingProjects.set(this.projectId, pending)
      signal.addEventListener('abort', pending.abort, { once: true })
      if (signal.aborted) pending.abort()
    })
  }

  pending(): CredentialRequest | null {
    return this.active ? { ...this.active.metadata } : null
  }

  submit(requestId: string, value: unknown): CredentialRequestResult {
    const pending = this.requirePending(requestId)
    if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new CredentialRequestError('invalid_value', 400, 'Enter a nonempty header-safe credential of at most 16384 characters.')
    }
    try { this.credentials.put(pending.metadata.secretRef, value) } catch {
      throw new CredentialRequestError('storage_error', 500, 'Could not save the credential. Please retry.')
    }
    return this.complete(pending, 'saved')
  }

  cancel(requestId: string): CredentialRequestResult {
    return this.complete(this.requirePending(requestId), 'cancelled')
  }

  stop(): void {
    this.stopped = true
    if (this.active) {
      const pending = this.active
      this.clear(pending)
      pending.reject(new CredentialRequestError('stopped', 503, 'Credential requests are stopped.'))
    }
  }

  private requirePending(requestId: string): PendingRequest {
    const pending = this.active
    if (pending?.signal.aborted) pending.abort()
    if (!pending || this.active !== pending || typeof requestId !== 'string' || pending.metadata.id !== requestId) {
      throw new CredentialRequestError('stale_request', 409, 'Credential request is no longer pending.')
    }
    return pending
  }

  private complete(pending: PendingRequest, status: CredentialRequestResult['status']): CredentialRequestResult {
    this.clear(pending)
    const result: CredentialRequestResult = { requestId: pending.metadata.id, secretRef: pending.metadata.secretRef, status }
    // Keep the tool's result separate from the HTTP caller's mutable result.
    pending.resolve({ ...result })
    return result
  }

  private clear(pending: PendingRequest): void {
    pending.signal.removeEventListener('abort', pending.abort)
    if (this.active === pending) this.active = null
    if (pendingProjects.get(this.projectId) === pending) pendingProjects.delete(this.projectId)
  }
}
