import { t } from './i18n.ts'
import { apiUrl } from './api-url.ts'
import { createUuid } from './uuid.ts'

export interface ProviderSetupStatus {
  provider: string
  model: string
  authMode: 'api-key' | 'copilot' | 'none'
  ready: boolean
  hasApiKey: boolean
  baseUrl?: string
  reason?: string
}

export interface ProviderSetupInput {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
}

export interface ConfiguredProvider {
  provider: string
  authMode: ProviderSetupStatus['authMode']
  hasApiKey: boolean
  selected: boolean
  baseUrl?: string
  model?: string
}

export const providerPresets = [
  { id: 'openai', name: 'OpenAI', model: 'gpt-4.1' },
  { id: 'anthropic', name: 'Anthropic', model: 'claude-sonnet-4-6' },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-flash' },
  { id: 'openrouter', name: 'OpenRouter', model: 'anthropic/claude-sonnet-4.6' },
  { id: 'gemini', name: 'Google Gemini', model: 'gemini-2.5-pro' },
  { id: 'groq', name: 'Groq', model: 'llama-3.3-70b-versatile' },
]

export function providerDisplayName(provider: string): string {
  return provider === 'copilot' ? 'GitHub Copilot' : providerPresets.find(item => item.id === provider)?.name ?? provider
}

export function parseConfiguredProviders(value: unknown): ConfiguredProvider[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    throw new Error(t('The backend returned an invalid provider list. Restart Main and retry.'))
  }
  const names = new Set<string>()
  let selected = false
  return value.providers.map((item: unknown) => {
    if (!isRecord(item) || typeof item.provider !== 'string' || !item.provider
      || names.has(item.provider) || typeof item.selected !== 'boolean'
      || (item.selected && selected) || typeof item.hasApiKey !== 'boolean'
      || !['api-key', 'copilot', 'none'].includes(String(item.authMode))
      || (item.model !== undefined && typeof item.model !== 'string')
      || (item.baseUrl !== undefined && typeof item.baseUrl !== 'string')) {
      throw new Error(t('The backend returned an invalid provider list. Restart Main and retry.'))
    }
    names.add(item.provider)
    selected ||= item.selected
    return {
      provider: item.provider,
      selected: item.selected,
      hasApiKey: item.hasApiKey,
      authMode: item.authMode as ConfiguredProvider['authMode'],
      ...(typeof item.model === 'string' ? { model: item.model } : {}),
      ...(typeof item.baseUrl === 'string' ? { baseUrl: item.baseUrl } : {}),
    }
  })
}

export type LoginState = 'pending' | 'succeeded' | 'denied' | 'expired' | 'cancelled' | 'error'
export interface DeviceLogin {
  loginId: string
  state: LoginState
  userCode?: string
  verificationUri?: string
  expiresAt?: number
  intervalMs?: number
}

export const COPILOT_VERIFICATION_URL = 'https://github.com/login/device'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseProviderSetup(value: unknown): ProviderSetupStatus {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string'
    || typeof value.ready !== 'boolean' || typeof value.hasApiKey !== 'boolean'
    || !['api-key', 'copilot', 'none'].includes(String(value.authMode))
    || (value.baseUrl !== undefined && typeof value.baseUrl !== 'string')
    || (value.reason !== undefined && typeof value.reason !== 'string')) {
    throw new Error(t('The backend returned an invalid provider status. Restart Main and retry.'))
  }
  return {
    provider: value.provider,
    model: value.model,
    ready: value.ready,
    hasApiKey: value.hasApiKey,
    authMode: value.authMode as ProviderSetupStatus['authMode'],
    baseUrl: value.baseUrl as string | undefined,
    reason: value.reason as string | undefined,
  }
}

export function parseDeviceLogin(value: unknown): DeviceLogin {
  if (!isRecord(value) || typeof value.loginId !== 'string' || !/^[\w-]{1,100}$/.test(value.loginId)
    || !['pending', 'succeeded', 'denied', 'expired', 'cancelled', 'error'].includes(String(value.state))) {
    throw new Error(t('The backend returned an invalid login status. Please retry.'))
  }
  if (value.state === 'pending' && (
    typeof value.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(value.userCode)
    || value.verificationUri !== COPILOT_VERIFICATION_URL
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
    || typeof value.intervalMs !== 'number' || !Number.isFinite(value.intervalMs) || value.intervalMs < 1000
  )) {
    throw new Error(t('The backend returned an invalid GitHub device code. Please retry.'))
  }
  return {
    loginId: value.loginId,
    state: value.state as LoginState,
    ...(value.state === 'pending' ? {
      userCode: value.userCode as string,
      verificationUri: value.verificationUri as string,
      expiresAt: value.expiresAt as number,
      intervalMs: value.intervalMs as number,
    } : {}),
  }
}

export class ProviderRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403
      ? t('Credentials were not accepted. Reconfigure this provider or sign in again.')
      : status === 400
        ? t('Check the provider, model, base URL and API key, then retry.')
        : t('Cannot reach the provider setup service. Check Main and your network, then retry.'))
  }
}

