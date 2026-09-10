import { resolve } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { copyFile, mkdir, readdir, stat as nodeStat } from 'node:fs/promises'
import process from 'node:process'
import { env } from 'node:process'
import { getOs } from './runtime.ts'
import type { z } from 'zod'
import type { ChromeToolSchema } from '../config/schema.ts'

type ChromeConfig = z.infer<typeof ChromeToolSchema>

interface ChromeSession {
  port: number
  userDataDir: string
  /** PID of the Chrome process we launched, or undefined if we reused an existing one. */
  pid: number | undefined
  /** Whether this session owns the Chrome process (i.e. we launched it). */
  owned: boolean
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
 * Detect the default Chrome/Edge/Brave executable path.
 * Returns the first path found, or null if none detected.
 */
export async function detectChrome(configExePath?: string): Promise<string | null> {
  // Use configured path if provided
  if (configExePath) {
    try {
      const stat = await nodeStat(configExePath)
      if (stat.isFile()) return configExePath
    } catch { /* fall through to auto-detect */ }
    console.warn(`[chrome-manager] Configured executablePath "${configExePath}" not found, falling back to auto-detect.`)
  }

  const os = getOs()

  if (os === 'windows') {
    const candidates = [
      // Edge
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      // Chrome
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      // Brave
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]
    for (const candidate of candidates) {
      try {
        const stat = await nodeStat(candidate)
        if (stat.isFile()) return candidate
      } catch { /* not found */ }
    }
  } else if (os === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    for (const candidate of candidates) {
      try {
        const stat = await nodeStat(candidate)
        if (stat.isFile()) return candidate
      } catch { /* not found */ }
    }
  } else if (os === 'linux') {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge']
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
function getDefaultUserDataDir(exePath: string): string | null {
  const os = getOs()
  const lower = exePath.toLowerCase()

  if (os === 'windows') {
    const localAppData = env.LOCALAPPDATA
    if (!localAppData) return null
    if (lower.includes('edge')) return resolve(localAppData, 'Microsoft', 'Edge', 'User Data')
    if (lower.includes('brave')) return resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data')
    if (lower.includes('chrome')) return resolve(localAppData, 'Google', 'Chrome', 'User Data')
  } else if (os === 'darwin') {
    const home = env.HOME
    if (!home) return null
    if (lower.includes('edge')) return resolve(home, 'Library/Application Support/Microsoft Edge')
    if (lower.includes('brave')) return resolve(home, 'Library/Application Support/BraveSoftware/Brave-Browser')
    if (lower.includes('chrome')) return resolve(home, 'Library/Application Support/Google/Chrome')
  } else if (os === 'linux') {
    const home = env.HOME
    if (!home) return null
    if (lower.includes('edge')) return resolve(home, '.config/microsoft-edge')
    if (lower.includes('brave')) return resolve(home, '.config/BraveSoftware/Brave-Browser')
    return resolve(home, '.config/google-chrome')
  }

  return null
}

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

  constructor(
    private workspace: string,
    private getConfig: () => ChromeConfig,
  ) {}

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
   *
   * Returns the allocated port and any extra MCP args to inject, or an error string.
   */
  async allocate(
    sessionKey: string,
    explicitPort?: number,
    explicitUserDataDir?: string,
  ): Promise<{ port: number; extraArgs: string[] } | { error: string }> {
    // Already allocated for this session?
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      // Verify it's still alive
      if (await isDebugPortActive(existing.port)) {
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

    let pid: number | undefined
    let owned = false

    if (!alreadyRunning) {
      // Determine user data dir
      let userDataDir = explicitUserDataDir
      if (!userDataDir) {
        if (this.needsIsolatedProfile(port)) {
          // Parallel session — create isolated user data dir with credentials copied
          userDataDir = resolve(this.workspace, '.browser', `session-${port}`)
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
      const launchResult = await this.launchChrome(exePath, port, userDataDir)
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
      userDataDir: explicitUserDataDir ?? resolve(this.workspace, '.browser', `session-${port}`),
      pid,
      owned,
    }
    this.sessions.set(sessionKey, session)

    return {
      port,
      extraArgs: [`--browserUrl=http://127.0.0.1:${port}`],
    }
  }

  /**
   * Release a Chrome session. If we own the process, kill it.
   */
  async release(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    this.sessions.delete(sessionKey)

    if (session.owned && session.pid !== undefined) {
      try {
        process.kill(session.pid, 'SIGTERM')
        console.info(`[chrome-manager] Killed Chrome process ${session.pid} on port ${session.port}`)
      } catch {
        // Process may have already exited
      }
    }
  }

  /**
   * Release all sessions. Called on shutdown.
   */
  async releaseAll(): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      await this.release(key)
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
    const result = await detectChrome(configExe)
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
  ): Promise<{ pid: number } | { error: string }> {
    const args = [
      `--remote-debugging-port=${port}`,
      '--no-first-run',
    ]
    if (userDataDir) {
      args.push(`--user-data-dir=${userDataDir}`)
    }

    console.info(`[chrome-manager] Launching Chrome: ${exePath} ${args.join(' ')}`)

    try {
      // Spawn detached so the Chrome process survives independently of the
      // parent — we only need the PID for tracking; output is throwaway.
      const proc = childSpawn(exePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
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
        if (await isDebugPortActive(port)) {
          // Detach — let Chrome keep running after our process exits
          proc.unref()
          return { pid }
        }
      }

      // Port never became active — surface any stderr output we captured.
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
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
