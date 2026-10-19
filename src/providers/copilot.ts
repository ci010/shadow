import { estimateUsageCost } from './cost.ts'
import { dirname, join } from 'node:path'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { env } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { writePrivateFile } from '../config/store.ts'
import { DEFAULT_COPILOT_MODEL } from '../config/defaults.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import { openaiChat } from './openai-compatible.ts'
import { openaiResponses } from './openai-responses.ts'
import { ProviderHttpError, providerFailureKind } from './provider.ts'
import type {
  ChatMessage,
  ContentPart,
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  ModelInfo,
} from './provider.ts'
import { Span } from '../otel/tracing.ts'
import { normalizeCopilotHost, copilotVerificationUri } from '../shared/copilot-host.ts'

// ---------------------------------------------------------------------------
//  Constants (matches litellm / VS Code Copilot extension)
// ---------------------------------------------------------------------------

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
// Public source: microsoft/vscode/extensions/github-authentication/src/{config,flows}.ts
// and vscode-copilot-chat@5863f5a/script/setup/getToken.mts. Hosted GHE uses the
// VS Code OAuth app. Retain the existing GitHub.com client for compatibility.
const GHE_CLIENT_ID = '01ab8ac9400c4e429b23'
function clientId(host: string): string {
  return host === 'github.com' ? GITHUB_CLIENT_ID : GHE_CLIENT_ID
}
function defaultApiBase(host: string): string {
  // GitHub Docs: Copilot enterprise-configuration documents copilot-api.SUBDOMAIN.ghe.com.
  // Deliberately narrower than the general *.SUBDOMAIN.ghe.com network allowlist.
  return host === 'github.com' ? GITHUB_COPILOT_API_BASE : `https://copilot-api.${host}`
}
function authHost(value: unknown): string {
  try { return normalizeCopilotHost(value) } catch { throw new CopilotAuthError('invalid') }
}
const GITHUB_COPILOT_API_BASE = 'https://api.githubcopilot.com'

const COPILOT_VERSION = '0.26.0'
const VSCODE_VERSION = '1.95.0'
const API_VERSION = '2025-04-01'
const EDITOR_VERSION = `vscode/${VSCODE_VERSION}`
const PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

/** Shape of a single entry in the Copilot `GET /models` response. */
interface CopilotModelInfo {
  id: string
  name?: string
  supported_endpoints?: string[]
  model_picker_enabled?: boolean
  capabilities?: {
    type?: string
    limits?: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
    }
    supports?: {
      vision?: boolean
      tool_calls?: boolean
      reasoning_effort?: string[]
    }
  }
}

