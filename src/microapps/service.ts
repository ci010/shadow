import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { z } from 'zod'
import { type LLMProvider } from '../providers/provider.ts'
import { appPath, generationSchema, microAppCapabilities, MAX_STATE_BYTES, MicroAppError, type AppRecord, type AppBundle } from './contracts.ts'
import { MicroAppStore } from './store.ts'
import { startAppProcess, type AppProcess } from './process.ts'
import { isAppPort } from './ports.ts'
import { appIcon } from './icon.ts'

interface AppRun {
  id: string
  token: string
  controller: AbortController
  ready: Promise<void>
  stop?: Promise<void>
  release?: Promise<void>
  server?: ReturnType<typeof serve>
  backend?: AppProcess
  origin?: string
  directory: string
  activeCalls: number
  calls: Set<Promise<unknown>>
  tickets: Map<string, number>
  expiresAt: number
}
const mediaTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wav': 'audio/wav',
}
const bearer = (request: Request) => /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
const matches = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
function sourceText(base64: string): string | undefined {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (error) { if (error instanceof TypeError) return undefined; throw error }
}
export async function boundedBody(request: Request | Response, max = 256 * 1024): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) throw new MicroAppError('body_too_large', 'Request or response exceeds the app transfer limit', 413)
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}
export async function appJson(request: Request) {
  return JSON.parse(Buffer.from(await boundedBody(request)).toString('utf8')) as unknown
}
function httpError(error: Error, c: Parameters<Parameters<Hono['onError']>[0]>[1]) {
  if (error instanceof MicroAppError) return c.json({ error: error.code, message: error.message }, error.status)
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'invalid_request', message: error.message }, 400)
  console.error('[microapps] Operation failed:', error.name)
  return c.json({ error: 'app_operation_failed', message: 'App operation failed. Inspect its status; do not repeat a request with uncertain effects.' }, 502)
}
export { httpError as microAppHttpError }

