import type { ExecutionContext } from './context.ts'
import { type ChildProcess, spawn as childSpawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import {
  formatElapsed,
  type ManagedProcessStatus,
  type ManagedProcess,
  type ProcessManager,
  terminateProcessTree,
} from '../execution/processes/manager.ts'
import {
  defaultManagedShell,
  type ManagedShell,
  resolveExecShell,
} from '../execution/processes/shells.ts'
import type { CommandHandlerManager } from './shell-commands/command-handler.ts'
import { generatePreamble, startToolBridge } from '../script-runtime/bridge.ts'
import type { EvalRunnerRequest, EvalRunnerResponse } from '../script-runtime/types.ts'
import { RUNNER_RESPONSE_PREFIX } from '../script-runtime/types.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { errMsg } from '../utils/truncate.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import { loadDotEnv } from '../utils/env.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import type { LocalProcessExecutor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { MAX_CALL_TIMEOUT_MS } from '../sessions/execution-scope.ts'
import { isWindows } from '../utils/runtime.ts'
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

function getChildScriptUrl(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return fileURLToPath(new URL(`../script-runtime/child.${extension}`, import.meta.url))
}

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

function encodePayload(payload: EvalRunnerRequest): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function parseRunnerResponse(stdout: string): EvalRunnerResponse | null {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(RUNNER_RESPONSE_PREFIX))

  if (!line) return null

  try {
    const payload = line.slice(RUNNER_RESPONSE_PREFIX.length)
    const parsed = JSON.parse(payload) as Partial<EvalRunnerResponse>
    if (typeof parsed.ok !== 'boolean') return null
    if (typeof parsed.module !== 'string') return null
    if (typeof parsed.cwd !== 'string') return null
    if (typeof parsed.stdout !== 'string') return null
    if (typeof parsed.stderr !== 'string') return null
    return parsed as EvalRunnerResponse
  } catch {
    return null
  }
}

function buildRunnerArgs(payload: string): string[] {
  return [
    getChildScriptUrl(),
    '--eval-runner',
    payload,
  ]
}

interface NodeChildHandle {
  child: ChildProcess
  stdoutChunks: Uint8Array[]
  stderrChunks: Uint8Array[]
  exitPromise: Promise<ManagedProcessStatus>
  request: EvalRunnerRequest
}

async function spawnNodeChild(
  request: EvalRunnerRequest,
  workspace: string,
  bridgeUrl?: string,
  options: { isolated?: boolean; signal?: AbortSignal } = {},
): Promise<NodeChildHandle> {
  const payload = encodePayload(request)
  const commandArgs = buildRunnerArgs(payload)
  const childEnv = {
    ...process.env,
    ...await loadDotEnv(workspace),
    ELECTRON_RUN_AS_NODE: '1',
    SHADOW_TOOLS_URL: bridgeUrl ?? '',
    SHADOW_TOOLS_CREDENTIAL: process.env.GATEWAY_LAUNCH_CREDENTIAL ??
      process.env.WINDOWS_USE_LAUNCH_TOKEN ?? '',
  }
  options.signal?.throwIfAborted()
  const child = childSpawn(process.execPath, commandArgs, {
    cwd: request.cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(options.isolated ? { detached: !isWindows } : {}),
  })

  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []

  // Stream stdout/stderr into chunk buffers
  const pipeStream = async (
    stream: NodeJS.ReadableStream | null,
    chunks: Uint8Array[],
  ) => {
    if (!stream) return
    try {
      for await (const chunk of stream) chunks.push(chunk as Uint8Array)
    } catch { /* stream closed */ }
  }
  const stdoutDone = pipeStream(child.stdout, stdoutChunks)
  const stderrDone = pipeStream(child.stderr, stderrChunks)

  const exitPromise = new Promise<ManagedProcessStatus>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      Promise.all([stdoutDone, stderrDone]).then(() => {
        resolve({
          success: code === 0 && signal === null,
          code: code ?? -1,
          signal,
        })
      })
    })
  })

  return { child, stdoutChunks, stderrChunks, exitPromise, request }
}