/** Persisted shape of the on-disk Copilot model cache. */
interface ModelsCache {
  models: ModelInfo[]
  fetchedAt: number
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function validModelInfo(value: unknown): value is ModelInfo {
  if (!value || typeof value !== 'object') return false
  const model = value as ModelInfo
  return typeof model.id === 'string' && model.id.length > 0 &&
    (model.name === undefined || typeof model.name === 'string') &&
    (model.vision === undefined || typeof model.vision === 'boolean') &&
    (model.selectable === undefined || typeof model.selectable === 'boolean') &&
    (model.contextWindow === undefined || Number.isFinite(model.contextWindow)) &&
    (model.supportedEndpoints === undefined || stringList(model.supportedEndpoints)) &&
    (model.reasoningEfforts === undefined || stringList(model.reasoningEfforts))
}

function copilotModelError(
  code: 'model_not_supported' | 'unsupported_api_for_model' | 'unsupported_reasoning_effort',
  model: string,
  detail: string,
): ProviderHttpError {
  return new ProviderHttpError(400,
    `[copilot] ${code}: model ${JSON.stringify(`${model}@copilot`)}. ${detail} ` +
    'Refresh the Copilot model list and check Project settings > Models and any session or agent model override. ' +
    'The model was not substituted and the request was not automatically replayed.',
    code,
  )
}

export function copilotModelEndpoint(model: ModelInfo | undefined): '/chat/completions' | '/responses' {
  // Older caches and servers omitted capabilities; retain their chat protocol.
  if (model?.supportedEndpoints === undefined) return '/chat/completions'
  if (model.supportedEndpoints.includes('/chat/completions')) return '/chat/completions'
  if (model.supportedEndpoints.includes('/responses')) return '/responses'
  throw copilotModelError('unsupported_api_for_model', model.id,
    'This model does not advertise a supported HTTP chat or Responses API.')
}

export const COPILOT_VERIFICATION_URI = 'https://github.com/login/device'

// ---------------------------------------------------------------------------
//  Copilot Authenticator – OAuth Device Code Flow
// ---------------------------------------------------------------------------

interface ApiKeyInfo {
  token: string
  expires_at: number
  endpoints?: { api?: string }
}

export type CopilotAuthFailure = 'missing' | 'denied' | 'expired' | 'cancelled' | 'network' | 'proxy' | 'invalid' | 'storage'
const AUTH_MESSAGES: Record<CopilotAuthFailure, string> = {
  missing: 'Sign in to GitHub Copilot to continue.',
  denied: 'GitHub authorization was denied or Copilot access is unavailable. Sign in again.',
  expired: 'The GitHub code expired. Start a new sign-in.',
  cancelled: 'Sign-in was cancelled.',
  network: 'GitHub could not be reached. Check your connection and try again.',
  proxy: 'The system proxy could not connect to GitHub. Check the proxy or PAC service, then retry. Signing in again will not fix this connection problem.',
  invalid: 'GitHub returned an invalid authentication response. Try again.',
  storage: 'Credentials could not be saved. Check access to the application data directory.',
}

export class CopilotAuthError extends Error {
  constructor(readonly code: CopilotAuthFailure) {
    super(AUTH_MESSAGES[code])
    this.name = 'CopilotAuthError'
  }
}

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Omitted only in legacy GitHub.com fixtures. */
  host?: string
  expiresAt: number
  intervalMs: number
}

export interface CopilotGrant {
  /** Omitted grants retain the legacy GitHub.com meaning, never the active host. */
  host?: string
  accessToken: string
  apiKey: ApiKeyInfo
}

export interface CopilotAuthStorage {
  read(name: string): string | undefined
  write(name: string, value: string): void
  remove(name: string): void
}

interface CopilotAuthOptions {
  fetch?: typeof fetch
  now?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  storage?: CopilotAuthStorage
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CopilotAuthError('invalid')
  return value as Record<string, unknown>
}

function validApiKey(value: unknown, host: string): ApiKeyInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const info = value as ApiKeyInfo
  if (typeof info.token !== 'string' || !info.token.trim() || !Number.isFinite(info.expires_at)) return null
  if (info.endpoints !== undefined) {
    if (!info.endpoints || typeof info.endpoints !== 'object' || Array.isArray(info.endpoints)) return null
    if (info.endpoints.api !== undefined) {
      if (typeof info.endpoints.api !== 'string') return null
      try {
        const url = new URL(info.endpoints.api)
        // A base origin only: no credentials, port, URL suffix or parsing normalization tricks.
        if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          url.search || url.hash || url.pathname !== '/' ||
          ![url.origin, url.origin + '/'].includes(info.endpoints.api)) return null
        if (host === 'github.com') {
          if (!(url.hostname === 'githubcopilot.com' || url.hostname.endsWith('.githubcopilot.com'))) return null
        } else if (url.origin !== defaultApiBase(host)) return null
      } catch { return null }
    }
  }
  return info
}

/**
 * Handles the two-step GitHub Copilot auth:
 *
 * 1. **Device-code flow** → GitHub *access token* (long-lived, persisted).
 * 2. **Copilot internal API** → short-lived *API key* (Bearer token for
 *    `api.githubcopilot.com`). Refreshed automatically when expired.
 */
