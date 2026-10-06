import {
  type ChildProcess,
  spawn as childSpawn,
  execFile,
  type SpawnOptions,
} from 'node:child_process'
import { env as sysEnv } from 'node:process'
import {
  buildShellArgs,
  defaultManagedShell,
  type ManagedShell,
  needsMsys2Shell,
  resolveExecShell,
} from './shells.ts'
import { isWindows } from '../../utils/runtime.ts'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { spawnGuardedProcess, type GuardianResult, type ProcessSupervision } from './guardian.ts'

/**
 * Final exit status of a managed process.
 */
export interface ManagedProcessStatus {
  success: boolean
  code: number
  signal: NodeJS.Signals | null
  guardian?: GuardianResult
}

/**
 * Managed process state.
 * stdout/stderr are streamed into growing chunk arrays in the background so
 * callers can read partial output at any point in time without blocking the
 * process itself.
 */
export interface ManagedProcess {
  /** Dedicated POSIX process group, owned by an awaited foreground operation. */
  isolated?: boolean
  pid: number
  command: string
  cwd: string
  shell: ManagedShell
  startedAt: Date
  /** Internal child process handle. */
  process: ChildProcess
  /** Accumulated stdout chunks (appended by background reader). */
  stdoutChunks: Uint8Array[]
  /** Accumulated stderr chunks (appended by background reader). */
  stderrChunks: Uint8Array[]
  /**
   * Resolves when the process exits AND both streams have been fully drained.
   */
  exitPromise: Promise<ManagedProcessStatus>
  /** Set once the process has exited. */
  exitedAt?: Date
  exitCode?: number
  terminate?: () => Promise<ManagedProcessStatus>
}

/**
 * Global store of all spawned managed processes, shared by `ExecTool`
 * and the background-task tracking flow.
 */
export class ProcessManager {
  private processes = new Map<number, ManagedProcess>()

