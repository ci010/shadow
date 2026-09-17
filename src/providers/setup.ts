import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import { ConfigStore, REDACTED_SECRET } from '../config/store.ts'
import { ConfigSchema, type Config } from '../config/schema.ts'
import { DEFAULT_COPILOT_MODEL } from '../config/defaults.ts'
import { parseModelSpec } from './aggregated.ts'
import { detectProvider, knownProviderNames, resolveProviderSettings } from './factory.ts'
import {
  CopilotAuthenticator,
  CopilotAuthError,
  type CopilotGrant,
  type DeviceAuthorization,
} from './copilot.ts'

export interface ProviderSetupStatus {
  provider: string
  model: string
  authMode: 'api-key' | 'copilot' | 'none'
  ready: boolean
  reason?: string
  baseUrl?: string
  hasApiKey: boolean
}

export interface ConfiguredProvider {
  provider: string
  authMode: 'api-key' | 'copilot' | 'none'
  hasApiKey: boolean
  selected: boolean
  baseUrl?: string
  model?: string
}

type LoginState = 'pending' | 'succeeded' | 'denied' | 'expired' | 'cancelled' | 'error'
export interface LoginStatus {
  loginId: string
  state: LoginState
  message?: string
  userCode?: string
  verificationUri?: string
  expiresAt?: number
  intervalMs?: number
}

const ProviderName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const Model = z.string().trim().min(1).max(256).refine((value) => !/[\s\x00-\x1f]/.test(value))
const AttemptId = z.string().uuid()
const SetupInput = z.object({
  provider: ProviderName,
  model: Model,
  apiKey: z.string().trim().max(16_384).refine((value) => value !== REDACTED_SECRET && !/[\r\n\x00]/.test(value)).optional(),
  baseUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return true
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch { return false }
  }).optional(),
}).strict().refine(({ model, provider }) => {
  const spec = parseModelSpec(model)
  return !spec.provider || spec.provider === provider
})
const LoginInput = z.object({ model: Model.optional(), attemptId: AttemptId.optional() }).strict()
type SetupInput = z.infer<typeof SetupInput>

interface Flow {
  status: LoginStatus
  model: string
  config?: Config
  createdAt: number
  retainUntil: number
  controller: AbortController
  started: Promise<LoginStatus & Partial<ProviderSetupStatus>>
  done?: Promise<void>
}

interface SetupOptions {
  getConfig: () => Config
  store: ConfigStore
  auth?: CopilotAuthenticator
  fetch?: typeof fetch
  now?: () => number
}

const LOGIN_STATUS_TTL_MS = 10 * 60_000

function selectedModel(input: SetupInput): string {
  return `${parseModelSpec(input.model).model}@${input.provider}`
}

function changeSelection(raw: Record<string, unknown>, input: SetupInput): Record<string, unknown> {
  const providers = { ...(raw.providers as Record<string, Record<string, unknown>> ?? {}) }
  const provider = { ...providers[input.provider] }
  if (input.apiKey !== undefined) provider.apiKey = input.apiKey
  if (input.baseUrl !== undefined) {
    if (input.baseUrl) provider.baseUrl = input.baseUrl
    else delete provider.baseUrl
  }
  providers[input.provider] = provider
  return {
    ...raw,
    providers,
    agent: { ...(raw.agent as Record<string, unknown> ?? {}), model: selectedModel(input) },
  }
}

function safeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
    return baseUrl
  } catch { return undefined }
}

/** Provider-owned authentication lifecycle, independent of any chat channel. */
export class ProviderSetup {
  private readonly auth: CopilotAuthenticator
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly flows = new Map<string, Flow>()
  private active?: Flow
  private readonly shutdown = new AbortController()
  private readonly cleanupTimer: ReturnType<typeof setInterval>
  private readiness?: { config: Config; until: number; value: Promise<ProviderSetupStatus> }

  constructor(private readonly options: SetupOptions) {
    this.auth = options.auth ?? new CopilotAuthenticator()
    this.request = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.cleanupTimer = setInterval(() => this.prune(), 30_000)
    this.cleanupTimer.unref()
  }

  invalidate(): void {
    this.readiness = undefined
  }

