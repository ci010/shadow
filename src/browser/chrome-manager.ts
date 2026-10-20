import { rentBrowserSlot, type BrowserSlot } from './slot-pool.ts'
import { copyUserProfile, getDefaultUserDataDir } from './profile-copy.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { resolve } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { copyFile, mkdir, readdir, stat as nodeStat } from 'node:fs/promises'
import process from 'node:process'
import { getOs } from '../utils/runtime.ts'
import type { z } from 'zod'
import type { ChromeToolSchema } from '../config/schema.ts'
import { createServer } from 'node:net'
import { getProjectScope } from '../projects/scope.ts'

type ChromeConfig = Omit<z.infer<typeof ChromeToolSchema>, 'slotCount'> & { slotCount?: number }

export type BrowserKind = 'default' | 'chrome' | 'edge' | 'brave'

export function browserProcessArguments(port: number, userDataDir: string | undefined, isolated: boolean, profileDirectory?: string): string[] {
  if (isolated && !userDataDir) throw new Error('Isolated browser launch requires a managed profile')
  return [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
    ...(isolated ? ['--disable-sync', '--disable-extensions', '--no-default-browser-check', 'about:blank'] : []),
  ]
}

export interface BrowserLaunchOptions {
  browser?: BrowserKind
  executablePath?: string
}

interface ChromeSession {
  slot?: BrowserSlot
  launchOptions?: BrowserLaunchOptions
  lease?: ChromePortLease
  port: number
  userDataDir: string
  /** PID of the Chrome process we launched, or undefined if we reused an existing one. */
  pid: number | undefined
  /** Whether this session owns the Chrome process (i.e. we launched it). */
  owned: boolean
}

export interface ChromePortLease {
  readonly port: number
  release(): void
}

async function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true))
    })
  })
}

async function dynamicPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a browser debug port')))
        return
      }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

/** One host-owned allocator is shared across projects; leases never share profiles or processes. */
export class ChromePortAllocator {
  private reservations = new Map<number, symbol>()

  constructor(
    private available: (port: number) => Promise<boolean> = canBindPort,
    private allocateDynamicPort: () => Promise<number> = dynamicPort,
  ) {}

  private async tryReserve(port: number): Promise<ChromePortLease | undefined> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid Chrome debug port')
    if (this.reservations.has(port)) return
    const owner = Symbol('chrome-port')
    this.reservations.set(port, owner)
    try {
      if (await this.available(port)) {
        return { port, release: () => { if (this.reservations.get(port) === owner) this.reservations.delete(port) } }
      }
    } catch (error) {
      this.reservations.delete(port)
      throw error
    }
    this.reservations.delete(port)
  }

  async reserve(basePort: number, explicitPort?: number): Promise<ChromePortLease> {
    const first = explicitPort ?? basePort
    if (!Number.isInteger(first) || first < 1 || first > 65535) throw new TypeError('Invalid Chrome debug port')
    const last = explicitPort === undefined ? Math.min(first + 99, 65535) : first
    for (let port = first; port <= last; port++) {
      const lease = await this.tryReserve(port)
      if (lease) return lease
    }
    // Windows may exclude the entire preferred range without any listening process.
    if (explicitPort === undefined) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const lease = await this.tryReserve(await this.allocateDynamicPort())
        if (lease) return lease
      }
    }
    throw new Error('No unreserved Chrome debug port is available')
  }
}

export interface ChromeRuntimeOperations {
  /** Synthetic fixtures may return null to model an absent user profile. */
  getUserDataDir?(executable: string): string | null
  detectChrome(path?: string, browser?: BrowserKind): Promise<string | null>
  isDebugPortActive(port: number): Promise<boolean>
  isProcessAlive(pid: number): boolean | Promise<boolean>
  launchChrome(path: string, port: number, userDataDir: string, signal: AbortSignal, profileDirectory?: string): Promise<{ pid: number } | { error: string }>
  terminateChrome(pid: number): void | Promise<void>
}

export interface ChromeManagerOptions {
  projectId?: string
  portAllocator?: ChromePortAllocator
  /** Injectable process boundary; project ownership checks cannot be overridden. */
  runtime?: ChromeRuntimeOperations
}

export type ChromeAllocation = { port: number; extraArgs: string[] } | { error: string }