export class MicroApps {
  readonly store: MicroAppStore
  private runs = new Map<string, AppRun>()
  private publishing = new Set<string>()
  private stopped = false
  constructor(readonly projectId: string, home: string,
    private provider: () => LLMProvider, private defaultModel: () => string) {
    this.store = new MicroAppStore(home)
  }
  init() { return this.store.init() }
  list() { return this.store.list().map(record => this.view(record)) }
  get(id: string) { return this.view(this.store.get(id)) }
  private view(record: AppRecord) {
    return { ...record, status: !record.approval ? 'awaiting_approval' : record.lastRun?.status ?? 'stopped',
      cleanupPending: this.runs.get(record.id)?.controller.signal.aborted ?? false,
      uiPath: `/projects/${encodeURIComponent(this.projectId)}/chat/web%3Aorchestrator?microApp=${record.id}` }
  }
  private assertAvailable() {
    if (this.stopped) throw new MicroAppError('runtime_stopped', 'The Project app runtime is stopping', 409)
  }
  async publish(directory: string, manifest: unknown, sessionId: string, signal: AbortSignal, id?: string, revision?: string) {
    this.assertAvailable()
    if (!!id !== !!revision) throw new MicroAppError('revision_required', 'Supply id and revision together when updating an app')
    const key = id ?? randomUUID()
    if (this.runs.has(key) || this.publishing.has(key)) throw new MicroAppError('app_busy', 'Stop the app before publishing another revision', 409)
    this.publishing.add(key)
    try {
      if (id && this.store.get(id).createdBy !== sessionId) throw new MicroAppError('not_app_author', 'Only the original author session can replace this app', 403)
      return this.view(await this.store.publish(directory, manifest, sessionId, signal, id, revision))
    } finally { this.publishing.delete(key) }
  }
  async review(id: string) {
    const record = this.store.get(id), bundle = await this.store.bundle(record)
    return { ...this.view(record), files: Object.entries(bundle.files).map(([path, base64]) => ({
      path, bytes: Buffer.byteLength(base64, 'base64'),
      text: sourceText(base64),
    })) }
  }
  async icon(id: string, revision: string) {
    const record = this.store.get(id)
    if (record.revision !== revision) throw new MicroAppError('revision_changed', 'Reload the current app icon', 409)
    const bytes = appIcon(await this.store.bundle(record))
    if (!bytes) throw new MicroAppError('icon_not_found', 'This app uses the default Shadow icon', 404)
    return bytes
  }
  async approve(id: string, revision: string, model?: string) {
    this.assertAvailable()
    const record = this.store.get(id)
    if (this.publishing.has(id) || this.runs.has(id)) throw new MicroAppError('app_busy', 'Stop the app before changing approval', 409)
    if (record.revision !== revision) throw new MicroAppError('revision_changed', 'Review the current app revision before approval', 409)
    this.publishing.add(id)
    try {
      await this.store.bundle(record)
      this.assertAvailable()
      const chosen = record.manifest.llm ? model ?? this.defaultModel() : undefined
      if (record.manifest.llm && !chosen?.trim()) throw new MicroAppError('model_required', 'Choose a model before approving LLM access')
      if (this.store.get(id).revision !== revision || this.runs.has(id)) throw new MicroAppError('revision_changed', 'App changed during review', 409)
      record.approval = { revision, at: new Date().toISOString(), ...(chosen ? { model: chosen } : {}) }
      record.calls = 0
      this.store.save(record)
      return this.get(id)
    } finally { this.publishing.delete(id) }
  }
  async revoke(id: string) {
    if (this.publishing.has(id)) throw new MicroAppError('app_busy', 'Publication is in progress', 409)
    this.publishing.add(id)
    try {
      await this.stop(id)
      const record = this.store.get(id)
      delete record.approval
      this.store.save(record)
      return this.get(id)
    } finally { this.publishing.delete(id) }
  }
  async start(id: string) {
    this.assertAvailable()
    if (this.publishing.has(id)) throw new MicroAppError('app_busy', 'Publication is in progress', 409)
    const record = this.store.get(id)
    if (record.approval?.revision !== record.revision) throw new MicroAppError('approval_required', 'Review and approve this app in Shadow Apps before running it', 403)
    let run = this.runs.get(id)
    if (run?.stop) throw new MicroAppError('app_stopping', 'Wait for this app to stop before reopening', 409)
    if (run?.controller.signal.aborted) throw new MicroAppError('cleanup_pending', 'The previous app run has not finished stopping. Retry Stop in Shadow Apps before reopening.', 409)
    if (!run) {
      const runId = randomUUID()
      run = { id: runId, token: randomBytes(32).toString('base64url'), controller: new AbortController(),
        ready: Promise.resolve(), directory: join(this.store.root, id, 'runs', runId),
        activeCalls: 0, calls: new Set(), tickets: new Map(), expiresAt: Date.now() + 8 * 60 * 60 * 1000 }
      this.runs.set(id, run)
      run.ready = this.boot(record, run)
    }
    await run.ready
    run.controller.signal.throwIfAborted()
    return this.get(id)
  }
  private state(id: string, run: AppRun, status: NonNullable<AppRecord['lastRun']>['status'], error?: string) {
    const record = this.store.get(id)
    record.lastRun = { id: run.id, status, ...(error ? { error } : {}) }
    this.store.save(record)
  }
  private async boot(record: AppRecord, run: AppRun) {
    try {
      this.state(record.id, run, 'starting')
      const bundle = await this.store.bundle(record)
      run.controller.signal.throwIfAborted()
      const app = this.app(record.id, run, bundle)
      for (let attempt = 0; attempt < 16; attempt++) {
        const port = await new Promise<number>((resolve, reject) => {
          run.server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(info.port))
          run.server.once('error', reject)
        })
        if (isAppPort(port)) { run.origin = `http://127.0.0.1:${port}`; break }
        await new Promise<void>((resolve, reject) => run.server!.close(error => error ? reject(error) : resolve()))
        run.controller.signal.throwIfAborted()
      }
      if (!run.origin) throw new MicroAppError('app_port_unavailable', 'No browser-compatible local port is available', 502)
      run.controller.signal.throwIfAborted()
      const data = this.store.dataPath(record.id)
      await mkdir(data, { recursive: true })
      if (bundle.manifest.backend) {
        for (const [name, content] of Object.entries(bundle.files)) {
          const file = join(run.directory, ...name.split('/'))
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, Buffer.from(content, 'base64'), { flag: 'wx', mode: 0o600 })
        }
        // Retain ownership if readiness or the first cleanup attempt fails.
        run.backend = await startAppProcess(bundle.manifest.backend, run.directory, data, run.origin!, run.token, run.controller.signal,
          { onStarted: backend => { run.backend = backend } })
        void run.backend.exited.then(() => {
          if (!run.controller.signal.aborted) return this.stop(record.id, 'Backend exited; app stopped. Reopen to retry.')
        }, () => {
          if (!run.controller.signal.aborted) return this.stop(record.id, 'Backend failed; app stopped.')
        }).catch(error => console.error('[microapps] Backend cleanup failed:', error.name))
      }
      run.controller.signal.throwIfAborted()
      this.state(record.id, run, 'running')
    } catch (error) {
      run.controller.abort()
      try { await this.release(run) }
      catch (cleanupError) {
        this.state(record.id, run, 'failed', cleanupError instanceof MicroAppError ? cleanupError.message : 'App startup cleanup did not finish. Retry Stop before reopening.')
        throw cleanupError
      }
      if (!run.stop) this.runs.delete(record.id)
      this.state(record.id, run, 'failed', error instanceof Error ? error.message : 'App startup failed')
      throw error
    }
  }
  async open(id: string) {
    await this.start(id)
    const run = this.runs.get(id)
    if (!run) throw new MicroAppError('app_stopped', 'App stopped before opening. Reopen from Apps.', 409)
    run.controller.signal.throwIfAborted()
    if (Date.now() >= run.expiresAt) throw new MicroAppError('app_expired', 'App access expired after 8 hours. Stop and reopen it.', 401)
    for (const [key, expires] of run.tickets) if (expires < Date.now()) run.tickets.delete(key)
    if (run.tickets.size >= 32) throw new MicroAppError('too_many_tickets', 'Too many unconsumed app openings; wait one minute', 429)
    const ticket = randomBytes(32).toString('base64url')
    run.tickets.set(ticket, Date.now() + 60_000)
    return { url: `${run.origin}/#shadow_ticket=${ticket}`, expiresAt: new Date(run.expiresAt).toISOString() }
  }
  async stop(id: string, reason?: string) {
    const run = this.runs.get(id)
    if (!run) return this.get(id)
    run.controller.abort(new Error(reason ?? 'App stopped'))
    run.tickets.clear()
    const stopping = run.stop ??= (async () => {
      await run.ready.catch(() => {})
      await this.release(run)
      this.runs.delete(id)
      this.state(id, run, reason ? 'failed' : 'stopped', reason)
    })()
    try { await stopping }
    catch (error) {
      if (run.stop === stopping) {
        run.stop = undefined
        this.state(id, run, 'failed', error instanceof MicroAppError ? error.message : 'App cleanup did not finish. Retry Stop before reopening.')
      }
      throw error
    }
    return this.get(id)
  }
  private async release(run: AppRun) {
    const pending = run.release ??= this.releaseResources(run)
    try { await pending }
    catch (error) { if (run.release === pending) run.release = undefined; throw error }
  }
  private async releaseResources(run: AppRun) {
    let phase = 'pending model requests'
    try {
      await Promise.allSettled([...run.calls])
      phase = 'backend process termination'
      await run.backend?.stop()
      phase = 'app HTTP listener shutdown'
      if (run.server?.listening) {
        if ('closeAllConnections' in run.server) run.server.closeAllConnections()
        await new Promise<void>((resolve, reject) => run.server!.close(error => error ? reject(error) : resolve()))
      }
      phase = 'temporary run removal'
      await rm(run.directory, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      const failure = new MicroAppError('cleanup_failed', `App cleanup failed during ${phase}. Retry Stop; the app is not marked stopped.`, 502)
      failure.cause = error
      throw failure
    }
  }
  async shutdown() {
    this.stopped = true
    const results = await Promise.allSettled([...this.runs.keys()].map(id => this.stop(id)))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Micro App shutdown failed')
  }
  private app(id: string, run: AppRun, bundle: AppBundle) {
    const app = new Hono()
    app.onError(httpError)
    app.use('*', async (c, next) => {
      await next()
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'self'; frame-ancestors http://127.0.0.1:* http://localhost:* file:; sandbox allow-scripts allow-same-origin allow-forms allow-downloads")
    })
    app.use('*', async (c, next) => {
      if (c.req.header('host') !== new URL(run.origin!).host
        || c.req.header('origin') && c.req.header('origin') !== run.origin) {
        throw new MicroAppError('origin_not_allowed', 'App requests must use this app origin', 403)
      }
      if (run.controller.signal.aborted || Date.now() >= run.expiresAt) throw new MicroAppError('app_stopped', 'App stopped or access expired. Reopen from Shadow Apps.', 401)
      return next()
    })
    app.post('/_shadow/connect', c => {
      const ticket = bearer(c.req.raw), expires = run.tickets.get(ticket)
      run.tickets.delete(ticket)
      if (!expires || expires < Date.now()) throw new MicroAppError('invalid_ticket', 'App opening expired or was already used; reopen from Shadow Apps', 401)
      return c.json({ token: run.token })
    })
    const authorize: Parameters<Hono['use']>[1] = async (c, next) => {
      if (!matches(bearer(c.req.raw), run.token)) throw new MicroAppError('unauthorized', 'App access required', 401)
      return next()
    }
    app.get('/_shadow/sdk.js', async c => {
      c.header('Content-Type', 'text/javascript; charset=utf-8')
      return c.body(await readFile(new URL('./sdk.js', import.meta.url), 'utf8'))
    })
    app.use('/_shadow/generate', authorize)
    app.use('/_shadow/status', authorize)
    app.use('/_shadow/state', authorize)
    app.get('/_shadow/status', c => {
      const record = this.store.get(id)
      return c.json({ id, name: record.manifest.name, model: record.approval?.model,
        calls: record.calls, maxCalls: record.manifest.llm?.maxCalls ?? 0, backend: !!record.manifest.backend,
        capabilities: microAppCapabilities })
    })
    app.get('/_shadow/state', c => c.json(this.store.loadState(id)))
    app.put('/_shadow/state', async c => {
      const body = await boundedBody(c.req.raw, MAX_STATE_BYTES)
      run.controller.signal.throwIfAborted()
      return c.json(this.store.saveState(id, JSON.parse(Buffer.from(body).toString('utf8'))))
    })
    app.post('/_shadow/generate', async c => {
      const input = generationSchema.parse(await appJson(c.req.raw))
      const record = this.store.get(id), grant = record.manifest.llm
      if (!grant || !record.approval?.model) throw new MicroAppError('llm_not_granted', 'This app has no model authorization', 403)
      run.controller.signal.throwIfAborted()
      const model = record.approval.model
      if (record.calls >= grant.maxCalls) throw new MicroAppError('llm_budget_exhausted', 'App call budget exhausted. The owner must review and renew its authorization.', 429)
      if (run.activeCalls >= 2) throw new MicroAppError('llm_busy', 'At most two model requests can run at once', 429)
      record.calls++
      this.store.save(record)
      run.activeCalls++
      const operation = Promise.resolve().then(() => this.provider().chat(input.messages, [], {
        model, maxTokens: Math.min(input.maxTokens ?? grant.maxOutputTokens, grant.maxOutputTokens),
        signal: AbortSignal.any([run.controller.signal, c.req.raw.signal, AbortSignal.timeout(120_000)]),
      }))
      run.calls.add(operation)
      try {
        const result = await operation
        run.controller.signal.throwIfAborted()
        if (result.toolCalls.length || result.content === null) throw new MicroAppError('unsupported_model_result', 'Model returned no text; app calls do not execute tools', 502)
        return c.json({ text: result.content, usage: result.usage })
      } finally { run.calls.delete(operation); run.activeCalls-- }
    })
    app.use('/backend/*', authorize)
    app.all('/backend/*', async c => {
      if (!run.backend) throw new MicroAppError('backend_unavailable', 'App backend is not running', 409)
      const path = c.req.path.slice('/backend'.length)
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new MicroAppError('invalid_backend_path', 'Invalid backend path')
      const body = await boundedBody(c.req.raw, 16 * 1024 * 1024)
      const response = await fetch(`${run.backend.origin}${path}${new URL(c.req.url).search}`, {
        method: c.req.method, redirect: 'error',
        headers: { Authorization: `Bearer ${run.token}`, 'Content-Type': c.req.header('content-type') ?? 'application/octet-stream' },
        ...(body.length ? { body: Buffer.from(body) } : {}),
        signal: AbortSignal.any([run.controller.signal, c.req.raw.signal, AbortSignal.timeout(180_000)]),
      })
      const bytes = await boundedBody(response, 16 * 1024 * 1024)
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.from(bytes), { status: response.status, headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } })
    })
    app.get('*', c => {
      const name = c.req.path === '/' ? bundle.manifest.entry : decodeURIComponent(c.req.path.slice(1))
      if (!appPath.safeParse(name).success || !Object.hasOwn(bundle.files, name) || name === bundle.manifest.backend?.entry || !mediaTypes[extname(name)]) {
        throw new MicroAppError('asset_not_found', 'App asset not found', 404)
      }
      return new Response(Buffer.from(bundle.files[name], 'base64'), { headers: { 'Content-Type': mediaTypes[extname(name)] } })
    })
    return app
  }
}
