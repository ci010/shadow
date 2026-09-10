import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { env } from 'node:process'
import type { ToolDefinition } from '../tools/tool.ts'
import { openaiChat } from './openai-compatible.ts'
import type {
  ChatMessage,
  ContentPart,
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  ModelInfo,
} from './provider.ts'
import { Span } from '../utils/otel.ts'

// ---------------------------------------------------------------------------
//  Constants (matches litellm / VS Code Copilot extension)
// ---------------------------------------------------------------------------

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API_KEY_URL = 'https://api.github.com/copilot_internal/v2/token'
const GITHUB_COPILOT_API_BASE = 'https://api.githubcopilot.com'

const COPILOT_VERSION = '0.26.0'
const VSCODE_VERSION = '1.95.0'
const API_VERSION = '2025-04-01'
const EDITOR_VERSION = `vscode/${VSCODE_VERSION}`
const PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

/** Model used when a request does not specify one. */
const DEFAULT_COPILOT_MODEL = 'claude-sonnet-4.6'

/** Shape of a single entry in the Copilot `GET /models` response. */
interface CopilotModelInfo {
  id: string
  name?: string
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
    }
  }
}

/** Persisted shape of the on-disk Copilot model cache. */
interface ModelsCache {
  models: ModelInfo[]
  fetchedAt: number
}

const POLL_INTERVAL_MS = 5_000
const MAX_POLL_ATTEMPTS = 60 // 5 min

// ---------------------------------------------------------------------------
//  Copilot Authenticator – OAuth Device Code Flow
// ---------------------------------------------------------------------------

interface ApiKeyInfo {
  token: string
  expires_at: number
  endpoints?: { api?: string }
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

  constructor(tokenDir?: string) {
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
    mkdirSync(this.tokenDir, { recursive: true })
  }

  // ---- public API ---------------------------------------------------------

  /** True when a cached access token exists on disk. */
  hasAccessToken(): boolean {
    try {
      const t = readFileSync(this.accessTokenFile, 'utf8').trim()
      return !!t
    } catch {
      return false
    }
  }

  /** True when a cached API key exists and is not yet expired. */
  hasValidApiKey(): boolean {
    const cached = this.readApiKeyFile()
    return !!cached && cached.expires_at > Date.now() / 1000
  }

  /**
   * Request a GitHub device code (step 1 of the login flow).
   * Returns the verification URI and user code to display to the caller.
   */
  async startDeviceLogin(): Promise<{
    device_code: string
    user_code: string
    verification_uri: string
  }> {
    return this.requestDeviceCode()
  }

  /**
   * Poll GitHub until the user completes device-code authorisation,
   * then persist the access token. Resolves with `true` on success.
   */
  async completeDeviceLogin(deviceCode: string): Promise<boolean> {
    try {
      const token = await this.pollForAccessToken(deviceCode)
      try {
        writeFileSync(this.accessTokenFile, token)
      } catch (e) {
        console.warn('[copilot] Could not persist access token', e)
      }
      // Also refresh the API key immediately so it's ready for chat()
      const apiKeyInfo = await this.refreshApiKey(token)
      this.writeApiKeyFile(apiKeyInfo)
      return true
    } catch {
      return false
    }
  }

  /**
   * Return a valid Bearer token for the Copilot chat API.
   * Transparently handles login + refresh.
   */
  async getApiKey(): Promise<string> {
    // 1. Try cached API key (not expired)
    const cached = this.readApiKeyFile()
    if (cached && cached.expires_at > Date.now() / 1000) {
      return cached.token
    }

    // 2. Refresh using our access token
    const accessToken = await this.getAccessToken()
    const apiKeyInfo = await this.refreshApiKey(accessToken)
    this.writeApiKeyFile(apiKeyInfo)
    return apiKeyInfo.token
  }

  /**
   * Return API base from the cached api-key response, falling back to default.
   */
  getApiBase(): string {
    const cached = this.readApiKeyFile()
    return cached?.endpoints?.api ?? GITHUB_COPILOT_API_BASE
  }

  // ---- access-token (device code -> GitHub PAT-ish token) -----------------

  @Span('CopilotAuthenticator.getAccessToken')
  private async getAccessToken(): Promise<string> {
    // Persisted?
    try {
      const token = readFileSync(this.accessTokenFile, 'utf8').trim()
      if (token) return token
    } catch { /* first run */ }

    // Interactive device-code login
    const token = await this.loginDeviceCode()
    try {
      writeFileSync(this.accessTokenFile, token)
    } catch (e) {
      console.warn('[copilot] Could not persist access token', e)
    }
    return token
  }