interface PendingAllocation {
  operation: Promise<ChromeAllocation>
  launchOptions: BrowserLaunchOptions
  explicitPort?: number
  controller: AbortController
}

function sameLaunchOptions(a: BrowserLaunchOptions, b: BrowserLaunchOptions): boolean {
  return (a.browser ?? 'default') === (b.browser ?? 'default') && a.executablePath === b.executablePath
}

// Files/folders to copy from default profile for credential sharing
const CREDENTIAL_FILES = [
  'Default/Cookies',
  'Default/Login Data',
  'Default/Web Data',
  'Default/Preferences',
  'Default/Secure Preferences',
]
const CREDENTIAL_DIRS = [
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',
  'Default/Network',
]

/**
 * Detect Chrome/Edge/Brave, without falling back from an explicit path or browser.
 * Default detection retains the platform's existing preference order.
 */
export async function detectChrome(configExePath?: string, browser: BrowserKind = 'default'): Promise<string | null> {
  if (!['default', 'chrome', 'edge', 'brave'].includes(browser)) return null
  if (configExePath !== undefined) {
    if (browser !== 'default') return null
    try {
      const stat = await nodeStat(configExePath)
      if (stat.isFile()) return configExePath
    } catch { /* not found */ }
    return null
  }

  const os = getOs()

  if (os === 'windows') {
    const paths = {
      edge: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      chrome: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
      brave: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ],
    }
    const candidates = browser === 'default' ? [...paths.edge, ...paths.chrome, ...paths.brave] : paths[browser]
    for (const candidate of candidates) {
      try {
        const stat = await nodeStat(candidate)
        if (stat.isFile()) return candidate
      } catch { /* not found */ }
    }
  } else if (os === 'darwin') {
    const paths = {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    }
    const candidates = browser === 'default' ? [...paths.chrome, ...paths.edge, ...paths.brave] : paths[browser]
    for (const candidate of candidates) {
      try {
        const stat = await nodeStat(candidate)
        if (stat.isFile()) return candidate
      } catch { /* not found */ }
    }
  } else if (os === 'linux') {
    const names = browser === 'default'
      ? ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge', 'brave-browser', 'brave']
      : {
          chrome: ['google-chrome', 'google-chrome-stable'],
          edge: ['microsoft-edge', 'microsoft-edge-stable'],
          brave: ['brave-browser', 'brave'],
        }[browser]
    for (const name of names) {
      try {
        const output = await new Promise<{ success: boolean; stdout: Buffer }>((resolve) => {
          const proc = childSpawn('which', [name], {
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          const chunks: Buffer[] = []
          proc.stdout?.on('data', (c: Buffer) => chunks.push(c))
          proc.once('error', () => resolve({ success: false, stdout: Buffer.alloc(0) }))
          proc.once('close', (code) => {
            resolve({ success: code === 0, stdout: Buffer.concat(chunks) })
          })
        })
        if (output.success) {
          const path = output.stdout.toString('utf8').trim()
          if (path) return path
        }
      } catch { /* not found */ }
    }
  }

  return null
}

/**
 * Get the default user data directory for the detected browser.
 */
/**
 * Check whether a Chrome debug port is responding.
 */
async function isDebugPortActive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Copy credential files from the default profile to a new user data dir
 * so the new session inherits logins, cookies, etc.
 */
async function copyCredentials(srcUserDataDir: string, dstUserDataDir: string): Promise<void> {
  // Ensure destination Default/ folder exists
  const dstDefault = resolve(dstUserDataDir, 'Default')
  await mkdir(dstDefault, { recursive: true })

  // Copy individual files
  for (const file of CREDENTIAL_FILES) {
    const src = resolve(srcUserDataDir, file)
    const dst = resolve(dstUserDataDir, file)
    try {
      await copyFile(src, dst)
    } catch { /* file may not exist */ }
  }

  // Copy directories recursively
  for (const dir of CREDENTIAL_DIRS) {
    const src = resolve(srcUserDataDir, dir)
    const dst = resolve(dstUserDataDir, dir)
    try {
      const info = await nodeStat(src)
      if (info.isDirectory()) {
        await copyDirRecursive(src, dst)
      }
    } catch { /* dir may not exist */ }
  }

  // Copy Local State (parent level)
  try {
    await copyFile(
      resolve(srcUserDataDir, 'Local State'),
      resolve(dstUserDataDir, 'Local State'),
    )
  } catch { /* may not exist */ }
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name)
    const dstPath = resolve(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, dstPath)
    } else {
      await copyFile(srcPath, dstPath)
    }
  }
}

