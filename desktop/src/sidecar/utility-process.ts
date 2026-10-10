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
    const [entry, ...argv] = args
    if (!entry) throw new Error('Backend entry path is required')
    const env = { ...options.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = fork(entry, argv, {
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