  @Span('CopilotAuthenticator.loginDeviceCode')
  private async loginDeviceCode(): Promise<string> {
    const deviceCode = await this.requestDeviceCode()

    // Inform user
    console.info(
      `[copilot] GitHub Copilot: visit ${deviceCode.verification_uri} and enter code ${deviceCode.user_code}`,
    )
    // Also print to stdout so it's always visible
    console.log(
      `\n╔══════════════════════════════════════════════════════╗\n` +
        `║  GitHub Copilot Authentication                      ║\n` +
        `║                                                     ║\n` +
        `║  Visit: ${deviceCode.verification_uri.padEnd(38)}     ║\n` +
        `║  Code:  ${deviceCode.user_code.padEnd(38)}     ║\n` +
        `╚══════════════════════════════════════════════════════╝\n`,
    )

    return this.pollForAccessToken(deviceCode.device_code)
  }

  @Span('CopilotAuthenticator.requestDeviceCode')
  private async requestDeviceCode(): Promise<{
    device_code: string
    user_code: string
    verification_uri: string
  }> {
    const res = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'read:user',
      }),
    })
    if (!res.ok) {
      throw new Error(
        `Device code request failed: ${res.status} ${await res.text()}`,
      )
    }
    const json = (await res.json()) as Record<string, string>
    if (!json.device_code || !json.user_code || !json.verification_uri) {
      throw new Error(
        `Device code response missing fields: ${JSON.stringify(json)}`,
      )
    }
    return json as {
      device_code: string
      user_code: string
      verification_uri: string
    }
  }

  @Span('CopilotAuthenticator.pollForAccessToken')
  private async pollForAccessToken(deviceCode: string): Promise<string> {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS)

      const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })

      if (!res.ok) {
        // 403/404 means user hasn't authorised yet
        if (res.status === 403 || res.status === 404) continue
        throw new Error(`Access token poll failed: ${res.status}`)
      }

      const json = (await res.json()) as Record<string, string>
      if (json.access_token) {
        console.info('[copilot] GitHub Copilot: authentication successful')
        return json.access_token
      }
      if (json.error === 'authorization_pending') continue
      if (json.error === 'slow_down') {
        await sleep(POLL_INTERVAL_MS) // extra wait
        continue
      }
      if (json.error) {
        throw new Error(
          `OAuth error: ${json.error} – ${json.error_description ?? ''}`,
        )
      }
    }
    throw new Error('Timed out waiting for device authorisation')
  }

  // ---- API key (copilot internal token) -----------------------------------

  private async refreshApiKey(accessToken: string): Promise<ApiKeyInfo> {
    const res = await fetch(GITHUB_API_KEY_URL, {
      headers: {
        accept: 'application/json',
        authorization: `token ${accessToken}`,
        'editor-version': EDITOR_VERSION,
        'editor-plugin-version': PLUGIN_VERSION,
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      // If 401, the access token may be revoked – purge it so next call re-logins
      if (res.status === 401) {
        try {
          rmSync(this.accessTokenFile)
        } catch { /* noop */ }
      }
      throw new Error(
        `Copilot API key refresh failed: ${res.status} ${await res.text()}`,
      )
    }
    const json = (await res.json()) as ApiKeyInfo
    if (!json.token) {
      throw new Error(
        `API key response missing token: ${JSON.stringify(json)}`,
      )
    }
    return json
  }

  /** Invalidate cached API key so the next call forces a refresh. */
  clearApiKey(): void {
    try {
      rmSync(this.apiKeyFile)
    } catch { /* already gone */ }
  }

  private readApiKeyFile(): ApiKeyInfo | null {
    try {
      const raw = readFileSync(this.apiKeyFile, 'utf8')
      return JSON.parse(raw) as ApiKeyInfo
    } catch {
      return null
    }
  }

  private writeApiKeyFile(info: ApiKeyInfo): void {
    try {
      writeFileSync(this.apiKeyFile, JSON.stringify(info, null, 2))
    } catch (e) {
      console.warn('[copilot] Could not persist API key', e)
    }
  }

  // ---- supported-models cache ---------------------------------------------

  /** Read the persisted list of supported Copilot model IDs, if any. */
  readModelsCache(): ModelsCache | null {
    try {
      const raw = readFileSync(this.modelsCacheFile, 'utf8')
      const parsed = JSON.parse(raw) as ModelsCache
      if (!Array.isArray(parsed.models)) return null
      return parsed
    } catch {
      return null
    }
  }

  /** Persist the list of supported Copilot models for offline fallback. */
  writeModelsCache(models: ModelInfo[]): void {
    try {
      writeFileSync(
        this.modelsCacheFile,
        JSON.stringify({ models, fetchedAt: Date.now() }, null, 2),
      )
    } catch (e) {
      console.warn('[copilot] Could not persist models cache', e)
    }
  }
}

// ---------------------------------------------------------------------------
//  CopilotProvider
// ---------------------------------------------------------------------------

/**
 * GitHub Copilot LLM provider.
 *
 * Uses the Copilot internal API (OpenAI-compatible) at
 * `api.githubcopilot.com`. Authentication is handled automatically via
 * OAuth device-code flow on first use; tokens are persisted locally.
 */
export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot'

  readonly auth: CopilotAuthenticator

  /** Cache of dynamically-fetched model metadata and the time it was fetched. */
  private _modelsCache: ModelInfo[] | null = null
  private _modelsCacheTime = 0
  /** Known model IDs (from the /models API or the on-disk cache) for `resolveModel`. */
  private _knownModels = new Set<string>()

  constructor() {
    this.auth = new CopilotAuthenticator()
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
    // Retry once on 401 — the cached API key may have expired server-side
    // before the local expires_at check fires.
    for (let attempt = 0; attempt < 2; attempt++) {
      const apiKey = await this.auth.getApiKey()
      const baseURL = this.auth.getApiBase().replace(/\/+$/, '')

      // Copilot does not accept external image URLs – inline them as base64.
      const inlinedMessages = await inlineExternalImages(messages)

      try {
        return await openaiChat({
          url: `${baseURL}/chat/completions`,
          apiKey,
          headers: copilotHeaders(),
          model: this.resolveModel(options.model),
          messages: inlinedMessages,
          tools,
          maxTokens: options.maxTokens,
          temperature: options.temperature ?? 0.7,
          thinking: options.thinking,
          reasoningEffort: options.reasoningEffort,
          providerName: 'copilot',
          signal: options.signal,
        })
      } catch (err) {
        const is401 = err instanceof Error && /\b401\b/.test(err.message)
        if (is401 && attempt === 0) {
          console.warn(
            '[copilot] API key expired (401), clearing cache and retrying...',
          )
          this.auth.clearApiKey()
          continue
        }
        throw err
      }
    }
    // Unreachable, but satisfies the type-checker
    throw new Error('[copilot] chat failed after retry')
  }

  async listModels(): Promise<string[]> {
    return (await this.fetchModels()).map((m) => m.id)
  }

  listModelInfos(): Promise<ModelInfo[]> {
    return this.fetchModels()
  }

  // --------------------------------------------------------------------------

  /**
   * Dynamically fetch the list of models (with metadata) the authenticated
   * Copilot account is entitled to from `GET {api}/models`. Results are cached
   * in-memory for 5 minutes and persisted to disk. Falls back to the on-disk
   * cache on any failure (e.g. offline or rate-limited).
   */
  @Span('CopilotProvider.fetchModels')
  private async fetchModels(): Promise<ModelInfo[]> {
    const CACHE_TTL = 5 * 60_000 // 5 minutes
    if (this._modelsCache && Date.now() - this._modelsCacheTime < CACHE_TTL) {
      return this._modelsCache
    }
    try {
      const apiKey = await this.auth.getApiKey()
      const baseURL = this.auth.getApiBase().replace(/\/+$/, '')
      const res = await fetch(`${baseURL}/models`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...copilotHeaders(),
        },
      })
      if (!res.ok) {
        console.warn(
          `[copilot] /models returned ${res.status}, falling back to cached list`,
        )
        return this.cachedModels()
      }
      const json = (await res.json()) as { data?: CopilotModelInfo[] }
      const data = json.data ?? []
      // Keep user-selectable chat models only, then dedupe by id + sort.
      const byId = new Map<string, ModelInfo>()
      for (const m of data) {
        if (
          !m.id ||
          m.model_picker_enabled === false ||
          (m.capabilities?.type ?? 'chat') !== 'chat'
        ) continue
        if (byId.has(m.id)) continue
        byId.set(m.id, {
          id: m.id,
          name: m.name,
          vision: m.capabilities?.supports?.vision ?? false,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens,
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
            const res = await fetch(part.image_url.url)
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