/**
 * Manages Chrome browser lifecycle for DevTools MCP sessions.
 * Handles auto-detection, port allocation, process launching, and cleanup.
 */
export class ChromeManager {
  private sessions = new Map<string, ChromeSession>()
  private cachedExePath: string | null | undefined = undefined
  private pending = new Map<string, PendingAllocation>()
  private releasing = new Map<string, Promise<void>>()
  private stopped = false
  private controller = new AbortController()
  readonly projectId?: string

  constructor(
    private workspace: string,
    private getConfig: () => ChromeConfig,
    private options: ChromeManagerOptions = {},
  ) {
    this.options = { ...options }
    const scope = getProjectScope()
    this.projectId = options.projectId ?? scope?.projectId
    if (scope && scope.projectId !== this.projectId) throw new Error('Chrome runtime project mismatch')
    if (this.projectId !== undefined && (!this.projectId.trim() || !options.portAllocator)) {
      throw new Error('Project Chrome requires a host-owned port allocator')
    }
  }

  /** Invalidate the cached executable path so the next allocate() re-detects. */
  invalidateCache(): void {
    this.cachedExePath = undefined
  }

  private get config(): ChromeConfig {
    return this.getConfig()
  }

  /**
   * Allocate a Chrome session for the given key.
   * Detects Chrome, picks a free port, creates user-data-dir, launches Chrome if needed.
   * Project launch choices are pinned until release; matching pending callers share cancellation.
   *
   * Returns the allocated port and any extra MCP args to inject, or an error string.
   */
  async allocate(
    sessionKey: string,
    explicitPort?: number,
    explicitUserDataDir?: string,
    launchOptions: BrowserLaunchOptions = {},
    signal?: AbortSignal,
  ): Promise<ChromeAllocation> {
    const choices = { browser: launchOptions.browser ?? 'default', executablePath: launchOptions.executablePath }
    if (!['default', 'chrome', 'edge', 'brave'].includes(choices.browser)) {
      return { error: 'Invalid browser selection' }
    }
    if (choices.executablePath !== undefined && (typeof choices.executablePath !== 'string' || !choices.executablePath.trim())) {
      return { error: 'Browser executablePath must be a nonempty path' }
    }
    if (choices.browser !== 'default' && choices.executablePath !== undefined) {
      return { error: 'Select either a named browser or an executablePath, not both' }
    }
    if (this.projectId === undefined && Object.keys(launchOptions).length > 0) {
      return { error: 'Browser launch options require a project-managed isolated profile' }
    }
    await this.releasing.get(sessionKey)
    if (this.stopped) return { error: 'Chrome manager is stopped' }
    if (signal?.aborted) return { error: 'Chrome allocation cancelled' }
    if (this.projectId !== undefined && explicitUserDataDir !== undefined) {
      return { error: 'Project browser profiles are runtime-managed; explicit user-data-dir is not supported' }
    }
    const pending = this.pending.get(sessionKey)
    const existing = this.sessions.get(sessionKey)
    const pinned = pending?.launchOptions ?? existing?.launchOptions
    if (pinned && !sameLaunchOptions(pinned, choices)) {
      return { error: 'Chrome session already has different browser launch options' }
    }
    if (pending) {
      if (explicitPort !== undefined && pending.explicitPort !== explicitPort) {
        return { error: 'Chrome session already has a pending allocation with a different debug port' }
      }
      return this.awaitAllocation(pending, signal)
    }
    const controller = new AbortController()
    const combinedSignal = AbortSignal.any([this.controller.signal, controller.signal, ...(signal ? [signal] : [])])
    const operation = (this.projectId === undefined
      ? this.allocateLegacy(sessionKey, explicitPort, explicitUserDataDir, combinedSignal)
      : this.allocateIsolated(sessionKey, explicitPort, choices, combinedSignal))
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    const allocation = { operation, launchOptions: choices, explicitPort, controller }
    this.pending.set(sessionKey, allocation)
    void operation.then(() => this.pending.delete(sessionKey), () => this.pending.delete(sessionKey))
    return operation
  }