  configured(): ConfiguredProvider[] {
    const config = this.options.getConfig()
    const spec = parseModelSpec(config.agent.model)
    const selected = spec.provider ?? detectProvider(spec.model)
    const names = new Set([...Object.keys(config.providers), ...knownProviderNames(), selected])
    const cachedCopilot = this.auth.hasAccessToken() || this.auth.hasValidApiKey()
    const providers: ConfiguredProvider[] = []
    for (const provider of names) {
      const entry = config.providers[provider]
      const settings = resolveProviderSettings(config, provider)
      const explicit = entry && (provider === 'copilot' || entry.apiKey?.trim() ||
        entry.baseUrl?.trim() || entry.quickModel?.trim() ||
        Object.keys(entry.modelContextWindows ?? {}).length > 0)
      if (!explicit && !settings.apiKey.trim() && !(provider === 'copilot' && cachedCopilot)) continue
      const baseUrl = safeBaseUrl(settings.baseUrl)
      providers.push({
        provider,
        authMode: settings.authMode,
        hasApiKey: !!settings.apiKey,
        selected: provider === selected,
        ...(baseUrl ? { baseUrl } : {}),
        ...(provider === selected ? { model: config.agent.model } : {}),
      })
    }
    return providers.sort((a, b) => Number(b.selected) - Number(a.selected) || a.provider.localeCompare(b.provider))
  }

  async status(refresh = false): Promise<ProviderSetupStatus> {
    const config = this.options.getConfig()
    if (!refresh && this.readiness?.config === config && this.readiness.until > this.now()) return this.readiness.value
    const value = this.check(config, this.shutdown.signal, refresh)
    this.readiness = { config, until: this.now() + 30_000, value }
    return value
  }

