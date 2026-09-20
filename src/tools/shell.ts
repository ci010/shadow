import type { ExecutionContext } from './context.ts'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  formatElapsed,
  type ManagedProcessStatus,
  type ManagedProcess,
  type ProcessManager,
} from '../execution/processes/manager.ts'
import {
  defaultManagedShell,
  type ManagedShell,
  resolveExecShell,
} from '../execution/processes/shells.ts'
import type { CommandHandlerManager } from './shell-commands/command-handler.ts'
import { bindScriptTools } from '../script-runtime/bridge.ts'
import { startScript, type ScriptRun } from '../script-runtime/runtime.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { errMsg } from '../utils/truncate.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import { loadDotEnv } from '../utils/env.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import type { LocalProcessExecutor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { MAX_CALL_TIMEOUT_MS } from '../sessions/execution-scope.ts'
import { executeRemoteShell } from '../execution/remote-shell-client.ts'

async function waitForExit<T>(
  exit: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      exit.then((status) => ({ status })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
      new Promise<never>((_, reject) => {
        if (!signal) return
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs\./,
  /dd\s+if=/,
  /:(){ :|:& };:/,
]

export type ExecShell = ManagedShell | 'node'

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function parseExecShell(
  value: unknown,
  fallback: ExecShell = defaultManagedShell(),
): ExecShell | null {
  if (value === undefined) return fallback
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'cmd' ||
    normalized === 'sh' ||
    normalized === 'bash' ||
    normalized === 'git-bash' ||
    normalized === 'powershell' ||
    normalized === 'pwsh' ||
    normalized === 'node'
  ) {
    return normalized
  }
  return null
}

/**
 * Execute a script via a selected runtime.
 *
 * For OS shells, the tool spawns a managed process. If `timeout_ms` is provided
 * the tool waits up to that many
 * milliseconds:
 *   – process exits within the window → full output + exit code
 *   – timeout reached while still running → partial output collected so far,
 *     elapsed time, and a note that the process is still running (it is NOT
 *     killed; use background-task tools to follow up).
 * For `shell=node`, the script is treated as inline TypeScript and executed
 * by the shared script worker with privileged host imports and session tool RPC.
 * Leaf calls instead require a positive timeout (default/max 120 seconds),
 * terminate owned foreground work on timeout/abort, and never register callbacks.
 */
export class ExecTool implements Tool {
  readonly name = 'exec'
  readonly supportsRemoteWorkdir = true
  readonly description =
    'Run a command or script. Use `shell: "node"` for inline TypeScript with tool access.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'Script to run. For OS shells this is the command string; for `shell=node` this is inline TypeScript source.',
      },
      shell: {
        type: 'string',
        description: 'Runtime: OS shell name or `node` for inline TypeScript.',
      },
      args: {
        type: 'array',
        description: 'Additional arguments passed to the script.',
        items: { type: 'string' },
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
      timeout_ms: {
        type: 'number',
        description:
          'Max wait time in milliseconds. 0 = run in background (fire-and-forget). ' +
          'Omit for default (120s). The process is NOT killed on timeout.',
      },
    },
    required: ['script'],
  }

  private localExecutor: LocalProcessExecutor

  constructor(
    private workspace: string,
    private _defaultTimeoutMs = 120_000,
    private commandHandler: CommandHandlerManager,
    private processManager: ProcessManager,
    private defaultShell: ExecShell = defaultManagedShell(),
    private backgroundTasks: BackgroundTaskManager,
    localExecutor?: LocalProcessExecutor,
  ) {
    this.workspace = resolve(workspace)
    this.localExecutor = localExecutor ?? new LocalExecutor(processManager)
  }

  private formatManagedProcessOutput(
    stdoutChunks: Uint8Array[],
    stderrChunks: Uint8Array[],
    exitCode: number,
    success: boolean,
    shell?: ManagedShell,
  ): string {
    const stdout = decodeChunks(stdoutChunks, shell)
    const stderr = decodeChunks(stderrChunks, shell)
    let output = ''
    if (stdout) output += stdout
    if (stderr) output += `\n[stderr]\n${stderr}`
    if (!output.trim() && !success) {
      output = `Error: command exited with code ${exitCode}`
    }
    return output || `(no output, exit code ${exitCode})`
  }

  private registerBackgroundProcessTask(
    context: ExecutionContext,
    managed: {
      pid: number
      command: string
      shell?: ManagedShell
      stdoutChunks: Uint8Array[]
      stderrChunks: Uint8Array[]
      exitPromise: Promise<ManagedProcessStatus>
    },
  ): string | null {
    return this.backgroundTasks.runPromiseTask(
      {
        kind: 'process',
        title: `exec: ${managed.command.slice(0, 80)}`,
        sessionId: context.sessionId,
        inputId: context.messageId,
        callback: {
          sessionId: context.sessionId,
          replyTo: { channel: context.channel, chatId: context.chatId },
          isGroup: context.isGroup,
          senderName: 'Background Task',
        },
        observe: () => {
          const stdout = decodeChunks(managed.stdoutChunks, managed.shell)
          const stderr = decodeChunks(managed.stderrChunks, managed.shell)
          let output = ''
          if (stdout) output += stdout
          if (stderr) output += `\n[stderr]\n${stderr}`
          return output.trim() || '(no output yet)'
        },
      },
      managed.exitPromise.then((status) =>
        this.formatManagedProcessOutput(
          managed.stdoutChunks,
          managed.stderrChunks,
          status.code,
          status.success,
          managed.shell,
        )
      ),
    )
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const shell = parseExecShell(args.shell, this.defaultShell) ??
      this.defaultShell
    const script = String(args.script)
    return `💻 [${shell}] ${script}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const foreground = context.tools?.executionMode === 'call'
    if (context.remoteWorkdir) {
      const reason = 'exec cannot enforce a foreground process lifecycle on remote workdirs.'
      if (foreground) return context.tools.rejectExecution(reason)
      context.signal.throwIfAborted()
      if (typeof args.shell === 'string' && args.shell.trim().toLowerCase() === 'node') {
        return 'Error: shell=node and its inline tool bridge are not supported on remote workdirs.'
      }
      if (DANGEROUS_PATTERNS.some(pattern => pattern.test(String(args.script)))) {
        return 'Error: command blocked by safety filter'
      }
      try {
        // Do not resolve cwd, shells, dotenv, or command interceptors on Main.
        const output = await executeRemoteShell({
          ...context.remoteWorkdir,
          sessionId: context.sessionId,
          turnId: context.messageId ?? context.sessionId,
          signal: context.signal,
        }, {
          script: args.script,
          ...(args.shell === undefined ? {} : { shell: parseExecShell(args.shell) }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.args === undefined ? {} : { args: args.args }),
        }, args.timeout_ms === undefined ? this._defaultTimeoutMs : args.timeout_ms as number)
        context.signal.throwIfAborted()
        return output
      } catch (error) {
        context.signal.throwIfAborted()
        return `Error: ${errMsg(error)}`
      }
    }
    if (foreground) {
      context.signal.throwIfAborted()
      const denied = context.tools.executionDenial('exec', args)
      if (denied) return denied
      return context.tools.runForeground(context.signal, (signal, cancel) =>
        this.executeRequest(args, { ...context, signal }, true, cancel))
    }
    return this.executeRequest(args, context, false)
  }

  private async executeRequest(
    args: Record<string, unknown>,
    context: ExecutionContext,
    foreground: boolean,
    cancel: () => void = () => {},
  ): Promise<string> {
    if (foreground) context.signal.throwIfAborted()
    const script = typeof args.script === 'string' ? args.script : ''
    if (!script.trim()) {
      return 'Error: `script` is required'
    }

    const shell = parseExecShell(
      args.shell,
      context.defaultExecShell ?? this.defaultShell,
    )
    if (!shell) {
      return 'Error: invalid `shell`. Supported values include `cmd`, `sh`, `bash`, `git-bash`, `powershell`, `pwsh`, and `node`'
    }

    const scriptArgs = parseStringArray(args.args)
    const base = context.cwd ?? this.workspace
    const cwd = args.cwd
      ? resolveAgentPath(this.workspace, base, String(args.cwd))
      : base
    const timeoutMs = args.timeout_ms !== undefined
      ? Number(args.timeout_ms)
      : foreground ? MAX_CALL_TIMEOUT_MS : this._defaultTimeoutMs

    if (shell === 'node') {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
        return 'Error: `timeout_ms` must be a finite non-negative integer no greater than 2147483647'
      }
      return this.executeNodeScript(script, scriptArgs, cwd, timeoutMs, context, foreground, cancel)
    }

    const resolvedShell = await resolveExecShell(shell)
    if (!resolvedShell) {
      return `Error: shell \`${shell}\` is not available on this machine`
    }

    const intercepted = await this.intercept(
      script,
      cwd,
      context,
    )
    if (intercepted !== null) return intercepted

    // Safety filter
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(script)) {
        return `Error: command blocked by safety filter`
      }
    }

    // Load workspace .env and forward to subprocess
    const dotEnv = await loadDotEnv(this.workspace)
    if (foreground) context.signal.throwIfAborted()

    // Spawn
    let managed
    try {
      managed = timeoutMs === 0
        ? await this.processManager.spawn(
          script,
          cwd,
          dotEnv,
          shell,
          scriptArgs,
        )
        : await this.localExecutor.startProcess({
          script,
          cwd,
          env: dotEnv,
          shell,
          args: scriptArgs,
        }, foreground ? { isolated: true, signal: context.signal } : undefined)
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    if (foreground) return this.executeForegroundProcess(managed, timeoutMs, context, cancel)
    const { pid } = managed

    // Fire-and-forget: return PID immediately
    if (timeoutMs === 0) {
      const taskId = this.registerBackgroundProcessTask(
        context,
        managed,
      )
      const lines = [`Process started. PID=${pid}`]
      if (taskId) lines.push(`Background task ID: ${taskId}`)
      lines.push(
        'Use `kill` tool to cancel if needed.',
      )
      return lines.join('\n')
    }

    // Wait up to timeout_ms (also abort-aware)
    const startedAt = Date.now()
    const result = await waitForExit(managed.exitPromise, timeoutMs, context.signal)

    const elapsed = Date.now() - startedAt

    if (result === null) {
      // Still running – return whatever partial output was collected
      const stdout = decodeChunks(managed.stdoutChunks, managed.shell)
      const stderr = decodeChunks(managed.stderrChunks, managed.shell)
      let partial = ''
      if (stdout) partial += stdout
      if (stderr) partial += `\n[stderr]\n${stderr}`
      partial = partial.trim()

      const header =
        `Process PID=${pid} still running after ${formatElapsed(elapsed)}. ` +
        `Output collected so far (may be incomplete):`
      const taskId = this.registerBackgroundProcessTask(
        context,
        managed,
      )
      const body = partial
        ? `${header}\n${partial}`
        : `${header}\n(no output yet)`
      return taskId ? `${body}\n\nBackground task ID: ${taskId}\n` : body
    }

    // Process finished within the timeout window
    return this.formatManagedProcessOutput(
      managed.stdoutChunks,
      managed.stderrChunks,
      result.status.code,
      result.status.success,
      managed.shell,
    )
  }

  private async cleanupForeground(
    context: ExecutionContext,
    cleanup: () => Promise<ManagedProcessStatus>,
  ): Promise<ManagedProcessStatus> {
    try { return await cleanup() }
    catch (error) {
      context.tools.rejectExecution(`Foreground process cleanup failed: ${errMsg(error)}`)
      throw error
    }
  }

  private async executeForegroundProcess(
    managed: ManagedProcess,
    timeoutMs: number,
    context: ExecutionContext,
    cancel: () => void,
  ): Promise<string> {
    let cleanup: Promise<ManagedProcessStatus> | undefined
    const terminate = () => cleanup ??= this.cleanupForeground(context, () => this.processManager.terminate(managed))
    try {
      const result = await waitForExit(managed.exitPromise, timeoutMs, context.signal)
      if (result) return this.formatManagedProcessOutput(managed.stdoutChunks, managed.stderrChunks, result.status.code, result.status.success, managed.shell)
      cancel()
      const status = await terminate()
      return `Error: foreground exec timed out after ${formatElapsed(timeoutMs)}; process terminated.\n${
        this.formatManagedProcessOutput(managed.stdoutChunks, managed.stderrChunks, status.code, status.success, managed.shell)}`
    } finally {
      cancel()
      await terminate()
    }
  }

  private async executeNodeScript(
    script: string,
    scriptArgs: string[],
    cwd: string,
    timeoutMs: number,
    context: ExecutionContext,
    foreground: boolean,
    cancel: () => void,
  ): Promise<string> {
    if (timeoutMs === 0 && !this.backgroundTasks) {
      return 'Error: background tasks are not available in this context'
    }
    const controller = new AbortController()
    const abort = () => controller.abort(context.signal.reason)
    let transferred = false
    let binding: ReturnType<typeof bindScriptTools> | undefined
    let run: ScriptRun | undefined
    let completion: Promise<string> | undefined
    const ownedExecCalls = new Set<Promise<unknown>>()
    const detach = () => context.signal.removeEventListener('abort', abort)
    const observe = () => {
      const { stdout = '', stderr = '' } = run?.output() ?? {}
      return `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim() || '(no output yet)'
    }
    try {
      context.signal.throwIfAborted()
      if (timeoutMs !== 0) context.signal.addEventListener('abort', abort, { once: true })
      binding = bindScriptTools({ ...context, signal: controller.signal })
      const env = { ...process.env, ...await loadDotEnv(this.workspace) }
      context.signal.throwIfAborted()
      run = startScript({
        code: script,
        args: scriptArgs,
        cwd,
        filename: join(cwd, 'exec.mts'),
        entry: 'script',
        policy: { kind: 'host' },
        signal: binding.signal,
        callModule: (name, input, signal) => {
          const pending = binding!.call(name, input, signal)
          // Only native exec owns reapable child processes. Arbitrary tool promises
          // may ignore cancellation and must not extend a script's deadline.
          if (foreground && context.tools.get(name) instanceof ExecTool) {
            ownedExecCalls.add(pending)
            void pending.then(() => ownedExecCalls.delete(pending), () => ownedExecCalls.delete(pending))
          }
          return pending
        },
        toolNames: binding.names,
        timeoutMs: foreground ? timeoutMs : null,
        env,
      })
      completion = run.completion.then(
        result => JSON.stringify({
          ok: true, module: '<inline script>', cwd,
          stdout: result.stdout, stderr: result.stderr, result: result.value,
        }, null, 2),
        error => JSON.stringify({
          ok: false, module: '<inline script>', cwd, ...run!.output(), error: errMsg(error),
        }, null, 2),
      ).finally(async () => {
        await binding!.cleanup()
        await Promise.allSettled(ownedExecCalls)
      })
      const result = timeoutMs === 0 ? null : await waitForExit(completion, timeoutMs, context.signal)
      if (result) {
        context.signal.throwIfAborted()
        return result.status
      }
      if (foreground) {
        cancel()
        run.cancel()
        await completion
        return JSON.stringify({
          ok: false, module: '<inline script>', cwd, ...run.output(),
          error: `Foreground exec timed out after ${formatElapsed(timeoutMs)}; process terminated.`,
        }, null, 2)
      }
      if (!this.backgroundTasks) throw new Error('Background tasks are not available in this context')
      const taskId = this.backgroundTasks.runPromiseTask({
        kind: 'process',
        title: `exec node: ${script.slice(0, 80)}`,
        sessionId: context.sessionId,
        inputId: context.messageId,
        callback: {
          sessionId: context.sessionId,
          replyTo: { channel: context.channel, chatId: context.chatId },
          isGroup: context.isGroup,
          senderName: 'Background Task',
        },
        observe,
        onCancel: () => {
          controller.abort(new Error('Background task cancelled'))
          run!.cancel()
        },
      }, completion)
      // Ownership now belongs to the background task, not the LLM turn.
      detach()
      transferred = true
      const header = timeoutMs === 0
        ? 'Node.js script running in background (detached from this turn).'
        : `Node.js script still running after ${formatElapsed(timeoutMs)}. Output so far:\n${observe()}`
      return `${header}\nBackground task ID: ${taskId}\nIt keeps running with full tool access until it exits or you \`kill\` it.`
    } catch (error) {
      context.signal.throwIfAborted()
      return `Error: ${errMsg(error)}`
    } finally {
      detach()
      if (!transferred) {
        if (foreground) cancel()
        run?.cancel()
        if (completion) await completion
        else await binding?.cleanup()
      }
    }
  }

  private async intercept(
    command: string,
    cwd: string,
    context: ExecutionContext,
  ): Promise<string | null> {
    return await this.commandHandler.handle(command, {
      workspace: this.workspace,
      cwd,
      channel: context.channel,
      senderId: context.senderId,
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.channelAddress ? { channelAddress: context.channelAddress } : {}),
      ...(context.inputSource ? { inputSource: context.inputSource } : {}),
    })
  }
}
