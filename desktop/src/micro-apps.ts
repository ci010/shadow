import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Task } from 'electron'
import { normalizeLoopbackOrigin, type RuntimeAuthorization } from './runtime-authorization.js'
import { isRecord, microAppArgument, parseMicroAppIdentity, parseMicroAppLaunch, parseNativeMicroApp,
  type MicroAppIdentity, type NativeMicroApp } from './micro-app-contract.js'
import { projectIds } from './project-catalog.js'

export interface MicroAppWindowHandle { focus(): void; close(): void }
export interface MicroAppWindowInput {
  name: string
  url: string
  iconPath: string
  partition: string
  signal: AbortSignal
  onClosed(): void
}
interface NativeAppOptions {
  userDataPath: string
  executablePath: string
  appPath: string
  packaged: boolean
  defaultIconPath: string
  platform?: NodeJS.Platform
  fetch?: typeof globalThis.fetch
  createWindow(input: MicroAppWindowInput): Promise<MicroAppWindowHandle>
  decodeIcon(png: Buffer): { png: Buffer; width: number; height: number }
  setUserTasks(tasks: Task[]): boolean
  onError(message: string): void
}
interface WindowEntry {
  identity: MicroAppIdentity
  authorization: RuntimeAuthorization
  revision: string
  handle?: MicroAppWindowHandle
  closed: boolean
  stopOnClose: boolean
  abort: AbortController
}
const keyOf = (identity: MicroAppIdentity) => `${identity.projectId}:${identity.appId}`
const pathOf = (identity: MicroAppIdentity) => `/projects/${identity.projectId}/api/microapps/${identity.appId}`
const nativeTitle = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, ' ')

export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new TypeError('Invalid Windows argument')
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

export function pngIconContainer(png: Buffer, width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256) {
    throw new TypeError('Invalid decoded icon dimensions')
  }
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
  header[6] = width === 256 ? 0 : width; header[7] = height === 256 ? 0 : height
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}

export class DesktopMicroApps {
  private authorization: RuntimeAuthorization | null = null
  private epoch = new AbortController()
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshing: Promise<void> | undefined
  private readonly windows = new Map<string, WindowEntry>()
  private readonly openings = new Map<string, Promise<void>>()
  private readonly stops = new Map<string, Promise<void>>()
  private readonly icons = new Map<string, Promise<{ window: string; task: string }>>()
  private readonly catalogs = new Map<string, NativeMicroApp[]>()
  private lastTasks = ''
  private lastError = ''

  constructor(private readonly options: NativeAppOptions) {}
  get hasOpenWindows(): boolean { return this.windows.size > 0 || this.openings.size > 0 }

  setAuthorization(value: RuntimeAuthorization | null): void {
    if (this.disposed) return
    if (value && (normalizeLoopbackOrigin(value.apiBase) !== value.apiBase || !value.launchToken)) {
      throw new TypeError('Micro Apps require an authenticated loopback Main')
    }
    if (value?.apiBase === this.authorization?.apiBase && value?.launchToken === this.authorization?.launchToken) return
    clearTimeout(this.timer)
    for (const entry of this.windows.values()) entry.stopOnClose = false
    this.epoch.abort()
    this.epoch = new AbortController()
    for (const entry of this.windows.values()) this.closeWindow(entry)
    this.windows.clear()
    this.catalogs.clear()
    this.icons.clear()
    this.authorization = value ? { ...value } : null
    if (value) void this.refresh()
  }