export class CopilotAuthenticator {
  private readonly tokenDir: string
  private readonly accessTokenFile: string
  private readonly apiKeyFile: string
  private readonly modelsCacheFile: string
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly storage: CopilotAuthStorage
  private readonly activeHostFile: string
  private activeHost: string
  private revision = 0
  private readonly refreshing = new Map<string, { revision: number; promise: Promise<string> }>()

  constructor(tokenDir?: string, options: CopilotAuthOptions = {}) {
    const homeDir = env.HOME || env.USERPROFILE || '.'
    this.tokenDir = tokenDir ??
      env.GITHUB_COPILOT_TOKEN_DIR ??
      join(homeDir, '.config', 'openclaw', 'github_copilot')

    this.accessTokenFile = join(
      this.tokenDir,
      env.GITHUB_COPILOT_ACCESS_TOKEN_FILE ?? 'access-token',
    )
    this.apiKeyFile = join(
      this.tokenDir,
      env.GITHUB_COPILOT_API_KEY_FILE ?? 'api-key.json',
    )
    this.modelsCacheFile = join(
      this.tokenDir,
      env.GITHUB_COPILOT_MODELS_CACHE_FILE ?? 'models.json',
    )
    this.request = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }))
    this.storage = options.storage ?? {
      read: (name) => {
        try { return readFileSync(name, 'utf8') } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw new CopilotAuthError('storage')
        }
      },
      write: (name, value) => {
        try {
          mkdirSync(dirname(name), { recursive: true, mode: 0o700 })
          chmodSync(this.tokenDir, 0o700)
          chmodSync(dirname(name), 0o700)
          writePrivateFile(name, value)
        } catch { throw new CopilotAuthError('storage') }
      },
      remove: (name) => {
        try { rmSync(name, { force: true }) } catch { throw new CopilotAuthError('storage') }
      },
    }
    this.activeHostFile = join(this.tokenDir, 'active-host')
    this.activeHost = authHost(this.storage.read(this.activeHostFile))
  }

  // ---- public API ---------------------------------------------------------

  /** Persisted selection. Starting or failing a login does not change it. */
  getHost(): string { return this.activeHost }

  /** Lets provider requests reject stale auth/model results across a sign-in or sign-out. */
  getRevision(): number { return this.revision }

  private filesFor(host: string) {
    // Legacy files and configured filename overrides belong ONLY to GitHub.com.
    return host === 'github.com' ? {
      access: this.accessTokenFile, key: this.apiKeyFile, models: this.modelsCacheFile,
    } : {
      access: join(this.tokenDir, 'hosts', host, 'access-token'),
      key: join(this.tokenDir, 'hosts', host, 'api-key.json'),
      models: join(this.tokenDir, 'hosts', host, 'models.json'),
    }
  }

  /** True when a cached access token exists on disk for the active host. */
  hasAccessToken(): boolean {
    return !!this.storage.read(this.filesFor(this.activeHost).access)?.trim()
  }

  /** Clear only the active host's credentials/models, retaining selection and other hosts. */
  signOut(): void {
    this.revision++
    const files = this.filesFor(this.activeHost)
    this.storage.remove(files.access)
    this.storage.remove(files.key)
    this.storage.remove(files.models)
  }

  /** True when a cached API key exists and is not yet expired. */
  hasValidApiKey(): boolean {
    const cached = this.readApiKeyFile()
    return !!cached && cached.expires_at > this.now() / 1000
  }

  /**
   * Request a GitHub device code (step 1 of the login flow).
   * Returns the verification URI and user code to display to the caller.
   */
  async startDeviceLogin(signal?: AbortSignal, targetHost?: string): Promise<DeviceAuthorization> {
    const host = authHost(targetHost === undefined ? this.activeHost : targetHost)
    const verificationUri = copilotVerificationUri(host)
    const json = await this.fetchJson(`https://${host}/login/device/code`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ client_id: clientId(host), scope: 'read:user' }),
    }, signal)
    if (typeof json.device_code !== 'string' || !json.device_code ||
      typeof json.user_code !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(json.user_code) ||
      json.verification_uri !== verificationUri ||
      typeof json.expires_in !== 'number' || !Number.isInteger(json.expires_in) || json.expires_in <= 0 ||
      (json.interval !== undefined && (typeof json.interval !== 'number' || !Number.isInteger(json.interval) || json.interval <= 0))) {
      throw new CopilotAuthError('invalid')
    }
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri,
      host,
      expiresAt: this.now() + Math.min(json.expires_in, 3600) * 1000,
      intervalMs: Math.min((json.interval as number | undefined) ?? 5, 3600) * 1000,
    }
  }

  /**
   * Poll GitHub until the user completes device-code authorisation,
   * then verify the Copilot exchange. The caller commits only a current flow.
   */
  async completeDeviceLogin(
    device: DeviceAuthorization,
    signal?: AbortSignal,
    onInterval?: (ms: number) => void,
  ): Promise<CopilotGrant> {
    const host = authHost(device.host)
    if (device.verificationUri !== copilotVerificationUri(host)) throw new CopilotAuthError('invalid')
    let interval = device.intervalMs
    while (this.now() < device.expiresAt) {
      await this.wait(Math.min(interval, device.expiresAt - this.now()), signal)
      signal?.throwIfAborted()
      if (this.now() >= device.expiresAt) break
      const json = await this.fetchJson(`https://${host}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({
          client_id: clientId(host),
          device_code: device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      }, signal)
      if (typeof json.access_token === 'string' && json.access_token) {
        const apiKey = await this.refreshApiKey(json.access_token, host, signal)
        signal?.throwIfAborted()
        return { accessToken: json.access_token, apiKey, host }
      }
      if (json.error === 'authorization_pending') continue
      if (json.error === 'slow_down') {
        interval = Math.max(interval + 5000,
          typeof json.interval === 'number' && Number.isFinite(json.interval) && json.interval > 0
            ? json.interval * 1000 : 0)
        onInterval?.(interval)
        continue
      }
      if (json.error === 'access_denied') throw new CopilotAuthError('denied')
      if (json.error === 'expired_token') throw new CopilotAuthError('expired')
      throw new CopilotAuthError('invalid')
    }
    throw new CopilotAuthError('expired')
  }

  /** Commit credentials first, selection last. The returned undo is for setup transaction failure. */
  persistGrant(grant: CopilotGrant, signal?: AbortSignal): () => void {
    signal?.throwIfAborted()
    const host = authHost(grant.host)
    if (typeof grant.accessToken !== 'string' || !grant.accessToken.trim() ||
      !validApiKey(grant.apiKey, host) || grant.apiKey.expires_at <= this.now() / 1000) {
      throw new CopilotAuthError('invalid')
    }
    const files = this.filesFor(host)
    const previousHost = this.activeHost
    const snapshots = [files.access, files.key, files.models, this.activeHostFile]
      .map(name => [name, this.storage.read(name)] as const)
    const restore = () => {
      let failed = false
      for (const [name, value] of snapshots) {
        try {
          if (value === undefined) this.storage.remove(name)
          else this.storage.write(name, value)
        } catch { failed = true }
      }
      if (failed) throw new CopilotAuthError('storage')
    }
    try {
      this.storage.write(files.access, grant.accessToken)
      this.writeApiKeyFile(grant.apiKey, host)
      this.storage.remove(files.models)
      this.storage.write(this.activeHostFile, host)
    } catch {
      try { restore() } catch { /* Surface failure; cannot guarantee rollback on a broken disk. */ }
      throw new CopilotAuthError('storage')
    }
    this.activeHost = host
    const committedRevision = ++this.revision
    return () => {
      // Never roll a newer successful sign-in/sign-out back to an earlier account.
      if (this.revision !== committedRevision) return
      this.revision++
      this.activeHost = previousHost
      restore()
    }
  }

  /** Refresh existing credentials, never start an interactive login. */
  async getApiKey(signal?: AbortSignal, forceRefresh = false): Promise<string> {
    signal?.throwIfAborted()
    const host = this.activeHost
    const revision = this.revision
    const files = this.filesFor(host)
    const cached = this.readApiKeyFile(host)
    if (cached && cached.expires_at > this.now() / 1000 && (!forceRefresh || !this.hasAccessToken())) {
      return cached.token
    }
    const existing = this.refreshing.get(host)
    if (existing?.revision === revision) return existing.promise
    const promise = (async () => {
      const accessToken = this.storage.read(files.access)?.trim()
      if (!accessToken) throw new CopilotAuthError('missing')
      const current = () => this.revision === revision && this.activeHost === host &&
        this.storage.read(files.access)?.trim() === accessToken
      let apiKeyInfo: ApiKeyInfo
      try {
        apiKeyInfo = await this.refreshApiKey(accessToken, host, signal)
      } catch (error) {
        if (current() && error instanceof CopilotAuthError && error.code === 'denied') {
          this.storage.remove(files.key)
        }
        throw error
      }
      signal?.throwIfAborted()
      if (!current()) throw new CopilotAuthError('cancelled')
      this.writeApiKeyFile(apiKeyInfo, host)
      return apiKeyInfo.token
    })()
    this.refreshing.set(host, { revision, promise })
    try { return await promise } finally {
      if (this.refreshing.get(host)?.promise === promise) this.refreshing.delete(host)
    }
  }

  /** Validated API origin for the active host. */
  getApiBase(): string {
    return this.readApiKeyFile()?.endpoints?.api ?? defaultApiBase(this.activeHost)
  }

  private async refreshApiKey(accessToken: string, host: string, signal?: AbortSignal): Promise<ApiKeyInfo> {
    // Official VS Code CAPI client derives api.<enterprise-host>, not GHES /api/v3.
    const json = await this.fetchJson(`https://api.${host}/copilot_internal/v2/token`, {
      headers: {
        accept: 'application/json',
        authorization: `token ${accessToken}`,
        'editor-version': EDITOR_VERSION,
        'editor-plugin-version': PLUGIN_VERSION,
        'user-agent': USER_AGENT,
      },
    }, signal)
    const info = validApiKey(json, host)
    if (!info || info.expires_at <= this.now() / 1000) throw new CopilotAuthError('invalid')
    return info
  }

  private async fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(30_000)
      const res = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (res.status === 401 || res.status === 403) throw new CopilotAuthError('denied')
      if (!res.ok) throw new CopilotAuthError('network')
      try { return record(await res.json()) } catch (error) {
        if (error instanceof CopilotAuthError) throw error
        throw new CopilotAuthError('invalid')
      }
    } catch (error) {
      if (signal?.aborted) throw new CopilotAuthError('cancelled')
      if (error instanceof CopilotAuthError) throw error
      throw new CopilotAuthError(providerFailureKind(error) === 'proxy' ? 'proxy' : 'network')
    }
  }

  /** Invalidate cached API key so the next call forces a refresh. */
  clearApiKey(): void {
    this.storage.remove(this.filesFor(this.activeHost).key)
  }

  private readApiKeyFile(host = this.activeHost): ApiKeyInfo | null {
    const raw = this.storage.read(this.filesFor(host).key)
    if (!raw) return null
    try { return validApiKey(JSON.parse(raw), host) } catch { return null }
  }

  private writeApiKeyFile(info: ApiKeyInfo, host: string): void {
    this.storage.write(this.filesFor(host).key, JSON.stringify(info))
  }

  // ---- supported-models cache ---------------------------------------------

  /** Read the persisted list of supported Copilot model IDs, if any. */
  readModelsCache(): ModelsCache | null {
    try {
      const raw = this.storage.read(this.filesFor(this.activeHost).models)
      if (!raw) return null
      const parsed = JSON.parse(raw) as ModelsCache
      if (!Array.isArray(parsed.models) || !parsed.models.every(validModelInfo) ||
        !Number.isFinite(parsed.fetchedAt)) return null
      return parsed
    } catch {
      return null
    }
  }

  /** Persist the list of supported Copilot models for offline fallback. */
  writeModelsCache(models: ModelInfo[]): void {
    try {
      this.storage.write(
        this.filesFor(this.activeHost).models,
        JSON.stringify({ models, fetchedAt: this.now() }, null, 2),
      )
    } catch { /* Model metadata is an optional cache, unlike credentials. */ }
  }
}

