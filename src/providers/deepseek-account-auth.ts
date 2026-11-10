import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { arch, platform, release } from 'node:os'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../utils/private-file.ts'

export const DEEPSEEK_PLATFORM = 'https://platform.deepseek.com'
export const DEEPSEEK_INFERENCE = 'https://api.deepseek.com'
const Grant = z.object({ version: z.literal(1), issuer: z.literal(DEEPSEEK_PLATFORM), token: z.string().regex(/^[\x21-\x7e]+$/), deviceId: z.string().uuid() })
export interface AccountLogin {
  loginId: string
  state: 'pending' | 'succeeded' | 'cancelled' | 'expired' | 'error'
  authorizeUrl?: string
  expiresAt?: number
}
interface Attempt {
  status: AccountLogin
  controller: AbortController
  server: Server
  done?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}
export function accountBrowserUrl(value: string, path = '/dsh/authorize'): string {
  const url = new URL(value)
  if (url.origin !== DEEPSEEK_PLATFORM || url.pathname !== path || url.username || url.password || url.hash) throw new Error('DeepSeek returned an invalid browser destination')
  return url.href
}

/** A separate private-file grant store. Not an OS keychain. No API-key fallback. */
export class DeepSeekAccountAuth {
  private starting?: Promise<AccountLogin>
  private attempt?: Attempt
  private lifetime = new AbortController()
  private rejected = new Set<string>()
  constructor(private readonly directory: string, private readonly request: typeof fetch = fetch) {}
  private get file(): string { return join(this.directory, 'grant.json') }
  private read(): z.infer<typeof Grant> | undefined {
    try { return Grant.parse(JSON.parse(readFileSync(this.file, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('DeepSeek Account credential storage could not be read')
    }
  }
  resolve(endpoint = `${DEEPSEEK_INFERENCE}/v1/messages`): { token: string; signal: AbortSignal } {
    const url = new URL(endpoint)
    if (url.origin !== DEEPSEEK_INFERENCE || url.username || url.password || url.pathname !== '/v1/messages' || url.search || url.hash) throw new Error('DeepSeek Account destination is not allowed')
    const grant = this.read()
    if (!grant || this.rejected.has(grant.token)) throw new Error('Sign in to DeepSeek Account in provider settings')
    return { token: grant.token, signal: this.lifetime.signal }
  }
  ready(): boolean { try { this.resolve(); return true } catch { return false } }
  reject(token: string): void {
    // An old request must never remove a newer grant.
    this.rejected.add(token)
    if (this.read()?.token === token) {
      this.lifetime.abort()
      this.lifetime = new AbortController()
      rmSync(this.file, { force: true })
    }
  }
  status(id: string): AccountLogin | undefined {
    return this.attempt?.status.loginId === id ? { ...this.attempt.status } : undefined
  }
  cancel(id?: string): AccountLogin | undefined {
    const attempt = this.attempt
    if (!attempt || (id && id !== attempt.status.loginId)) return undefined
    if (attempt.status.state === 'pending') {
      attempt.status = { loginId: attempt.status.loginId, state: 'cancelled' }
      attempt.controller.abort()
      clearTimeout(attempt.timer)
      attempt.server.close()
      attempt.server.closeAllConnections()
    }
    return { ...attempt.status }
  }
  async dispose(): Promise<void> {
    this.cancel()
    this.lifetime.abort()
    await this.starting?.catch(() => undefined)
    await this.attempt?.done
  }
  async logout(): Promise<void> {
    this.cancel()
    this.lifetime.abort()
    this.lifetime = new AbortController()
    const token = this.read()?.token
    if (token) this.rejected.add(token)
    rmSync(this.file, { force: true })
    if (token) {
      // Local removal is authoritative even when server revocation is unavailable.
      try {
        const response = await this.request(`${DEEPSEEK_PLATFORM}/auth-api/v0/users/logout`, {
          method: 'POST', headers: { 'x-dsh-auth-token': token }, redirect: 'error', signal: AbortSignal.timeout(10_000),
        })
        await response.body?.cancel()
      } catch { /* Do not restore a locally removed grant. */ }
    }
  }
  private async platformRequest(method: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(`${DEEPSEEK_PLATFORM}/auth-api/v0/dsh/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('DeepSeek Account authorization request failed') }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('DeepSeek Account authorization response missing')
    let text = ''
    try {
      const decoder = new TextDecoder()
      let size = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 65_536) throw new Error('DeepSeek Account authorization response too large')
        text += decoder.decode(next.value, { stream: true })
      }
      text += decoder.decode()
    } finally { await reader.cancel(); reader.releaseLock() }
    const envelope = z.object({ code: z.literal(0), data: z.object({ biz_code: z.literal(0), biz_data: z.unknown() }) }).safeParse(JSON.parse(text))
    if (!envelope.success) throw new Error('DeepSeek Account authorization was not granted')
    return envelope.data.data.biz_data
  }
  start(): Promise<AccountLogin> {
    if (this.starting) return this.starting
    const pending = this.begin()
    this.starting = pending
    void pending.finally(() => { if (this.starting === pending) this.starting = undefined }).catch(() => {})
    return pending
  }
  private async begin(): Promise<AccountLogin> {
    // Join the current attempt; never race two exchanges against one grant file.
    if (this.attempt?.status.state === 'pending') return { ...this.attempt.status }
    await this.attempt?.done
    const controller = new AbortController()
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let deliver!: (code: string) => void
    const code = new Promise<string>(resolve => { deliver = resolve })
    let used = false
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Security-Policy', "default-src 'none'")
      const address = server.address()
      const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
      let url: URL
      try { url = new URL(req.url ?? '/', `http://${host || '127.0.0.1'}`) }
      catch { res.writeHead(400).end('Invalid callback URL'); return }
      const receivedState = url.searchParams.get('state') ?? ''
      const receivedCode = url.searchParams.get('code') ?? ''
      if (req.method !== 'GET' || req.headers.host !== host || url.pathname !== '/oauth/callback' ||
        url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 ||
        Buffer.byteLength(receivedState) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state)) || !receivedCode || receivedCode.length > 4096) {
        res.writeHead(400).end('Invalid authorization callback'); return
      }
      if (used || controller.signal.aborted) { res.writeHead(410).end('Authorization no longer active'); return }
      used = true
      deliver(receivedCode)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorization received. Return to Shadow to check the result.')
    })
    const attempt: Attempt = { status: { loginId: randomUUID(), state: 'pending' }, controller, server }
    this.attempt = attempt
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Callback listener unavailable')
      const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`
      const signal = controller.signal
      signal.throwIfAborted()
      const expiresAt = Date.now() + 600_000
      attempt.timer = setTimeout(() => { attempt.status = { loginId: attempt.status.loginId, state: 'expired' }; controller.abort() }, 600_000)
      attempt.timer.unref()
      const init = z.object({ authorize_url: z.string(), authorize_id: z.string().min(1), expires_in: z.number().positive() }).parse(
        await this.platformRequest('auth_init', { code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: redirectUri, locale: 'en_US', login_source: 'web' }, signal))
      signal.throwIfAborted()
      attempt.status = { ...attempt.status, authorizeUrl: accountBrowserUrl(init.authorize_url), expiresAt: Math.min(expiresAt, Date.now() + init.expires_in * 1000) }
      clearTimeout(attempt.timer)
      attempt.timer = setTimeout(() => { attempt.status = { loginId: attempt.status.loginId, state: 'expired' }; controller.abort() }, Math.max(1, attempt.status.expiresAt! - Date.now()))
      attempt.timer.unref()
      attempt.done = (async () => {
        try {
          const receivedCode = await new Promise<string>((resolve, reject) => {
            const abort = () => reject(new Error('Authorization cancelled'))
            signal.addEventListener('abort', abort, { once: true })
            code.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, reject)
            if (signal.aborted) abort()
          })
          const deviceId = this.read()?.deviceId ?? randomUUID()
          const exchange = z.object({ token: Grant.shape.token, authorized_url: z.string() }).parse(await this.platformRequest('auth_exchange', {
            code: receivedCode, code_verifier: verifier, redirect_uri: redirectUri, device_id: deviceId, device_model: `${platform()}-${arch()}`, os_version: release(),
          }, signal))
          accountBrowserUrl(exchange.authorized_url, '/dsh/authorized')
          signal.throwIfAborted()
          mkdirSync(this.directory, { recursive: true, mode: 0o700 })
          chmodSync(this.directory, 0o700)
          writePrivateFile(this.file, JSON.stringify({ version: 1, issuer: DEEPSEEK_PLATFORM, token: exchange.token, deviceId }))
          this.lifetime.abort()
          this.lifetime = new AbortController()
          this.rejected.delete(exchange.token)
          attempt.status = { loginId: attempt.status.loginId, state: 'succeeded' }
        } catch {
          if (!signal.aborted) attempt.status = { loginId: attempt.status.loginId, state: 'error' }
        } finally {
          clearTimeout(attempt.timer)
          server.close()
          server.closeAllConnections()
        }
      })()
      return { ...attempt.status }
    } catch {
      const cancelled = controller.signal.aborted
      this.cancel()
      if (cancelled) return { ...attempt.status }
      attempt.status = { loginId: attempt.status.loginId, state: 'error' }
      throw new Error('DeepSeek Account sign-in could not be initialized. Check service availability and third-party access.')
    }
  }
}

const accounts = new Map<string, DeepSeekAccountAuth>()
/** Provider instances and Projects never share grant files implicitly. */
export function deepseekAccountAuth(home: string, id: string): DeepSeekAccountAuth {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid DeepSeek Account instance')
  const directory = join(home, 'config', 'deepseek-account', id)
  let auth = accounts.get(directory)
  if (!auth) { auth = new DeepSeekAccountAuth(directory); accounts.set(directory, auth) }
  return auth
}