  private async check(config: Config, signal = this.shutdown.signal, refresh = false): Promise<ProviderSetupStatus> {
    const spec = parseModelSpec(config.agent.model)
    const provider = spec.provider ?? detectProvider(spec.model)
    const settings = resolveProviderSettings(config, provider)
    const status: ProviderSetupStatus = {
      provider,
      model: config.agent.model,
      authMode: settings.authMode,
      ready: false,
      baseUrl: safeBaseUrl(settings.baseUrl),
      hasApiKey: !!settings.apiKey,
    }
    if (settings.authMode === 'copilot') {
      try {
        await this.auth.getApiKey(signal, refresh)
        status.ready = true
      } catch (error) {
        const code = error instanceof CopilotAuthError ? error.code : 'network'
        status.reason = code === 'missing' ? 'missing_credentials'
          : code === 'denied' ? 'invalid_credentials'
          : code === 'network' ? 'network_error'
          : `${code}_error`
      }
      return status
    }
    if (!status.baseUrl) return { ...status, reason: 'missing_base_url' }
    if (!settings.apiKey && settings.authMode === 'api-key') return { ...status, reason: 'missing_credentials' }
    if (settings.authMode === 'none') return { ...status, ready: true }
    try {
      const headers: Record<string, string> = provider === 'anthropic'
        ? { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${settings.apiKey}` }
      const response = await this.request(`${status.baseUrl.replace(/\/+$/, '')}/models`, {
        headers, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) return { ...status, reason: 'invalid_credentials' }
      if (!response.ok && response.status !== 404 && response.status !== 405) return { ...status, reason: 'network_error' }
      return { ...status, ready: true }
    } catch {
      return { ...status, reason: signal.aborted ? 'cancelled_error' : 'network_error' }
    }
  }

  async save(input: SetupInput, signal?: AbortSignal): Promise<ProviderSetupStatus> {
    this.cancelActive()
    const raw = changeSelection(await this.options.store.read(), input)
    const candidate = ConfigSchema.parse(raw)
    const active = this.options.getConfig()
    if (candidate.providers[input.provider].apiKey === undefined) {
      candidate.providers[input.provider].apiKey = active.providers[input.provider]?.apiKey
    }
    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
    const status = await this.check(candidate, combined)
    if (!status.ready) return status
    await this.options.store.update((current) => changeSelection(current, input), combined)
    this.invalidate()
    return status
  }

  start(model?: string, attemptId: string = randomUUID(), requestSignal?: AbortSignal): Promise<LoginStatus & Partial<ProviderSetupStatus>> {
    this.prune()
    const known = this.flows.get(attemptId)
    if (known) return known.status.state === 'pending' ? known.started : Promise.resolve({ ...known.status })
    if (this.shutdown.signal.aborted) return Promise.reject(new CopilotAuthError('cancelled'))
    // Bound retained statuses/tombstones rather than letting clients grow them forever.
    if (this.flows.size >= 128) return Promise.reject(new Error('Too many sign-in attempts. Restart the application.'))
    if (this.active?.status.state === 'pending') {
      this.flows.set(attemptId, this.active)
      return this.active.started
    }
    const current = parseModelSpec(this.options.getConfig().agent.model)
    const requested = model ? parseModelSpec(model) : undefined
    if (requested?.provider && requested.provider !== 'copilot') return Promise.reject(new Error('Select a Copilot model.'))
    const flow: Flow = {
      status: { loginId: attemptId, state: 'pending' },
      model: `${requested?.model ?? ((current.provider ?? detectProvider(current.model)) === 'copilot' ? current.model : DEFAULT_COPILOT_MODEL)}@copilot`,
      controller: new AbortController(),
      config: this.options.getConfig(),
      createdAt: this.now(),
      retainUntil: this.now() + LOGIN_STATUS_TTL_MS,
      started: Promise.resolve({ loginId: attemptId, state: 'pending' }),
    }
    this.flows.set(attemptId, flow)
    this.active = flow
    const onAborted = () => this.cancel(attemptId)
    requestSignal?.addEventListener('abort', onAborted, { once: true })
    if (requestSignal?.aborted) onAborted()
    flow.started = this.begin(flow).finally(() => requestSignal?.removeEventListener('abort', onAborted))
    return flow.started
  }

  private async begin(flow: Flow): Promise<LoginStatus & Partial<ProviderSetupStatus>> {
    const signal = flow.controller.signal
    try {
      signal.throwIfAborted()
      try {
        await this.auth.getApiKey(signal, true)
        const status = await this.commit(flow)
        this.finish(flow, { loginId: flow.status.loginId, state: 'succeeded' })
        return { ...flow.status, ...status }
      } catch (error) {
        if (!(error instanceof CopilotAuthError) || !['missing', 'denied'].includes(error.code)) throw error
      }
      const device = await this.auth.startDeviceLogin(signal)
      signal.throwIfAborted()
      flow.status = {
        ...flow.status,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresAt: device.expiresAt,
        intervalMs: device.intervalMs,
      }
      flow.done = this.poll(flow, device)
      return { ...flow.status }
    } catch (error) {
      this.fail(flow, error)
      return { ...flow.status }
    }
  }

  private async poll(flow: Flow, device: DeviceAuthorization): Promise<void> {
    const expiration = AbortSignal.timeout(Math.max(1, Math.ceil(device.expiresAt - this.now())))
    const signal = AbortSignal.any([flow.controller.signal, expiration])
    try {
      const grant = await this.auth.completeDeviceLogin(device, signal, (ms) => { flow.status.intervalMs = ms })
      signal.throwIfAborted()
      await this.commit(flow, grant, signal)
      this.finish(flow, { loginId: flow.status.loginId, state: 'succeeded' })
    } catch (error) {
      this.fail(flow, expiration.aborted && !flow.controller.signal.aborted ? new CopilotAuthError('expired') : error)
    }
  }

  private async commit(flow: Flow, grant?: CopilotGrant, signal = flow.controller.signal): Promise<ProviderSetupStatus> {
    const input = { provider: 'copilot', model: flow.model }
    await this.options.store.update((raw) => {
      signal.throwIfAborted()
      if (flow.config !== this.options.getConfig()) throw new CopilotAuthError('cancelled')
      if (grant) this.auth.persistGrant(grant, signal)
      return changeSelection(raw, input)
    }, signal)
    this.invalidate()
    return { provider: 'copilot', model: flow.model, authMode: 'copilot', ready: true, hasApiKey: false }
  }

  private fail(flow: Flow, error: unknown): void {
    if (flow.status.state === 'expired') return
    const code = error instanceof CopilotAuthError ? error.code : undefined
    const state: LoginState = flow.controller.signal.aborted || code === 'cancelled' ? 'cancelled'
      : code === 'denied' || code === 'expired' ? code : 'error'
    this.finish(flow, {
      loginId: flow.status.loginId, state,
      message: error instanceof CopilotAuthError ? error.message : state === 'cancelled' ? 'Sign-in was cancelled.' : 'Sign-in could not be completed or saved. Try again.',
    })
    this.invalidate()
  }

  private finish(flow: Flow, status: LoginStatus): void {
    flow.status = status
    flow.retainUntil = this.now() + LOGIN_STATUS_TTL_MS
  }

  private prune(): void {
    const now = this.now()
    for (const [id, flow] of this.flows) {
      if (flow.status.state === 'pending' && now >= (flow.status.expiresAt ?? flow.createdAt + 90_000)) {
        flow.controller.abort()
        this.finish(flow, {
          loginId: flow.status.loginId, state: 'expired',
          message: 'The GitHub code expired. Start a new sign-in.',
        })
      }
      if (flow.status.state !== 'pending' && now >= flow.retainUntil) {
        this.flows.delete(id)
        if (this.active === flow) this.active = undefined
      }
    }
  }

  get(loginId: string): LoginStatus | undefined {
    this.prune()
    const status = this.flows.get(loginId)?.status
    return status ? { ...status } : undefined
  }

  cancel(loginId: string): LoginStatus {
    this.prune()
    const existing = this.flows.get(loginId)
    if (existing) {
      if (existing.status.state === 'pending') {
        existing.controller.abort()
        this.finish(existing, { loginId: existing.status.loginId, state: 'cancelled' })
      }
      return { ...existing.status }
    }
    const status: LoginStatus = { loginId, state: 'cancelled' }
    if (this.flows.size >= 128) throw new Error('Too many sign-in attempts.')
    this.flows.set(loginId, {
      status, model: '', createdAt: this.now(), retainUntil: this.now() + LOGIN_STATUS_TTL_MS,
      controller: new AbortController(), started: Promise.resolve(status),
    })
    return { ...status }
  }

  private cancelActive(): void {
    if (this.active?.status.state === 'pending') this.cancel(this.active.status.loginId)
  }

  async dispose(): Promise<void> {
    clearInterval(this.cleanupTimer)
    this.shutdown.abort()
    this.cancelActive()
    await Promise.allSettled([...new Set(this.flows.values())].flatMap((flow) => [flow.started, flow.done]))
  }

  plugin(): GatewayPlugin {
    return (app) => {
      app.use('/api/provider/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
      app.use('/api/auth/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
      app.get('/api/provider/configured', (c) => c.json({ providers: this.configured() }))
      app.get('/api/provider/setup', async (c) => c.json(await this.status(c.req.query('refresh') === 'true')))
      app.post('/api/provider/setup', async (c) => {
        const input = SetupInput.safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: 'Invalid provider settings.' }, 400)
        try { return c.json(await this.save(input.data, c.req.raw.signal)) } catch {
          return c.json({ error: 'Provider settings could not be saved or activated.' }, 500)
        }
      })
      app.get('/api/auth', async (c) => {
        c.header('Cache-Control', 'no-store')
        try {
          await this.auth.getApiKey(this.shutdown.signal)
          return c.json({ authenticated: true, apiKeyValid: true })
        } catch { return c.json({ authenticated: false, apiKeyValid: false }) }
      })
      app.post('/api/auth/login', async (c) => {
        const input = LoginInput.safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: 'Invalid sign-in request.' }, 400)
        try { return c.json(await this.start(input.data.model, input.data.attemptId, c.req.raw.signal)) } catch {
          return c.json({ error: 'Sign-in could not be started. Cancel the current attempt and try again.' }, 409)
        }
      })
      app.get('/api/auth/login/:loginId', (c) => {
        const status = this.get(c.req.param('loginId'))
        return status ? c.json(status) : c.json({ error: 'Unknown sign-in attempt.' }, 404)
      })
      app.delete('/api/auth/login/:loginId', (c) => {
        const id = AttemptId.safeParse(c.req.param('loginId'))
        if (!id.success) return c.json({ error: 'Invalid sign-in identifier.' }, 400)
        try { return c.json(this.cancel(id.data)) } catch {
          return c.json({ error: 'Sign-in attempt limit reached.' }, 409)
        }
      })
    }
  }
}