// ---------------------------------------------------------------------------
//  CopilotProvider
// ---------------------------------------------------------------------------

/**
 * GitHub Copilot LLM provider.
 *
 * Uses the Copilot internal API (OpenAI-compatible) at
 * `api.githubcopilot.com`. Explicit provider onboarding obtains locally
 * persisted OAuth credentials; normal API requests only refresh existing ones.
 */
export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot'

  readonly auth: CopilotAuthenticator

  /** Cache of dynamically-fetched model metadata and the time it was fetched. */
  private _modelsCache: ModelInfo[] | null = null
  private _modelsCacheTime = 0
  /** Known model IDs (from the /models API or the on-disk cache) for `resolveModel`. */
  private _knownModels = new Set<string>()
  private _modelsRevision: number

  constructor(auth = new CopilotAuthenticator()) {
    this.auth = auth
    this._modelsRevision = auth.getRevision()
    // Seed known models from the on-disk cache so model validation works
    // before the first successful /models fetch (e.g. an offline start-up).
    const cached = this.auth.readModelsCache()
    if (cached) for (const m of cached.models) this._knownModels.add(m.id)
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse> {
    options.signal?.throwIfAborted()
    const revision = this.auth.getRevision()
    this.syncModelsRevision()
    const model = this.resolveModel(options.model)
    const info = (await this.fetchModels(options.signal)).find((item) => item.id === model)
    this.assertRevision(revision)
    const endpoint = copilotModelEndpoint(info)
    if (info?.supportedEndpoints === undefined) {
      console.warn(`[copilot] No endpoint capabilities for "${model}"; using the legacy chat-completions protocol.`)
    }
    const effort = options.thinking?.type === 'disabled' ? 'none' : options.reasoningEffort
    if ((endpoint === '/responses' || effort === 'none') && effort && info?.reasoningEfforts &&
      !info.reasoningEfforts.includes(effort)) {
      throw copilotModelError('unsupported_reasoning_effort', model,
        `This model does not support reasoning effort "${effort}". Choose a supported effort or model.`)
    }
    if (info?.vision === false && messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
      throw new Error(`[copilot] Model "${model}" does not accept image input. Choose a vision-capable model; images were not discarded.`)
    }
    const inlinedMessages = await inlineExternalImages(messages, options.signal)
    this.assertRevision(revision)
    // Retry once on 401 — the cached API key may have expired server-side
    // before the local expires_at check fires.
    for (let attempt = 0; attempt < 2; attempt++) {
      const apiKey = await this.auth.getApiKey(options.signal)
      this.assertRevision(revision)
      const baseURL = this.auth.getApiBase().replace(/\/+$/, '')

      try {
        const request = {
          url: `${baseURL}${endpoint}`,
          apiKey,
          headers: copilotHeaders(),
          model,
          messages: inlinedMessages,
          tools,
          maxTokens: options.maxTokens,
          thinking: options.thinking,
          reasoningEffort: options.reasoningEffort,
          providerName: 'copilot',
          signal: options.signal,
        }
        const result = endpoint === '/responses'
          ? await openaiResponses(request)
          : await openaiChat({ ...request, temperature: options.temperature ?? 0.7 })
        if (result.usage) result.usage = estimateUsageCost(this.name, result.model ?? model, result.usage)
        return result
      } catch (err) {
        this.assertRevision(revision)
        const is401 = err instanceof ProviderHttpError && err.status === 401
        if (is401 && attempt === 0) {
          console.warn(
            '[copilot] API key expired (401), clearing cache and retrying...',
          )
          this.auth.clearApiKey()
          continue
        }
        if (err instanceof ProviderHttpError && err.status === 400
          && (err.code === 'model_not_supported' || err.code === 'unsupported_api_for_model')) {
          this._modelsCache = null
          this._modelsCacheTime = 0
          throw copilotModelError(err.code, model, err.code === 'model_not_supported'
            ? `Copilot rejected this model at ${endpoint}. Check the exact model ID and this account's model access; this is not proof of a configuration typo.`
            : `Copilot rejected ${endpoint} for this model. Its advertised endpoint capabilities may have changed.`)
        }
        throw err
      }
    }
    // Unreachable, but satisfies the type-checker
    throw new Error('[copilot] chat failed after retry')
  }

  async listModels(): Promise<string[]> {
    return (await this.listModelInfos()).map((m) => m.id)
  }

  async listModelInfos(): Promise<ModelInfo[]> {
    const revision = this.auth.getRevision()
    const infos = await this.fetchModels()
    this.assertRevision(revision)
    return infos.filter((m) => m.selectable !== false)
  }

  private assertRevision(revision: number): void {
    if (this.auth.getRevision() !== revision) throw new CopilotAuthError('cancelled')
  }

  private syncModelsRevision(): void {
    const revision = this.auth.getRevision()
    if (revision === this._modelsRevision) return
    this._modelsRevision = revision
    this._modelsCache = null
    this._modelsCacheTime = 0
    this._knownModels.clear()
    for (const m of this.auth.readModelsCache()?.models ?? []) this._knownModels.add(m.id)
  }

  // --------------------------------------------------------------------------

  /**
   * Dynamically fetch the list of models (with metadata) the authenticated
   * Copilot account is entitled to from `GET {api}/models`. Results are cached
   * in-memory for 5 minutes and persisted to disk. Falls back to the on-disk
   * cache on any failure (e.g. offline or rate-limited).
   */
  @Span('CopilotProvider.fetchModels')
  private async fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    signal?.throwIfAborted()
    const revision = this.auth.getRevision()
    this.syncModelsRevision()
    const CACHE_TTL = 5 * 60_000 // 5 minutes
    if (this._modelsCache && Date.now() - this._modelsCacheTime < CACHE_TTL) {
      return this._modelsCache
    }
    try {
      const apiKey = await this.auth.getApiKey(signal)
      this.assertRevision(revision)
      const baseURL = this.auth.getApiBase().replace(/\/+$/, '')
      const res = await fetch(`${baseURL}/models`, {
        signal,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...copilotHeaders(),
        },
      })
      this.assertRevision(revision)
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) this.auth.clearApiKey()
        console.warn(
          `[copilot] /models returned ${res.status}, falling back to cached list`,
        )
        return this.cachedModels()
      }
      const json = (await res.json()) as { data?: CopilotModelInfo[] }
      this.assertRevision(revision)
      if (!Array.isArray(json.data)) throw new Error('Copilot returned an invalid model list')
      const data = json.data ?? []
      // Keep routing capabilities even for models no longer shown in the picker.
      const byId = new Map<string, ModelInfo>()
      for (const m of data) {
        if (
          !m || typeof m.id !== 'string' || !m.id ||
          (m.capabilities?.type ?? 'chat') !== 'chat'
        ) continue
        if ((m.supported_endpoints !== undefined && !stringList(m.supported_endpoints)) ||
          (m.capabilities?.supports?.reasoning_effort !== undefined &&
            !stringList(m.capabilities.supports.reasoning_effort))) {
          throw new Error(`Copilot returned invalid endpoint capabilities for model "${m.id}"`)
        }
        if (byId.has(m.id)) continue
        byId.set(m.id, {
          id: m.id,
          name: m.name,
          ...(m.model_picker_enabled === false ? { selectable: false } : {}),
          vision: m.capabilities?.supports?.vision ?? false,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens,
          ...(m.supported_endpoints === undefined ? {} : { supportedEndpoints: [...m.supported_endpoints] }),
          ...(m.capabilities?.supports?.reasoning_effort === undefined ? {} : {
            reasoningEfforts: [...m.capabilities.supports.reasoning_effort],
          }),
        })
      }
      const infos = Array.from(byId.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
      )
      if (infos.length === 0) return this.cachedModels()
      this._modelsCache = infos
      this._modelsCacheTime = Date.now()
      for (const m of infos) this._knownModels.add(m.id)
      // Persist so a later offline/failed fetch can still list models.
      this.auth.writeModelsCache(infos)
      return infos
    } catch (err) {
      this.assertRevision(revision)
      if (signal?.aborted) throw signal.reason
      console.warn(
        `[copilot] Failed to fetch /models: ${
          err instanceof Error ? err.message : err
        }`,
      )
      return this.cachedModels()
    }
  }

  /** Last-known models persisted on disk, used as an offline fallback. */
  private cachedModels(): ModelInfo[] {
    const cached = this.auth.readModelsCache()
    if (!cached || cached.models.length === 0) return []
    for (const m of cached.models) this._knownModels.add(m.id)
    return cached.models
  }

  private resolveModel(model?: string): string {
    if (!model) return DEFAULT_COPILOT_MODEL
    if (this._knownModels.has(model)) return model
    // Unknown to our cache — trust the caller (they may have picked a freshly
    // listed model) and let the Copilot API validate it.
    console.warn(
      `[copilot] Model '${model}' not in known list; passing through to API.`,
    )
    return model
  }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Walk all messages and replace external image URLs (`https://...`) with
 * base64-encoded data URIs so Copilot can render them without network access.
 */
