import { join } from 'node:path'
import { CopilotAuthenticator, CopilotAuthError, CopilotProvider, type CopilotAuthOptions, type CopilotGrant, type DeviceAuthorization, type ApiKeyInfo, type CopilotAuthStage, validApiKey } from './copilot.ts'

/** Sensitive direct App OAuth inference credential. Never log or expose in UI. */
export interface CopilotCredentialLease {
  readonly token: string
  readonly apiBase: string
  readonly host: string
  readonly revision: number
  readonly expiryKnown: boolean
  readonly expiresAt: number
}
/**
 * Direct App OAuth credential broker. Legacy credentials require explicit sign-in.
 * Existing files are preserved until a successful replacement sign-in. This is private
 * file-backed storage, NOT an OS keychain implementation.
 */
export class CopilotAuthenticatorV2 extends CopilotAuthenticator {
  private readonly children = new Map<string, CopilotAuthenticatorV2>()
  private legacy?: CopilotAuthenticator
  private epoch = 0
  private recheck?: { epoch: number; promise: Promise<void> }

  constructor(tokenDir?: string, private readonly v2Options: CopilotAuthOptions = {}) { super(tokenDir, v2Options) }

  // App OAuth authentication profile, not a replica of the App runtime.
  protected override deviceLoginClientId(_host: string): string { return 'Ov23ctr1Udn5GokVCVJf' }
  protected override deviceLoginScope(_host: string): string { return 'copilot' }

  protected override validateOAuthTokenResponse(response: Record<string, unknown>): void {
    // GitHub uses comma and/or ASCII whitespace delimiters. Match a whole scope,
    // never a prefix, and fail closed for absent or malformed scope metadata.
    if (typeof response.scope !== 'string' || !response.scope.split(/[,\x09-\x0d\x20]+/).includes('copilot')) {
      throw new CopilotAuthError('scope_missing', 'oauth_token')
    }
  }
  override startDeviceLogin(signal?: AbortSignal, host?: string): Promise<DeviceAuthorization> {
    return atAuthStage('oauth_device', () => super.startDeviceLogin(signal, host))
  }

  override completeDeviceLogin(device: DeviceAuthorization, signal?: AbortSignal, onInterval?: (ms: number) => void): Promise<CopilotGrant> {
    const epoch = this.epoch
    return atAuthStage('oauth_token', async () => {
      const grant = await super.completeDeviceLogin(device, signal, onInterval)
      if (epoch !== this.epoch) throw new CopilotAuthError('cancelled')
      return grant
    })
  }

