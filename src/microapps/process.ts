import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { terminateProcessTree, type ManagedProcessStatus } from '../execution/processes/manager.ts'
import { localProxyConfiguration } from '../execution/network/proxy.ts'
import type { AppManifest } from './contracts.ts'
import { reserveAppPort } from './ports.ts'

export interface AppProcess {
  child: ChildProcess
  exited: Promise<ManagedProcessStatus>
  origin: string
  error?: string
  stop(): Promise<unknown>
}
export async function startAppProcess(backend: NonNullable<AppManifest['backend']>, directory: string, data: string,
  api: string, token: string, signal: AbortSignal,
  options: { terminate?: typeof terminateProcessTree; onStarted?: (run: AppProcess) => void } = {}): Promise<AppProcess> {
  signal.throwIfAborted()
  const port = await reserveAppPort()
  const temporary = join(directory, '.tmp')
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)) env[key] = value
  }
  Object.assign(env, { SHADOW_APP_PORT: String(port), SHADOW_APP_DATA: data, SHADOW_APP_TEMP: temporary,
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    SHADOW_APP_API: api, SHADOW_APP_TOKEN: token, PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' })
  const args = [join(directory, ...backend.entry.split('/')), ...backend.args]
  if (backend.runtime === 'node') {
    env.ELECTRON_RUN_AS_NODE = '1'
    env.SHADOW_APP_NETWORK_PROXY = JSON.stringify(await localProxyConfiguration(signal))
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    args.unshift('--import', new URL(`../execution/network/proxy-preload.${extension}`, import.meta.url).href)
  }
  signal.throwIfAborted()
  const child = spawn(backend.runtime === 'node' ? process.execPath : 'python',
    args,
    { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  const exited = new Promise<ManagedProcessStatus>(resolve => {
    child.once('close', (code, signal) => resolve({ code: code ?? -1, signal, success: code === 0 && signal === null }))
  })
  // Drain output without persisting potentially sensitive app payloads or credentials.
  child.stdout.resume()
  child.stderr.resume()
  let stopping: Promise<unknown> | undefined
  const run: AppProcess = { child, exited, origin: `http://127.0.0.1:${port}`,
    stop: async () => {
      const pending = stopping ??= (options.terminate ?? terminateProcessTree)(child, exited, true)
      try { return await pending }
      catch (error) { if (stopping === pending) stopping = undefined; throw error }
    } }
  child.once('error', error => { run.error = error.message })
  try {
    options.onStarted?.(run)
    const deadline = Date.now() + 15_000
    let lastProbe = 'Listener not ready'
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (run.error || child.exitCode !== null || child.signalCode !== null) throw new Error(run.error ?? `App backend exited before becoming ready (code ${child.exitCode})`)
      try {
        const response = await fetch(`${run.origin}/health`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
        })
        await response.body?.cancel()
        if (response.ok) return run
        lastProbe = `Health check returned HTTP ${response.status}`
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof TypeError || error instanceof DOMException)) throw error
        lastProbe = error instanceof DOMException ? error.name : 'Health connection failed'
      }
      await delay(100, undefined, { signal })
    }
    throw new Error(`App backend did not serve GET /health successfully within 15 seconds: ${lastProbe}`)
  } catch (error) {
    await run.stop()
    throw error
  }
}