  /**
   * Spawn a shell command, register it as a managed process, and start
   * collecting its output in background tasks.
   *
   * Returns the `ManagedProcess` immediately – the process has already been
   * started.
   */
  async spawn(
    script: string,
    cwd: string,
    env?: Record<string, string>,
    shell: ManagedShell = defaultManagedShell(),
    args: string[] = [],
    options: { isolated?: boolean; signal?: AbortSignal; supervision?: ProcessSupervision } = {},
  ): Promise<ManagedProcess> {
    options.signal?.throwIfAborted()
    // Auto-escalate from cmd to sh when MSYS2 tools are detected.
    // MSYS2 binaries (grep, sed, …) require a proper cygwin context which
    // only msys/bash provides – cmd-spawned MSYS2 processes hang silently.
    let effectiveShell: ManagedShell = shell
    if (isWindows && shell === 'cmd' && needsMsys2Shell(script)) {
      const shShell = await resolveExecShell('sh')
      if (shShell) {
        effectiveShell = 'sh'
      }
    }

    const resolvedShell = await resolveExecShell(effectiveShell)
    if (!resolvedShell) {
      throw new Error(
        `Shell "${effectiveShell}" is not available on this machine`,
      )
    }
    options.signal?.throwIfAborted()

    const shellArgs = buildShellArgs(resolvedShell.name, script, args)

    // For cmd on Windows, use windowsVerbatimArguments to prevent Node from
    // escaping double quotes (\" is not valid cmd syntax). Combined with
    // /d /s /c "script" in buildShellArgs, this preserves quotes as-is.
    const useVerbatimArgs = isWindows && effectiveShell === 'cmd'

    // Treat `env` as overrides layered on top of the inherited process
    // environment. Node's spawn REPLACES the child env entirely when `env`
    // is set, so passing only the workspace `.env` would strip PATH (and
    // SystemRoot/PATHEXT, …) – breaking even built-in lookups like
    // `chcp.com` in System32. Merge to preserve the full environment.
    const spawnEnv = env ? { ...sysEnv, ...env } : undefined

    if (options.supervision) {
      const guarded = await spawnGuardedProcess({
        ...options.supervision, command: resolvedShell.command, args: shellArgs, cwd,
        env: spawnEnv ?? sysEnv, windowsVerbatimArguments: useVerbatimArgs,
      }, options.signal)
      const managed: ManagedProcess = {
        ...guarded, isolated: true, command: script, cwd, shell, startedAt: new Date(),
      }
      managed.exitPromise = guarded.exitPromise.then(status => {
        managed.exitedAt = new Date()
        managed.exitCode = status.code
        return status
      })
      this.processes.set(managed.pid, managed)
      return managed
    }

    const spawnOpts: SpawnOptions = {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(useVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
      ...(options.isolated ? { detached: !isWindows, windowsHide: true } : {}),
    }

    const proc = childSpawn(resolvedShell.command, shellArgs, spawnOpts)

    if (proc.pid === undefined) {
      // pid is set synchronously on success; undefined means the spawn failed
      // before the process was created (e.g. ENOENT). Surface a real error so
      // the caller can report it instead of registering a half-dead entry.
      const err = await new Promise<Error>((resolve) => {
        proc.once('error', resolve)
        // Fallback in case 'error' never fires
        setTimeout(() => resolve(new Error('spawn failed (no PID assigned)')), 1000)
      })
      throw err
    }

    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []

    // Drain both streams in background so the OS pipe buffer never fills up
    const stdoutDone = drainStream(proc.stdout, stdoutChunks)
    const stderrDone = drainStream(proc.stderr, stderrChunks)

    const exitPromise = new Promise<ManagedProcessStatus>((resolve) => {
      proc.once('close', (code, signal) => {
        Promise.all([stdoutDone, stderrDone]).then(() => {
          const exitCode = code ?? -1
          const status: ManagedProcessStatus = {
            success: code === 0 && signal === null,
            code: exitCode,
            signal,
          }
          managed.exitedAt = new Date()
          managed.exitCode = exitCode
          resolve(status)
        })
      })
    })

    const managed: ManagedProcess = {
      ...(options.isolated ? { isolated: true } : {}),
      pid: proc.pid,
      command: script,
      cwd,
      shell,
      startedAt: new Date(),
      process: proc,
      stdoutChunks,
      stderrChunks,
      exitPromise,
    }

    this.processes.set(proc.pid, managed)
    return managed
  }

  get(pid: number): ManagedProcess | undefined {
    return this.processes.get(pid)
  }

  list(): ManagedProcess[] {
    return Array.from(this.processes.values())
  }

  /** Remove a process entry (call after it has exited and output is consumed). */
  remove(pid: number): void {
    this.processes.delete(pid)
  }

  async terminate(managed: ManagedProcess): Promise<ManagedProcessStatus> {
    const status = await (managed.terminate?.() ?? terminateProcessTree(managed.process, managed.exitPromise, managed.isolated))
    this.remove(managed.pid)
    return status
  }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** Terminate only the owned PID/tree and wait for exit and pipe drainage. */
export async function terminateProcessTree(
  child: ChildProcess,
  exit: Promise<ManagedProcessStatus>,
  isolated = false,
): Promise<ManagedProcessStatus> {
  let terminationError: unknown
  const closed = () => (child.exitCode !== null || child.signalCode !== null)
    && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)
  // A closed foreground shell can still leave children with redirected stdio.
  if (child.pid !== undefined && (!closed() || (isolated && !isWindows))) {
    if (isWindows) {
      try {
        await promisify(execFile)(
          join(sysEnv.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 },
        )
      } catch (error) {
        terminationError = error
      }
    } else {
      try {
        process.kill(isolated ? -child.pid : child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Process PID=${child.pid} did not close after termination`,
          terminationError === undefined ? undefined : { cause: terminationError })), 5000)
      }),
    ])
    if (terminationError !== undefined) {
      if (!closed()) throw new Error(`Process PID=${child.pid} has not exited and drained`, { cause: terminationError })
      console.warn(`[processes] Termination command failed for PID=${child.pid}, but its owned process exited and output drained.`)
    }
    return status
  } finally { clearTimeout(timer) }
}

/** Read all chunks from a Node Readable stream into `out` in the background. */
async function drainStream(
  stream: NodeJS.ReadableStream | null,
  out: Uint8Array[],
): Promise<void> {
  if (!stream) return
  try {
    for await (const chunk of stream) {
      // Node's Readable yields Buffer (which extends Uint8Array) by default.
      out.push(chunk as Uint8Array)
    }
  } catch {
    // Stream may close abruptly if the process is killed – ignore
  }
}

/** Format elapsed milliseconds as a human-readable string. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s}s`
}