function formatNodeResult(
  handle: NodeChildHandle,
  status: ManagedProcessStatus,
): string {
  const stdout = decodeChunks(handle.stdoutChunks)
  const stderr = decodeChunks(handle.stderrChunks)
  const parsed = parseRunnerResponse(stdout)
  if (parsed) {
    parsed.module = '<inline script>'
    return JSON.stringify(parsed, null, 2)
  }
  const response: EvalRunnerResponse = {
    ok: status.success,
    module: '<inline script>',
    cwd: handle.request.cwd,
    stdout,
    stderr,
    error: status.success
      ? undefined
      : `Runner exited with code ${status.code}`,
  }
  return JSON.stringify(response, null, 2)
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
 * in an isolated child process with the tool bridge enabled.
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
      if (foreground) return this.executeForegroundNode(script, scriptArgs, cwd, timeoutMs, context, cancel)
      if (timeoutMs === 0) {
        return await this.backgroundNodeScript(script, scriptArgs, cwd, context)
      }
      return await this.executeNodeScript(
        script,
        scriptArgs,
        cwd,
        timeoutMs,
        context,
      )
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

  private async executeForegroundNode(
    script: string,
    scriptArgs: string[],
    cwd: string,
    timeoutMs: number,
    context: ExecutionContext,
    cancel: () => void,
  ): Promise<string> {
    const bridge = startToolBridge(context.tools, context)
    let directory: string | undefined
    let handle: NodeChildHandle | undefined
    let cleanup: Promise<ManagedProcessStatus> | undefined
    const terminate = () => cleanup ??= this.cleanupForeground(context,
      () => terminateProcessTree(handle!.child, handle!.exitPromise, true))
    try {
      await mkdir(join(this.workspace, '.eval'), { recursive: true })
      directory = await mkdtemp(join(this.workspace, '.eval', 'exec-node-'))
      const module = join(directory, 'script.mts')
      await writeFile(module, generatePreamble(context.tools.names()) + '\n' + script)
      handle = await spawnNodeChild({ module, args: scriptArgs, cwd }, this.workspace, bridge.url,
        { isolated: true, signal: context.signal })
      const result = await waitForExit(handle.exitPromise, timeoutMs, context.signal)
      if (result) return formatNodeResult(handle, result.status)
      cancel()
      const status = await terminate()
      return JSON.stringify({ ...JSON.parse(formatNodeResult(handle, status)), ok: false,
        error: `Foreground exec timed out after ${formatElapsed(timeoutMs)}; process terminated.` }, null, 2)
    } finally {
      cancel()
      try { if (handle) await terminate() }
      finally {
        bridge.cleanup()
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }
  }

  private async executeNodeScript(
    script: string,
    scriptArgs: string[],
    cwd: string,
    timeoutMs: number,
    context: ExecutionContext,
  ): Promise<string> {
    let bridge: { url: string; cleanup?: () => void } | null = null
    if (context.tools) {
      try {
        bridge = await startToolBridge(context.tools, context)
      } catch (err) {
        console.warn('[exec:node] Failed to start tool bridge:', errMsg(err))
      }
    }

    let tmpDir: string | undefined
    let activeChild: ChildProcess | undefined
    try {
      await mkdir(join(this.workspace, '.eval'), { recursive: true })
      tmpDir = await mkdtemp(join(this.workspace, '.eval', 'exec-node-'))
      const preamble = bridge
        ? generatePreamble(context.tools.names()) + '\n'
        : ''
      const tmpFile = join(tmpDir, 'script.mts')
      await writeFile(tmpFile, preamble + script)

      const request: EvalRunnerRequest = {
        module: tmpFile,
        args: scriptArgs,
        cwd,
      }
      const handle = await spawnNodeChild(request, this.workspace, bridge?.url)
      activeChild = handle.child

      // Race: exit vs timeout
      const result = await waitForExit(handle.exitPromise, timeoutMs, context.signal)

      if (result === null) {
        // Don't kill — register as background task and return partial output
        const stdout = decodeChunks(handle.stdoutChunks)
        const stderr = decodeChunks(handle.stderrChunks)
        let partial = ''
        if (stdout) partial += stdout
        if (stderr) partial += `\n[stderr]\n${stderr}`
        partial = partial.trim()

        const elapsed = formatElapsed(timeoutMs)
        const header =
          `Node.js script still running after ${elapsed}. Output so far:`

        // Register as bg task so agent can await/observe/kill
        // Keep tmpDir and bridge alive for the running process
        const cleanupTmpDir = tmpDir
        const cleanupBridge = bridge
        tmpDir = undefined // prevent cleanup in finally
        bridge = null // prevent cleanup in finally
        activeChild = undefined
        const taskId = this.backgroundTasks?.runPromiseTask(
          {
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
            observe: () => {
              const out = decodeChunks(handle.stdoutChunks)
              const err = decodeChunks(handle.stderrChunks)
              let o = ''
              if (out) o += out
              if (err) o += `\n[stderr]\n${err}`
              return o.trim() || '(no output yet)'
            },
            onCancel: () => { handle.child.kill() },
          },
          handle.exitPromise.then((status) => formatNodeResult(handle, status)).finally(() => {
            // Cleanup after process finishes
            if (cleanupTmpDir) {
              rm(cleanupTmpDir, { recursive: true }).catch(() => {})
            }
            if (cleanupBridge?.cleanup) {
              try {
                cleanupBridge.cleanup()
              } catch { /* ignore */ }
            }
          }),
        )

        const body = partial
          ? `${header}\n${partial}`
          : `${header}\n(no output yet)`
        return taskId
          ? `${body}\n\nBackground task ID: ${taskId}\nUse \`kill\` tool to cancel if needed.`
          : body
      }

      return formatNodeResult(handle, result.status)
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (context.signal?.aborted) activeChild?.kill()
      if (tmpDir) {
        await rm(tmpDir, { recursive: true }).catch(() => {})
      }
      if (bridge?.cleanup) {
        try {
          bridge.cleanup()
        } catch { /* ignore */ }
      }
    }
  }

  private async backgroundNodeScript(
    script: string,
    scriptArgs: string[],
    cwd: string,
    context: ExecutionContext,
  ): Promise<string> {
    if (!this.backgroundTasks) {
      return 'Error: background tasks are not available in this context'
    }

    // Detach from the current LLM turn. A background Node.js script is a long-lived
    // daemon (e.g. a self-made event source), so it must NOT share the turn's
    // AbortSignal — otherwise a turn abort (including one triggered by an event
    // the script itself emits back into the session) would tear the process and
    // its tool bridge down after a single iteration. It also has no artificial
    // timeout: it runs until it exits or is killed.
    const controller = new AbortController()
    const bgContext: ExecutionContext = {
      ...context,
      signal: controller.signal,
    }

    let bridge: { url: string; cleanup?: () => void } | null = null
    if (bgContext.tools) {
      try {
        bridge = await startToolBridge(bgContext.tools, bgContext)
      } catch (err) {
        console.warn('[exec:node] Failed to start tool bridge:', errMsg(err))
      }
    }

    let tmpDir: string | undefined
    let handle: NodeChildHandle
    try {
      await mkdir(join(this.workspace, '.eval'), { recursive: true })
      tmpDir = await mkdtemp(join(this.workspace, '.eval', 'exec-node-'))
      const preamble = bridge
        ? generatePreamble(bgContext.tools.names()) + '\n'
        : ''
      const tmpFile = join(tmpDir, 'script.mts')
      await writeFile(tmpFile, preamble + script)
      handle = await spawnNodeChild(
        { module: tmpFile, args: scriptArgs, cwd },
        this.workspace,
        bridge?.url,
      )
    } catch (err) {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
      if (bridge?.cleanup) {
        try {
          bridge.cleanup()
        } catch { /* ignore */ }
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    const cleanup = () => {
      if (tmpDir) rm(tmpDir, { recursive: true }).catch(() => {})
      if (bridge?.cleanup) {
        try {
          bridge.cleanup()
        } catch { /* ignore */ }
      }
    }

    const deferred = this.backgroundTasks.createDeferredTask({
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
      observe: () => {
        const out = decodeChunks(handle.stdoutChunks)
        const err = decodeChunks(handle.stderrChunks)
        let o = ''
        if (out) o += out
        if (err) o += `\n[stderr]\n${err}`
        return o.trim() || '(no output yet)'
      },
      onCancel: () => {
        controller.abort()
        try {
          handle.child.kill()
        } catch { /* ignore */ }
      },
    })

    handle.exitPromise
      .then((status) => {
        cleanup()
        deferred.complete(formatNodeResult(handle, status))
      })
      .catch((err) => {
        cleanup()
        deferred.fail(err)
      })

    return [
      'Node.js script running in background (detached from this turn).',
      `Background task ID: ${deferred.taskId}`,
      'It keeps running with full tool access until it exits or you `kill` it.',
    ].join('\n')
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