  private async awaitAllocation(pending: PendingAllocation, signal?: AbortSignal): Promise<ChromeAllocation> {
    const abort = () => pending.controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await pending.operation
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private async allocateIsolated(
    sessionKey: string,
    explicitPort: number | undefined,
    launchOptions: BrowserLaunchOptions,
    signal: AbortSignal,
  ): Promise<ChromeAllocation> {
    const existing = this.sessions.get(sessionKey)
    const active = this.options.runtime?.isDebugPortActive ?? isDebugPortActive
    signal.throwIfAborted()
    if (existing) {
      if (explicitPort !== undefined && explicitPort !== existing.port) {
        return { error: 'Chrome session already owns a different debug port' }
      }
      if (existing.pid !== undefined && await this.isProcessAlive(existing.pid) && await active(existing.port)) {
        signal.throwIfAborted()
        return { port: existing.port, extraArgs: [`--browserUrl=http://127.0.0.1:${existing.port}`] }
      }
      await this.releaseAllocated(sessionKey)
    }
    signal.throwIfAborted()
    const detect = this.options.runtime?.detectChrome ?? detectChrome
    const exePath = launchOptions.executablePath !== undefined
      ? await detect(launchOptions.executablePath)
      : launchOptions.browser !== 'default' && launchOptions.browser !== undefined
        ? await detect(undefined, launchOptions.browser)
        : await this.getExePath()
    signal.throwIfAborted()
    if (!exePath) {
      return { error: launchOptions.executablePath !== undefined
        ? `Selected browser executable not found: ${launchOptions.executablePath}`
        : launchOptions.browser !== 'default'
          ? `Selected browser "${launchOptions.browser}" executable not found`
          : 'Chrome/Edge/Brave executable not found. Configure tools.chrome.executablePath.' }
    }
    let lease: ChromePortLease | undefined
    let slot: BrowserSlot | undefined
    let launchStarted = false
    try {
      lease = await this.options.portAllocator!.reserve(this.config.basePort ?? 9222, explicitPort)
      signal.throwIfAborted()
      if (await active(lease.port)) return { error: 'Reserved Chrome port is occupied; refusing to attach an unowned browser' }
      signal.throwIfAborted()
      const identity = process.platform === 'win32' ? resolve(exePath).toLowerCase() : resolve(exePath)
      slot = await rentBrowserSlot(projectStoragePath(this.workspace, '.browser', 'slots'), this.config.slotCount ?? 3, identity)
      const userDataDir = slot.directory
      let snapshot = { fresh: false, profileDirectory: slot.state.profileDirectory }
      if (!slot.state.initialized) {
        const source = this.options.runtime?.getUserDataDir
          ? this.options.runtime.getUserDataDir(exePath)
          : getDefaultUserDataDir(exePath)
        const copied = source ? await copyUserProfile(source, userDataDir, signal) : { fresh: true, profileDirectory: undefined }
        if (!source) await mkdir(userDataDir, { recursive: true, mode: 0o700 })
        snapshot = { fresh: copied.fresh, profileDirectory: copied.profileDirectory }
        slot.state.initialized = true
        slot.state.profileDirectory = snapshot.profileDirectory
        await slot.save()
      }
      if (snapshot.fresh) console.info('[chrome-manager] No existing user profile found; creating a new independent managed profile')
      signal.throwIfAborted()
      launchStarted = true
      const result = this.options.runtime
        ? await this.options.runtime.launchChrome(exePath, lease.port, userDataDir, signal, snapshot.profileDirectory)
        : await this.launchChrome(exePath, lease.port, userDataDir, signal, snapshot.profileDirectory)
      if ('error' in result) return result
      slot.state.pid = result.pid
      await slot.save()
      const port = lease.port
      this.sessions.set(sessionKey, { port, userDataDir, pid: result.pid, owned: true, lease, launchOptions, slot })
      slot = undefined
      lease = undefined
      if (signal.aborted) {
        await this.releaseAllocated(sessionKey)
        return { error: this.stopped ? 'Chrome manager stopped during allocation' : 'Chrome allocation cancelled' }
      }
      return { port, extraArgs: [`--browserUrl=http://127.0.0.1:${port}`] }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (!launchStarted || !slot) lease?.release()
      // Unknown launch outcomes retain the durable claim: never reuse a possibly live browser.
      if (slot && !launchStarted) await slot.release()
    }
  }

  private async allocateLegacy(
    sessionKey: string,
    explicitPort?: number,
    explicitUserDataDir?: string,
    signal?: AbortSignal,
  ): Promise<ChromeAllocation> {
    signal?.throwIfAborted()
    // Already allocated for this session?
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      // Verify it's still alive
      if (await isDebugPortActive(existing.port)) {
        signal?.throwIfAborted()
        return {
          port: existing.port,
          extraArgs: [`--browserUrl=http://127.0.0.1:${existing.port}`],
        }
      }
      // Dead — clean up and re-allocate
      this.sessions.delete(sessionKey)
    }

    // Detect Chrome executable
    const exePath = await this.getExePath()
    signal?.throwIfAborted()
    if (!exePath) {
      return {
        error:
          'Chrome/Edge/Brave executable not found. ' +
          'Set "tools.chrome.executablePath" in bot.config.json or ask the user for the correct path.',
      }
    }

    // Pick port
    const port = explicitPort ?? await this.findFreePort()

    // Check if this port already has Chrome running
    const alreadyRunning = await isDebugPortActive(port)
    signal?.throwIfAborted()

    let pid: number | undefined
    let owned = false

    if (!alreadyRunning) {
      // Determine user data dir
      let userDataDir = explicitUserDataDir
      if (!userDataDir) {
        if (this.needsIsolatedProfile(port)) {
          // Parallel session — create isolated user data dir with credentials copied
          userDataDir = projectStoragePath(this.workspace, '.browser', `session-${port}`)
          const defaultDir = getDefaultUserDataDir(exePath)
          if (defaultDir) {
            try {
              await copyCredentials(defaultDir, userDataDir)
            } catch (e) {
              console.warn(`[chrome-manager] Failed to copy credentials: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
        // If port is the base port and no explicit dir, let Chrome use its default profile (no --user-data-dir)
      }

      // Launch Chrome
      const launchResult = await this.launchChrome(exePath, port, userDataDir, signal)
      if ('error' in launchResult) {
        return {
          error: `Failed to launch Chrome.\n` +
            `  Executable: ${exePath}\n` +
            `  Port: ${port}\n` +
            `  User data dir: ${userDataDir ?? '(default)'}\n` +
            `  Error: ${launchResult.error}`,
        }
      }
      pid = launchResult.pid
      owned = true
    }

    const session: ChromeSession = {
      port,
      userDataDir: explicitUserDataDir ?? projectStoragePath(this.workspace, '.browser', `session-${port}`),
      pid,
      owned,
    }
    this.sessions.set(sessionKey, session)
    if (signal?.aborted) {
      await this.releaseAllocated(sessionKey)
      return { error: this.stopped ? 'Chrome manager stopped during allocation' : 'Chrome allocation cancelled' }
    }

    return {
      port,
      extraArgs: [`--browserUrl=http://127.0.0.1:${port}`],
    }
  }

  /**
   * Release a Chrome session. If we own the process, kill it.
   */
  async release(sessionKey: string): Promise<void> {
    await this.pending.get(sessionKey)?.operation
    await this.releaseAllocated(sessionKey)
  }

  private releaseAllocated(sessionKey: string): Promise<void> {
    const pending = this.releasing.get(sessionKey)
    if (pending) return pending
    const operation = this.terminateAllocated(sessionKey)
    this.releasing.set(sessionKey, operation)
    void operation.then(() => this.releasing.delete(sessionKey), () => this.releasing.delete(sessionKey))
    return operation
  }

  private async terminateAllocated(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) return

    if (session.owned && session.pid !== undefined) {
      try {
        await this.terminateChrome(session.pid)
        console.info(`[chrome-manager] Sent stop to Chrome process ${session.pid} on port ${session.port}`)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          console.error(`[chrome-manager] Failed to stop owned Chrome process ${session.pid}`, error)
          throw error
        }
      }
    }
    if (session.owned && session.pid !== undefined) {
      const deadline = Date.now() + 3000
      while (await this.isProcessAlive(session.pid)) {
        if (Date.now() >= deadline) throw new Error(`Owned browser ${session.pid} has not exited; slot remains leased`)
        await new Promise(r => setTimeout(r, 50))
      }
    }
    await session.slot?.release()
    this.sessions.delete(sessionKey)
    session.lease?.release()
  }

  /**
   * Release all sessions. Called on shutdown.
   */
  async releaseAll(): Promise<void> {
    this.stopped = true
    this.controller.abort(new Error('Chrome runtime stopped'))
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.operation))
    const outcomes = await Promise.allSettled([...this.sessions.keys()].map((key) => this.release(key)))
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Failed to release owned Chrome sessions')
  }

  private async terminateChrome(pid: number): Promise<void> {
    if (this.options.runtime) await this.options.runtime.terminateChrome(pid)
    else process.kill(pid, 'SIGTERM')
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    if (this.options.runtime) return this.options.runtime.isProcessAlive(pid)
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
      throw error
    }
  }

