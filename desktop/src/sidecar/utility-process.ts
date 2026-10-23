import { isDevelopmentRestartMessage } from '../development-restart.js'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import type { ForkOptions } from 'electron'
import type { SidecarChildProcess, SidecarSpawn } from './supervisor.js'

interface UtilityChild {
  readonly pid: number | undefined
  readonly stdout: SidecarChildProcess['stdout']
  readonly stderr: SidecarChildProcess['stderr']
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'error', listener: () => void): unknown
  kill(): boolean
}

type UtilityFork = (modulePath: string, args: string[], options: ForkOptions) => UtilityChild

/** Keep readiness and authenticated shutdown shared with the CLI supervisor. */
export function createUtilityProcessSpawn(
  fork: UtilityFork,
  forceKill: (pid: number) => boolean = pid => process.kill(pid, 'SIGKILL'),
  developmentRestart?: () => void,
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
    // Node spawn accepts undefined entries, but Electron utilityProcess.fork
    // rejects them synchronously (notably Child's absent Main media key).
    const env = Object.fromEntries(Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.ELECTRON_RUN_AS_NODE
    // Never inherit availability from a shell or a packaged parent's environment.
    delete env.SHADOW_DEV_RESTART_TOOL
    const restart = env.SHADOW_DESKTOP_DEV_IPC === '1' && env.NODE_ENV !== 'production' ? developmentRestart : undefined
    if (restart) env.SHADOW_DEV_RESTART_TOOL = '1'
    const child = fork(preloads.length ? fileURLToPath(new URL('./utility-profile-bootstrap.js', import.meta.url)) : entry,
      preloads.length ? [JSON.stringify(preloads), entry, ...argv] : argv, {
      env,
      stdio: 'pipe',
      serviceName: 'Shadow Backend',
    })
    if (restart) child.on('message', message => {
      if (isDevelopmentRestartMessage(message)) restart()
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
