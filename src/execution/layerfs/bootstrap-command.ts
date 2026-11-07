import { spawn, type ChildProcess } from 'node:child_process'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'

export interface BootstrapCommand { file: string; args: string[]; input?: string; timeoutMs: number }
export interface BootstrapDiagnostic {
  reason: 'exit' | 'timeout' | 'cancelled' | 'spawn_error' | 'stdin_error' | 'signal'
  timeoutMs: number; elapsedMs: number; exitCode: number | null; signal: string | null
  launcherExited: boolean; launcherPid?: number; osCode?: string
}
export interface BootstrapReceipt { stdout: Buffer; stderr: Buffer; code: number; diagnostic?: BootstrapDiagnostic }
export type BootstrapRun = (command: BootstrapCommand, signal: AbortSignal) => Promise<BootstrapReceipt>

/** Buffers stay private; only bounded, validated metadata appears in tool errors/status. */
export class BootstrapCommandError extends ToolOutcomeUnknownError {
  constructor(readonly diagnostic: BootstrapDiagnostic, readonly stdout: Buffer, readonly stderr: Buffer) {
    super(`LayerFS command ${diagnostic.reason} after ${diagnostic.elapsedMs} ms (budget ${diagnostic.timeoutMs} ms, launcher exited: ${diagnostic.launcherExited}). Linux work may continue; inspect retained diagnostics before recovery.`)
  }
}

/** No shell interpolation or automatic retries. Killing wsl.exe does not kill its Linux work. */
export function createBootstrapRunner(options: { launch?: typeof spawn; killGraceMs?: number } = {}): BootstrapRun {
  return (command, signal) => {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const started = Date.now(), input = command.input !== undefined
      // wslpath/true/list have no input. Do not pipe/end an empty payload into a closed stdin.
      let child: ChildProcess
      try {
        child = (options.launch ?? spawn)(command.file, command.args, {
          windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        reject(new BootstrapCommandError({ reason: 'spawn_error', timeoutMs: command.timeoutMs, elapsedMs: Date.now() - started,
          exitCode: null, signal: null, launcherExited: true, ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { osCode: code } : {}) }, Buffer.alloc(0), Buffer.alloc(0)))
        return
      }
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), done = false
      let reason: BootstrapDiagnostic['reason'] | undefined, osCode: string | undefined
      let grace: ReturnType<typeof setTimeout> | undefined
      const capture = (prior: Buffer, chunk: Buffer) => Buffer.concat([prior, chunk]).subarray(-65536)
      child.stdout!.on('data', chunk => { stdout = capture(stdout, Buffer.from(chunk)) })
      child.stderr!.on('data', chunk => { stderr = capture(stderr, Buffer.from(chunk)) })
      const finish = (code: number | null, termination: NodeJS.Signals | null, exited: boolean) => {
        if (done) return
        done = true; clearTimeout(timer); clearTimeout(grace); signal.removeEventListener('abort', abort)
        const diagnostic: BootstrapDiagnostic = { reason: reason ?? (termination || code === null ? 'signal' : 'exit'),
          timeoutMs: command.timeoutMs, elapsedMs: Date.now() - started, exitCode: code, signal: termination,
          launcherExited: exited, ...(child.pid ? { launcherPid: child.pid } : {}), ...(osCode ? { osCode } : {}) }
        if (diagnostic.reason === 'exit' && code !== null) resolve({ stdout, stderr, code, diagnostic })
        else reject(new BootstrapCommandError(diagnostic, stdout, stderr))
      }
      const terminate = (cause: BootstrapDiagnostic['reason']) => {
        if (done || reason) return
        reason = cause
        // Do not hang cancellation forever if the host launcher fails to acknowledge termination.
        grace = setTimeout(() => {
          finish(null, null, false)
          child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref()
        }, options.killGraceMs ?? 5000)
        try { child.kill() } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) osCode = code
        }
      }
      const abort = () => terminate('cancelled')
      const timer = setTimeout(() => terminate('timeout'), command.timeoutMs)
      child.once('error', error => {
        const code = (error as NodeJS.ErrnoException).code
        if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) osCode = code
        if (!child.pid) { reason ??= 'spawn_error'; finish(null, null, true) }
        else terminate('spawn_error')
      })
      child.once('close', (code, termination) => finish(code, termination, true))
      if (input) {
        child.stdin!.on('error', error => {
          const code = (error as NodeJS.ErrnoException).code
          if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) osCode = code
          terminate('stdin_error')
        })
      }
      signal.addEventListener('abort', abort, { once: true })
      if (input) child.stdin!.end(command.input)
      if (signal.aborted) abort()
    })
  }
}
export const runBootstrapCommand = createBootstrapRunner()