  /**
   * Get the Chrome executable path, with caching.
   * Does not cache null results so that a config update can fix detection.
   * Invalidates the cache when the config's executablePath changes.
   */
  private async getExePath(): Promise<string | null> {
    const configExe = this.config.executablePath
    if (this.cachedExePath !== undefined) {
      // Invalidate if config changed (user edited bot.config.json)
      if (this._lastConfigExe !== configExe) {
        this.cachedExePath = undefined
      } else {
        return this.cachedExePath
      }
    }
    this._lastConfigExe = configExe
    const detect = this.options.runtime?.detectChrome ?? detectChrome
    let result = await detect(configExe || undefined)
    if (result === null && configExe) {
      console.warn(`[chrome-manager] Configured executablePath "${configExe}" not found, falling back to auto-detect.`)
      result = await detect()
    }
    if (result !== null) {
      this.cachedExePath = result
    }
    // Don't cache null — allow retry after config update
    return result
  }
  private _lastConfigExe: string | undefined = undefined

  /**
   * Find the next free debug port starting from basePort.
   */
  private async findFreePort(): Promise<number> {
    const usedPorts = new Set([...this.sessions.values()].map((s) => s.port))
    let port = this.config.basePort ?? 9222
    while (usedPorts.has(port) || await isDebugPortActive(port)) {
      port++
      if (port > 9300) break // safety limit
    }
    return port
  }

