import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolveRuntimePaths, type RuntimePathsInput } from '../sidecar/runtime-host.js'
import type { DataLayoutProgress } from './data-layout-controller.js'

export function parseMigrationProgress(line: string): DataLayoutProgress | undefined {
  try {
    const v = JSON.parse(line)
    if (v.type !== 'migration-progress' || !['inventory', 'staging', 'publishing', 'complete'].includes(v.phase)
      || !Number.isSafeInteger(v.completed) || v.completed < 0 || !Number.isSafeInteger(v.total) || v.total < 0
      || (v.total > 0 && v.completed > v.total)) return
    return { phase: v.phase, completed: v.completed, total: v.total }
  } catch { return }
}

/** Uses Electron's bundled Node runtime, never a PATH Node or development tsx. */
export function createDataLayoutCommand(input: RuntimePathsInput) {
  const paths = resolveRuntimePaths(input)
  const active = new Set<ChildProcess>()
  let stopping = false
  const run = (root: string, progress: (value: DataLayoutProgress) => void) => new Promise<void>((resolve, reject) => {
    if (stopping) { reject(new Error('Desktop is shutting down')); return }
    const child = spawn(paths.executablePath, [paths.entryPath, 'data-migration', '--data-dir', root, '--copy', '--offline', '--progress'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    active.add(child)
    let pending = '', diagnostics = ''
    child.stdout?.resume()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      pending += String(chunk)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      if (pending.length > 65536) pending = pending.slice(-65536)
      for (const line of lines) {
        const event = parseMigrationProgress(line)
        if (event) progress(event)
        else diagnostics = (diagnostics + line + '\n').slice(-8192)
      }
    })
    child.once('error', () => reject(new Error('Could not start the bundled upgrade backend. Check the desktop installation.')))
    child.once('close', code => {
      active.delete(child)
      if (pending && !parseMigrationProgress(pending)) diagnostics = (diagnostics + pending).slice(-8192)
      if (code === 0) resolve()
      else reject(new Error(`Upgrade stopped (exit ${code ?? 'unknown'}). ${diagnostics.trim()} Keep writers stopped. See docs/data-migration.md for receipt, lock and rollback recovery; nothing is reset automatically.`))
    })
  })
  return Object.assign(run, { async stop() {
    stopping = true
    await Promise.all([...active].map(async child => { const closed = once(child, 'close').catch(() => {}); child.kill(); await closed }))
  } })
}