  private async read(authorization: RuntimeAuthorization, path: string, body?: unknown, signal = this.epoch.signal): Promise<Response> {
    const response = await (this.options.fetch ?? globalThis.fetch)(new URL(path, authorization.apiBase), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${authorization.launchToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 10_000 : 30_000)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Micro App request failed (HTTP ${response.status}); check Project availability and approval`)
    }
    return response
  }

  private async json(authorization: RuntimeAuthorization, path: string, body?: unknown, signal = this.epoch.signal): Promise<unknown> {
    const response = await this.read(authorization, path, body, signal)
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw new Error('Micro App response is not JSON')
    }
    return JSON.parse((await limitedBytes(response, 2 * 1024 * 1024)).toString('utf8')) as unknown
  }

  private asset(authorization: RuntimeAuthorization, identity: MicroAppIdentity, app: NativeMicroApp, signal = this.epoch.signal) {
    if (!app.icon) return Promise.resolve({ window: this.options.defaultIconPath, task: this.options.defaultIconPath })
    const cacheKey = `${keyOf(identity)}:${app.revision}`
    const existing = this.icons.get(cacheKey)
    if (existing) return existing
    const pending = (async () => {
      const response = await this.read(authorization, `${pathOf(identity)}/icon?revision=${app.revision}`, undefined, signal)
      if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('App icon is not PNG')
      const decoded = this.options.decodeIcon(await limitedBytes(response, 256 * 1024))
      signal.throwIfAborted()
      const directory = join(this.options.userDataPath, 'microapp-icons')
      await mkdir(directory, { recursive: true })
      const windowPath = join(directory, `${app.revision}.png`), taskPath = join(directory, `${app.revision}.ico`)
      await atomicIcon(windowPath, decoded.png)
      await atomicIcon(taskPath, pngIconContainer(decoded.png, decoded.width, decoded.height))
      return { window: windowPath, task: taskPath }
    })().catch(error => { if (this.icons.get(cacheKey) === pending) this.icons.delete(cacheKey); throw error })
    this.icons.set(cacheKey, pending)
    return pending
  }

  open(rawIdentity: unknown): Promise<void> {
    const identity = parseMicroAppIdentity(rawIdentity), key = keyOf(identity)
    const pending = this.openings.get(key)
    if (pending) return pending
    const operation = this.openWindow(identity).finally(() => { if (this.openings.get(key) === operation) this.openings.delete(key) })
    this.openings.set(key, operation)
    return operation
  }

  private async openWindow(identity: MicroAppIdentity): Promise<void> {
    await this.stops.get(keyOf(identity))
    const authorization = this.authorization, signal = this.epoch.signal
    if (this.disposed || !authorization) throw new Error('Start the local Shadow Main before opening an app')
    const app = parseNativeMicroApp(await this.json(authorization, `${pathOf(identity)}/status`, undefined, signal))
    if (app.id !== identity.appId || !app.approved) throw new Error('Review and approve this app version in Shadow Apps first')
    signal.throwIfAborted()
    const existing = this.windows.get(keyOf(identity))
    if (existing && !existing.closed && existing.revision === app.revision && app.status === 'running') {
      existing.handle?.focus()
      return
    }
    if (existing) { this.closeWindow(existing); await this.stops.get(keyOf(identity)) }
    const icon = await this.asset(authorization, identity, app, signal)
    const entry: WindowEntry = { identity, revision: app.revision, authorization, closed: false, stopOnClose: true, abort: new AbortController() }
    try {
      const url = parseMicroAppLaunch(await this.json(authorization, `${pathOf(identity)}/open`, {}, signal))
      signal.throwIfAborted()
      this.windows.set(keyOf(identity), entry)
      entry.handle = await this.options.createWindow({
        name: nativeTitle(app.name), url, iconPath: icon.window,
        partition: `shadow-microapp-${identity.projectId}-${identity.appId}-${randomUUID()}`,
        signal: AbortSignal.any([signal, entry.abort.signal]),
        onClosed: () => this.closed(entry),
      })
      if (entry.closed || signal.aborted || this.disposed) {
        entry.handle.close()
        throw new Error('App opening was interrupted; reopen it from Shadow')
      }
    } catch (error) {
      if (this.authorization !== authorization) entry.stopOnClose = false
      this.closed(entry)
      await this.stops.get(keyOf(identity))
      throw error
    }
  }

  private closeWindow(entry: WindowEntry): void {
    entry.abort.abort()
    entry.handle?.close()
    this.closed(entry)
  }

  private closed(entry: WindowEntry): void {
    if (entry.closed) return
    entry.closed = true
    entry.abort.abort()
    const key = keyOf(entry.identity)
    if (this.windows.get(key) === entry) this.windows.delete(key)
    if (!entry.stopOnClose) return
    const stopping = this.json(entry.authorization, `${pathOf(entry.identity)}/stop`, {}, new AbortController().signal)
      .then(() => undefined).catch(() => this.options.onError('Could not stop the closed app. Use Stop in Shadow Apps to check its backend.'))
      .finally(() => { if (this.stops.get(key) === stopping) this.stops.delete(key) })
    this.stops.set(key, stopping)
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (this.disposed || !this.authorization) return Promise.resolve()
    clearTimeout(this.timer)
    const authorization = this.authorization, signal = this.epoch.signal
    const operation = this.refreshCatalog(authorization, signal).then(() => { this.lastError = '' }).catch(error => {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : 'Could not refresh Micro Apps'
        if (message !== this.lastError) this.options.onError(message)
        this.lastError = message
      }
    }).finally(() => {
      if (this.refreshing === operation) this.refreshing = undefined
      if (!this.disposed && this.authorization) {
        this.timer = setTimeout(() => { void this.refresh() }, signal.aborted ? 0 : 2500)
        this.timer.unref()
      }
    })
    this.refreshing = operation
    return operation
  }

  private async refreshCatalog(authorization: RuntimeAuthorization, signal: AbortSignal) {
    const observedWindows = new Map(this.windows)
    const projects = projectIds(await this.json(authorization, '/api/projects', undefined, signal))
    const checked = new Set<string>(), errors: string[] = []
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
      while (!signal.aborted) {
        const projectId = projects[index++]
        if (projectId === undefined) return
        try {
          const response = await this.json(authorization, `/projects/${projectId}/api/microapps`, undefined, signal)
          if (!isRecord(response) || !Array.isArray(response.apps)) throw new Error('Invalid Micro App catalog')
          const apps = response.apps.map(parseNativeMicroApp)
          signal.throwIfAborted()
          this.catalogs.set(projectId, apps)
          checked.add(projectId)
        } catch (error) { errors.push(error instanceof Error ? error.message : 'Project apps unavailable') }
      }
    }))
    signal.throwIfAborted()
    for (const id of this.catalogs.keys()) if (!projects.includes(id)) this.catalogs.delete(id)
    for (const [key, entry] of observedWindows) {
      if (this.windows.get(key) !== entry) continue
      const projectId = entry.identity.projectId
      if (!projects.includes(projectId) || checked.has(projectId)) {
        const current = this.catalogs.get(projectId)?.find(app => app.id === entry.identity.appId)
        if (!current?.approved || current.revision !== entry.revision || current.status !== 'running') this.closeWindow(entry)
      }
    }
    if ((this.options.platform ?? process.platform) === 'win32') {
      const tasks: Task[] = []
      for (const projectId of [...this.catalogs.keys()].sort()) for (const app of this.catalogs.get(projectId)!) {
        if (!app.approved) continue
        signal.throwIfAborted()
        const identity = { projectId, appId: app.id }, icon = await this.asset(authorization, identity, app, signal)
        const args = [
          ...(this.options.packaged ? [] : [this.options.appPath]),
          `--user-data-dir=${this.options.userDataPath}`,
          microAppArgument(identity),
        ]
        tasks.push({ program: this.options.executablePath, arguments: args.map(quoteWindowsArgument).join(' '),
          iconPath: icon.task, iconIndex: 0, title: `${nativeTitle(app.name)} · ${projectId}`,
          description: `Open ${nativeTitle(app.name)} in Shadow`, workingDirectory: dirname(this.options.executablePath) })
      }
      signal.throwIfAborted()
      const encoded = JSON.stringify(tasks)
      if (encoded !== this.lastTasks) {
        if (!this.options.setUserTasks(tasks)) throw new Error('Windows could not update the Shadow task menu')
        this.lastTasks = encoded
      }
    }
    if (errors.length) throw new Error([...new Set(errors)].join('; '))
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.epoch.abort()
    for (const entry of this.windows.values()) this.closeWindow(entry)
    await Promise.all([...this.openings.values(), ...this.stops.values()].map(promise => promise.catch(() => undefined)))
    this.authorization = null
    // Windows retains the reviewed launch identities and cached icons for cold starts.
  }
}

async function limitedBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Empty Micro App response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > limit) throw new Error('Micro App response exceeds its size limit')
      chunks.push(next.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel() }
}

async function atomicIcon(path: string, bytes: Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
