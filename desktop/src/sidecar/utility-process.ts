import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import type { ForkOptions } from 'electron'
import type { SidecarChildProcess, SidecarSpawn } from './supervisor.js'

interface UtilityChild {
  readonly pid: number | undefined
  readonly stdout: SidecarChildProcess['stdout']
  readonly stderr: SidecarChildProcess['stderr']
  once(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'error', listener: () => void): unknown
  kill(): boolean
}

type UtilityFork = (modulePath: string, args: string[], options: ForkOptions) => UtilityChild

/** Keep readiness and authenticated shutdown shared with the CLI supervisor. */
export function createUtilityProcessSpawn(
  fork: UtilityFork,
  forceKill: (pid: number) => boolean = pid => process.kill(pid, 'SIGKILL'),
): SidecarSpawn {
  return (_executablePath, args, options) => {
    // Electron utility processes ignore Node preload execArgv. Use an explicit
    // bootstrap only for the supervisor's profiling prefix; normal launches
    // retain their original entry and application arguments.
    const argv = [...args]
    const preloads: string[] = []
    while (argv[0] === '--import') {
      argv.shift()
      const preload = argv.shift()
      if (!preload || preload.startsWith('-')) throw new Error('Backend preload path is required')
      preloads.push(preload)
    }
    const entry = argv.shift()
    if (!entry || entry.startsWith('-')) throw new Error('Backend entry path is required')
    const env = { ...options.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = fork(preloads.length ? fileURLToPath(new URL('./utility-profile-bootstrap.js', import.meta.url)) : entry,
      preloads.length ? [JSON.stringify(preloads), entry, ...argv] : argv, {
      env,
      stdio: 'pipe',
      serviceName: 'Shadow Backend',
    })
    const events = new EventEmitter()
    child.once('error', () => events.emit('error', new Error('Backend utility process failed')))
    child.once('exit', code => events.emit('exit', code, null))
    return Object.assign(events, {
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (signal?: NodeJS.Signals) => {
        // UtilityProcess.kill only sends SIGTERM on POSIX; preserve the forced-stop deadline.
        if (signal !== 'SIGKILL') return child.kill()
        const pid = child.pid
        if (pid === undefined) return false
        try { return forceKill(pid) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      },
    }) satisfies SidecarChildProcess
  }
}