export function createProviderSetupClient(apiBase: string, request: typeof fetch = fetch) {
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await request(apiUrl(apiBase, path).toString(), {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      })
    } catch (error) {
      if (init?.signal?.aborted) throw error
      throw new ProviderRequestError(0)
    }
    if (!response.ok) throw new ProviderRequestError(response.status)
    try { return await response.json() }
    catch { throw new ProviderRequestError(502) }
  }
  return {
    async configured(signal?: AbortSignal) {
      return parseConfiguredProviders(await json('/api/provider/configured', { signal }))
    },
    async status(signal?: AbortSignal, refresh = false) {
      return parseProviderSetup(await json(`/api/provider/setup${refresh ? '?refresh=true' : ''}`, { signal }))
    },
    async save(input: ProviderSetupInput) {
      return parseProviderSetup(await json('/api/provider/setup', {
        method: 'POST', body: JSON.stringify(input),
      }))
    },
    async start(model?: string, attemptId?: string, signal?: AbortSignal) {
      const login = parseDeviceLogin(await json('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ model, attemptId }), signal,
      }))
      if (attemptId && login.loginId !== attemptId) throw new Error(t('The login attempt changed. Please retry.'))
      return login
    },
    async poll(loginId: string, signal?: AbortSignal) {
      const login = parseDeviceLogin(await json(`/api/auth/login/${encodeURIComponent(loginId)}`, { signal }))
      if (login.loginId !== loginId) throw new Error(t('The login attempt changed. Please retry.'))
      return login
    },
    async cancel(loginId: string) {
      await json(`/api/auth/login/${encodeURIComponent(loginId)}`, { method: 'DELETE', keepalive: true })
    },
  }
}

export type ProviderSetupClient = ReturnType<typeof createProviderSetupClient>
export type LoginView = { state: LoginState | 'idle' | 'starting' | 'cancelling'; login?: DeviceLogin; error?: string }
type Schedule = (callback: () => void, delay: number) => () => void

export function createDeviceLoginController(
  client: Pick<ProviderSetupClient, 'start' | 'poll' | 'cancel'>,
  changed: (view: LoginView) => void,
  schedule: Schedule = (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
  createId: () => string = createUuid,
) {
  let generation = 0
  let view: LoginView = { state: 'idle' }
  let unschedule: (() => void) | undefined
  let pollController: AbortController | undefined
  let startController: AbortController | undefined
  let activeId: string | undefined
  let cancellation: Promise<void> | undefined
  const update = (next: LoginView) => { view = next; changed(next) }
  const clear = () => {
    unschedule?.()
    unschedule = undefined
    pollController?.abort()
  }
  async function poll(login: DeviceLogin, current: number) {
    pollController = new AbortController()
    try {
      const next = await client.poll(login.loginId, pollController.signal)
      if (current !== generation) return
      accept(next, current)
    } catch {
      if (current !== generation) return
      await cancel()
      if (view.state !== 'error') {
        update({ state: 'error', error: t('Login status could not be refreshed. Check your connection and retry.') })
      }
    }
  }
  function accept(login: DeviceLogin, current: number) {
    update({ state: login.state, login })
    if (login.state !== 'pending') activeId = undefined
    if (login.state === 'pending') {
      // GitHub polling is owned by Main; this timer only refreshes its safe status.
      unschedule = schedule(() => { void poll(login, current) }, Math.min(login.intervalMs ?? 2000, 5000))
    }
  }
  async function start(model?: string) {
    if (view.state === 'pending' || view.state === 'starting' || view.state === 'cancelling') return
    clear()
    const current = ++generation
    const attemptId = createId()
    activeId = attemptId
    const requestController = new AbortController()
    startController = requestController
    update({ state: 'starting' })
    try {
      const login = await client.start(model, attemptId, requestController.signal)
      if (current === generation) accept(login, current)
    } catch {
      if (current === generation) {
        await cancel()
        if (view.state !== 'error') update({ state: 'error', error: t('Could not start GitHub login. Check your connection and retry.') })
      }
    } finally {
      if (startController === requestController) startController = undefined
    }
  }
  function cancel(): Promise<void> {
    if (cancellation) return cancellation
    const login = view.login
    const id = activeId
    const active = view.state === 'pending' || view.state === 'starting'
    ++generation
    clear()
    startController?.abort()
    if (!active) return Promise.resolve()
    update({ state: 'cancelling', login })
    cancellation = (async () => {
      try {
        // Main remembers pre-cancelled IDs, even if DELETE arrives before POST.
        if (id) await client.cancel(id)
        activeId = undefined
        update({ state: 'cancelled' })
      } catch {
        update({ state: 'error', error: t('Could not confirm cancellation. The device code will expire; check your connection before retrying.') })
      } finally {
        cancellation = undefined
      }
    })()
    return cancellation
  }
  return { start, cancel }
}