  /**
   * Whether this port needs an isolated profile (i.e. it's not the first/base session).
   */
  private needsIsolatedProfile(port: number): boolean {
    return port !== (this.config.basePort ?? 9222)
  }

  /**
   * Launch a Chrome process with remote debugging enabled.
   */
  private async launchChrome(
    exePath: string,
    port: number,
    userDataDir?: string,
    signal?: AbortSignal,
    profileDirectory?: string,
  ): Promise<{ pid: number } | { error: string }> {
    const args = browserProcessArguments(port, userDataDir, this.projectId !== undefined, profileDirectory)

    console.info(`[chrome-manager] Launching Chrome: ${exePath} ${args.join(' ')}`)

    try {
      signal?.throwIfAborted()
      const proc = childSpawn(exePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let launchError: Error | undefined
      proc.once('error', (error) => { launchError = error })
      const pid = proc.pid
      if (pid === undefined) {
        return { error: 'Chrome failed to start (no PID assigned)' }
      }

      // Buffer stderr in case we need to surface it after timeout.
      const stderrChunks: Buffer[] = []
      proc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

      // Wait for the debug port to become responsive (max ~10s)
      const maxAttempts = 20
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (launchError || signal?.aborted || proc.exitCode !== null || proc.signalCode !== null) {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill()
          return { error: launchError?.message ?? (signal?.aborted ? 'Chrome allocation cancelled or runtime stopped' : 'Chrome process exited before its debug port was ready') }
        }
        if (await isDebugPortActive(port)) {
          // Detach — let Chrome keep running after our process exits
          proc.unref()
          return { pid }
        }
      }

      // Port never became active — surface any stderr output we captured.
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      proc.kill()
      if (stderr.trim()) {
        return { error: `Chrome started but debug port ${port} never responded. Stderr: ${stderr.slice(0, 500)}` }
      }
      return { error: `Chrome started (PID ${pid}) but debug port ${port} never responded within 10s.` }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: msg }
    }
  }
}