  protected override async buildGrantFromOAuthResponse(response: Record<string, unknown>, host: string, signal?: AbortSignal): Promise<CopilotGrant> {
    return atAuthStage('copilot_access', async () => {
      const receivedAt = this.now()
      const accessToken = response.access_token as string
      const user = await this.fetchJson(`https://api.${host}/copilot_internal/user`, {
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'Copilot-Integration-Id': 'copilot-developer-app' },
      }, signal)
      if (user.copilot_plan === 'no_access' || (user.copilot_app_enabled === false && user.chat_enabled === false && user.cli_enabled === false)) throw new CopilotAuthError('denied')
      const expiryKnown = response.expires_in !== undefined
      if (expiryKnown && (typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in) || response.expires_in <= 0)) throw new CopilotAuthError('invalid')
      const apiKey: ApiKeyInfo = {
        token: accessToken,
        // Finite persistence sentinel, not an asserted lifetime or refresh capability.
        expires_at: expiryKnown ? receivedAt / 1000 + (response.expires_in as number) : Number.MAX_SAFE_INTEGER,
        directOAuth: { clientId: this.deviceLoginClientId(host), scope: response.scope as string, expiryKnown },
      }
      if (user.endpoints !== undefined) apiKey.endpoints = user.endpoints as ApiKeyInfo['endpoints']
      if (!this.isDirectKey(apiKey, host)) throw new CopilotAuthError('invalid')
      return { accessToken, host, apiKey }
    })
  }

  private isDirectKey(key: ApiKeyInfo | null, host: string): key is ApiKeyInfo {
    if (!key || key.directOAuth?.clientId !== this.deviceLoginClientId(host) || typeof key.directOAuth.expiryKnown !== 'boolean' ||
      typeof key.directOAuth.scope !== 'string' || !key.directOAuth.scope.split(/[,\x09-\x0d\x20]+/).includes('copilot')) return false
    return validApiKey(key, host) !== null
  }

  protected override acceptsApiKeyProfile(info: ApiKeyInfo, host: string): boolean {
    return this.isDirectKey(info, host)
  }

  override hasAccessToken(): boolean { return this.isDirectKey(this.readApiKeyFile(), this.getHost()) && super.hasAccessToken() }
  override hasValidApiKey(): boolean { return this.isDirectKey(this.readApiKeyFile(), this.getHost()) && super.hasValidApiKey() }

  override forInstance(id: string): CopilotAuthenticatorV2 {
    if (id === 'copilot') return this
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid provider instance ID')
    let child = this.children.get(id)
    if (!child) {
      child = new CopilotAuthenticatorV2(join(this.tokenDir, 'instances', id), { ...this.v2Options, isolated: true })
      this.children.set(id, child)
    }
    return child
  }

  /** Explicit rollback view. Composition must not run both versions for one instance. */
  forLegacyInstance(id: string): CopilotAuthenticator {
    this.legacy ??= new CopilotAuthenticator(this.tokenDir, this.v2Options)
    return this.legacy.forInstance(id)
  }

  private invalidate(): void {
    this.epoch++
  }

  override signOut(): void { this.invalidate(); super.signOut() }

  override persistGrant(grant: CopilotGrant, signal?: AbortSignal): () => void {
    if (!this.isDirectKey(grant.apiKey, grant.host ?? 'github.com') || grant.apiKey.token !== grant.accessToken) throw new CopilotAuthError('invalid')
    this.invalidate()
    const undo = super.persistGrant(grant, signal)
    return () => { this.invalidate(); undo() }
  }

  override clearApiKey(): void { this.invalidate(); super.clearApiKey() }

  override async getApiKey(signal?: AbortSignal, forceRefresh = false): Promise<string> {
    return (await this.acquireLease(signal, forceRefresh)).token
  }

  /** Rechecks share a request; caller cancellation never owns that request. */
  async acquireLease(signal?: AbortSignal, forceRefresh = false): Promise<CopilotCredentialLease> {
    signal?.throwIfAborted()
    const host = this.getHost()
    const revision = this.getRevision()
    const cached = this.readApiKeyFile(host)
    if (!this.isDirectKey(cached, host)) throw new CopilotAuthError('missing')
    if (cached.expires_at * 1000 <= this.now()) throw new CopilotAuthError('expired', 'copilot_access')
    if (forceRefresh) {
      const epoch = this.epoch
      const current = () => epoch === this.epoch && revision === this.getRevision() && host === this.getHost() &&
        this.readApiKeyFile(host)?.token === cached.token
      if (!this.recheck || this.recheck.epoch !== epoch) {
        const promise = atAuthStage('copilot_access', async () => {
          try {
            const user = await this.fetchJson(`https://api.${host}/copilot_internal/user`, {
              headers: { accept: 'application/json', authorization: `Bearer ${cached.token}`, 'Copilot-Integration-Id': 'copilot-developer-app' },
            })
            if (!current()) throw new CopilotAuthError('cancelled')
            if (user.copilot_plan === 'no_access' || (user.copilot_app_enabled === false && user.chat_enabled === false && user.cli_enabled === false)) throw new CopilotAuthError('denied')
            if (user.endpoints !== undefined && !this.isDirectKey({ ...cached, endpoints: user.endpoints as ApiKeyInfo['endpoints'] }, host)) throw new CopilotAuthError('invalid')
          } catch (error) {
            if (!current()) throw new CopilotAuthError('cancelled')
            if (error instanceof CopilotAuthError && error.code === 'denied') this.storage.remove(this.filesFor(host).key)
            throw error
          }
        })
        this.recheck = { epoch, promise }
        void promise.then(() => { if (this.recheck?.promise === promise) this.recheck = undefined },
          () => { if (this.recheck?.promise === promise) this.recheck = undefined })
      }
      await waitForRecheck(this.recheck.promise, signal)
      if (!current()) throw new CopilotAuthError('cancelled')
      if (cached.expires_at * 1000 <= this.now()) throw new CopilotAuthError('expired', 'copilot_access')
    }
    return Object.freeze({ token: cached.token, apiBase: this.getApiBase(), host, revision,
      expiresAt: cached.expires_at * 1000, expiryKnown: cached.directOAuth!.expiryKnown })
  }


}

async function atAuthStage<T>(stage: CopilotAuthStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof CopilotAuthError && !error.stage) {
      throw new CopilotAuthError(error.code, stage, error.httpStatus)
    }
    throw error
  }
}

function waitForRecheck(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new CopilotAuthError('cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(() => { signal.removeEventListener('abort', abort); resolve() }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** Reuses inference/Responses routing and billing; wire name remains copilot. */
export class CopilotProviderV2 extends CopilotProvider {
  constructor(auth: CopilotAuthenticator = new CopilotAuthenticatorV2()) { super(auth) }
  protected override inferenceHeaders(): Record<string, string> {
    return { ...super.inferenceHeaders(), 'copilot-integration-id': 'copilot-developer-app' }
  }
}