async function inlineExternalImages(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (!Array.isArray(msg.content)) return msg
      const parts = await Promise.all(
        (msg.content as ContentPart[]).map(async (part) => {
          if (
            part.type !== 'image_url' ||
            !part.image_url.url.startsWith('http')
          ) {
            return part
          }
          try {
            const res = await fetch(part.image_url.url, { signal })
            if (!res.ok) {
              console.warn(
                `[copilot] Failed to fetch image ${part.image_url.url}: ${res.status}`,
              )
              return part
            }
            const contentType = res.headers.get('content-type') ?? 'image/jpeg'
            const buffer = await res.arrayBuffer()
            const b64 = btoa(
              String.fromCharCode(...new Uint8Array(buffer)),
            )
            return {
              ...part,
              image_url: {
                ...part.image_url,
                url: `data:${contentType};base64,${b64}`,
              },
            } satisfies ContentPart
          } catch (e) {
            if (signal?.aborted) throw signal.reason
            console.warn(
              `[copilot] Could not inline image ${part.image_url.url}:`,
              e,
            )
            return part
          }
        }),
      )
      return { ...msg, content: parts }
    }),
  )
}

function copilotHeaders(): Record<string, string> {
  return {
    'copilot-integration-id': 'vscode-chat',
    'editor-version': EDITOR_VERSION,
    'editor-plugin-version': PLUGIN_VERSION,
    'user-agent': USER_AGENT,
    'openai-intent': 'conversation-panel',
    'x-github-api-version': API_VERSION,
  }
}
