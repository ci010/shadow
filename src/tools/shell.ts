import { layerfsRoute } from './layerfs-route.ts'
import { executionTargetContext, executionTargetParameters } from './execution-target.ts'
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
import { ScriptExecutionError, startScript } from '../script-runtime/runtime.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, completedToolFailure, requireToolText, type Tool, type ToolParameters, type ToolResult } from './tool.ts'
import { errMsg } from '../utils/truncate.ts'
import { backgroundExecutionId, type BackgroundTaskManager } from '../agent/background-task.ts'
import { loadDotEnv } from '../utils/env.ts'
import { resolveSessionLocations } from '../sessions/locality.ts'
import { localExecSafegitEnv } from '../execution/git/safegit.ts'
import { localExecSafegitAliasEnv } from '../execution/git/safegit-alias.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import type { LocalProcessExecutor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { MAX_CALL_TIMEOUT_MS } from '../sessions/execution-scope.ts'
import { parseWorkdirProcessArgs } from '../execution/capability-shell.ts'
import { executeRemoteShell } from '../execution/remote-shell-client.ts'
import { createHash } from 'node:crypto'
import { layerfsResources } from '../execution/layerfs/resource-service.ts'
import { remoteLayerFSGateway } from '../execution/layerfs/remote-gateway.ts'

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

export type ExecShell = ManagedShell | 'javascript'

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
    normalized === 'javascript'
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
 * JavaScript uses a bounded Main subprocess with a target-bound tool bridge.
 * This prevents accidental misuse; it is not a security sandbox.
 * Leaf calls instead require a positive timeout (default/max 120 seconds),
 * terminate owned foreground work on timeout/abort, and never register callbacks.
 */
export class ExecTool implements Tool<ToolResult> {
  readonly name = 'exec'
  readonly javascriptBridge = 'foreground-shell'
  readonly supportsLayerFSWorkdir = true
  readonly supportsRemoteWorkdir = true
  readonly description: string =
    'Run an OS command or bounded inline JavaScript. JavaScript has no Node APIs; its filesystem tool bridge is bound to the resolved workspace. Not a security sandbox.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      ...executionTargetParameters,
      script: {
        type: 'string',
        description:
          'Script to run. For OS shells this is the command string; for `shell=javascript` this is an ES module (e.g. `await read({ path: \'notes.txt\' })` without an import when read is allowed; return JSON from export default or export function run). Preserve failures: do not append exit 0 or || true to hide an error. When chaining native commands in PowerShell, check $LASTEXITCODE after each one and propagate failures.',
      },
      shell: {
        type: 'string',
        description: 'Runtime: OS shell name or `javascript` for inline JavaScript. Omitted uses the Runtime default (normally cmd on Windows, sh on Unix). Select powershell/pwsh explicitly for PowerShell syntax; shell syntax is not auto-detected.',
      },
      args: {
        type: 'array',
        description: 'Additional arguments passed to the script.',
        items: { type: 'string' },
      },
      cwd: {
        type: 'string',
        description: 'OS shells only: working directory (defaults to the resolved workspace)',
      },
      timeout_ms: {
        type: 'number',
        description:
          'Max wait time in milliseconds. 0 = run in background (fire-and-forget). ' +
          'Omit for default (120s). JavaScript requires 1–120000 and is terminated on timeout; OS-shell behavior depends on the target.',
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
    private readonly nodeOnly = false,
  ) {
    this.workspace = resolve(workspace)
    this.localExecutor = localExecutor ?? new LocalExecutor(processManager)
    if (nodeOnly) {
      this.description = 'Run bounded inline JavaScript with a workspace-bound tool bridge. No Node APIs or OS shells. Not a security sandbox.'
      this.parameters = {
        ...this.parameters,
        properties: {
          ...this.parameters.properties,
          script: {
            type: 'string',
            description: 'JavaScript ES module. Call allowed tools without imports, e.g. `await read({ path: \'notes.txt\' })`. Return JSON from export default or export function run. See javascript-scripting.',
          },
          shell: { type: 'string', enum: ['javascript'], default: 'javascript', description: 'Only javascript is available; omission also selects javascript.' },
        },
      }
    }
  }

  private formatManagedProcessOutput(
    managed: ManagedProcess,
    status: ManagedProcessStatus,
    completed = false,
  ): ToolResult {
    const { code: exitCode, success } = status
    const stdout = decodeChunks(managed.stdoutChunks, managed.shell)
    const stderr = decodeChunks(managed.stderrChunks, managed.shell)
    let output = ''
    if (stdout) output += stdout
    if (stderr) output += `\n[stderr]\n${stderr}`
    if (!success) {
      output = [
        `Error: command exited with code ${exitCode}`,
        `Shell: ${managed.shell}`,
        `Cwd: ${managed.cwd}`,
        ...(status.signal ? [`Signal: ${status.signal}`] : []),
        '[stdout]',
        stdout || '(empty)',
        '[stderr]',
        stderr || '(empty)',
      ].join('\n')
    }
    const result = {
      isError: !success,
      content: [{ type: 'text' as const, text: output || `(no output, exit code ${exitCode})` }],
    }
    return completed && !success ? completedToolFailure(result) : result
  }

  private registerBackgroundProcessTask(
    context: ExecutionContext,
    managed: ManagedProcess,
  ): string | null {
    return this.backgroundTasks.runPromiseTask(
      {
        kind: 'process',
        title: `exec: ${managed.command.slice(0, 80)}`,
        sessionId: context.sessionId,
        inputId: context.messageId,
        onCancel: async () => { await this.processManager.terminate(managed) },
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
      managed.exitPromise.then((status) => {
        const output = requireToolText(this.formatManagedProcessOutput(
          managed,
          status,
        ))
        if (!status.success) throw new Error(output)
        return output
      }),
    )
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const shell = parseExecShell(args.shell, this.nodeOnly ? 'javascript' : this.defaultShell) ??
      this.defaultShell
    const script = String(args.script)
    return `💻 [${shell}] ${script}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const shell = parseExecShell(args.shell, this.nodeOnly ? 'javascript' : context.defaultExecShell ?? this.defaultShell)
    if (context.recoveringToolCall && (shell === 'javascript' || String(args.shell).trim().toLowerCase() === 'node')) {
      throw new ToolOutcomeUnknownError('Inline exec cannot be reconciled; it was not re-executed.')
    }
    if (!shell) throw new ToolNoEffectError('Invalid `shell`. Use an OS shell or `javascript`; the old `node` entry was removed.')
    if (this.nodeOnly && shell !== 'javascript') throw new ToolNoEffectError('Only shell=javascript is enabled.')
    const original = context
    if (shell === 'javascript') {
      if (original.scriptInvocation) throw new ToolNoEffectError('Recursive JavaScript orchestration is disabled.')
      // JavaScript computation is a Main capability even when bridged tools use
      // another target. Remote-shell-only admission does not authorize it.
      const denied = original.tools?.getExecutionPolicy?.()?.(this, { script: args.script, shell }, {
        ...original, remoteWorkdir: undefined, layerfsWorkdir: undefined,
      })
      if (denied) throw new ToolNoEffectError(denied)
      if (String(args.workspace ?? args.folder ?? '').startsWith('device:')) throw new ToolNoEffectError('JavaScript requires a registered workspace; direct device targeting is OS-shell only.')
      context = await executionTargetContext(args, context, 'workdir.process.execute-once')
      if ((args.workspace !== undefined || args.folder !== undefined) && !context.cwd && !context.remoteWorkdir && !context.layerfsWorkdir) {
        throw new ToolNoEffectError('JavaScript workspace resolved without an execution target; no Main fallback is allowed.')
      }
      if (context.layerfsWorkdir) {
        const { workspace } = context.layerfsWorkdir
        const project = context.projectId
        const gateway = project ? remoteLayerFSGateway(project, this.workspace) : undefined
        if (!project || (!gateway?.location({}, context) &&
          (gateway?.localExecutionAllowed === false || !layerfsResources(project, this.workspace).catalog.hasWorkspace(workspace)))) {
          throw new ToolNoEffectError('JavaScript requires a registered LayerFS target in this Project; no Main fallback is allowed.')
        }
      }
      if (args.cwd !== undefined) throw new ToolNoEffectError('JavaScript uses the resolved workspace; cwd is unsupported.')
      const script = typeof args.script === 'string' ? args.script : ''
      if (!script.trim()) throw new ToolNoEffectError('`script` is required')
      const timeout = args.timeout_ms ?? (context.tools?.executionMode === 'call' ? MAX_CALL_TIMEOUT_MS : this._defaultTimeoutMs)
      if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > MAX_CALL_TIMEOUT_MS) {
        throw new ToolNoEffectError(`JavaScript timeout_ms must be 1–${MAX_CALL_TIMEOUT_MS}; background execution is unavailable.`)
      }
      if (context.tools?.executionMode === 'call') {
        const denied = context.tools.executionDenial('exec', args)
        if (denied) return denied
        return context.tools.runForeground(context.signal, signal => this.executeJavaScript(script, parseStringArray(args.args), Number(timeout), { ...context, signal }))
      }
      return this.executeJavaScript(script, parseStringArray(args.args), Number(timeout), context)
    }
    context = await executionTargetContext(args, context, 'workdir.process.execute-once')
    const foreground = context.javascriptInvocation || context.tools?.executionMode === 'call'
    const layerArgs = { ...args, timeout_ms: args.timeout_ms ?? (foreground ? MAX_CALL_TIMEOUT_MS : this._defaultTimeoutMs) }
    if ((String(args.workspace ?? '').startsWith('layerfs:') || context.layerfsWorkdir) && DANGEROUS_PATTERNS.some(pattern => pattern.test(String(args.script)))) return 'Error: command blocked by safety filter'
    const layerResult = await layerfsRoute('exec', layerArgs, context, this.workspace, {
      run: start => this.executeLayerFSRequest(layerArgs, context, start),
    })
    if (layerResult !== undefined) return layerResult
    context.signal.throwIfAborted()
    if (context.recoveringToolCall && !context.remoteWorkdir) {
      throw new ToolOutcomeUnknownError('This saved local execution has no verifiable durable reconciliation route. Its outcome remains unknown; the command was not re-executed.')
    }
    const script = typeof args.script === 'string' ? args.script : ''
    if (!script.trim()) throw new ToolNoEffectError('`script` is required')

    const request = { ...args, script, shell }
    if (context.remoteWorkdir) {
      context.signal.throwIfAborted()
      if (DANGEROUS_PATTERNS.some(pattern => pattern.test(String(args.script)))) {
        return 'Error: command blocked by safety filter'
      }
      if (foreground) {
        const denied = context.tools.executionDenial('exec', args)
        if (denied) return denied
        return context.tools.runForeground(context.signal, signal => this.executeRemoteRequest(args, { ...context, signal }, true))
      }
      return this.executeRemoteRequest(args, context)

    }
    if (foreground) {
      context.signal.throwIfAborted()
      const denied = context.tools.executionDenial('exec', args)
      if (denied) return denied
      return context.tools.runForeground(context.signal, (signal, cancel) =>
        this.executeRequest(request, { ...context, signal }, true, cancel))
    }
    return this.executeRequest(request, context, false)
  }

  private async executeLayerFSRequest(args: Record<string, unknown>, context: ExecutionContext,
    start: (signal: AbortSignal, observe: (text: string) => void) => Promise<ToolResult>): Promise<ToolResult> {
    if (context.javascriptInvocation || context.tools?.executionMode === 'call') {
      const denied = context.tools.executionDenial('exec', args)
      if (denied) return denied
      return context.tools.runForeground(context.signal, signal => this.runLayerFSRequest(args, { ...context, signal }, start, true))
    }
    return this.runLayerFSRequest(args, context, start, false)
  }

  private async runLayerFSRequest(args: Record<string, unknown>, context: ExecutionContext,
    start: (signal: AbortSignal, observe: (text: string) => void) => Promise<ToolResult>, foreground: boolean): Promise<ToolResult> {
    context.signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(context.signal.reason)
    const timeout = Number(args.timeout_ms)
    let output = ''
    if (timeout !== 0 || foreground) context.signal.addEventListener('abort', abort, { once: true })
    const completion = start(controller.signal, text => { output = (output + text).slice(-131072) })
    void completion.catch(() => {})
    const cleanup = async () => {
      controller.abort(new Error('LayerFS execution cancelled'))
      try {
        const result = await waitForExit(completion, 11000)
        if (!result) throw new ToolOutcomeUnknownError('LayerFS cleanup not confirmed; do not rerun.')
      } catch (error) {
        if (foreground) context.tools.rejectExecution('LayerFS foreground cleanup not confirmed.')
        throw error
      }
    }
    try {
      const result = timeout === 0 ? null : await waitForExit(completion, timeout, context.signal)
      if (result) return result.status
      if (foreground) {
        await cleanup()
        return completedToolFailure({ isError: true, content: [{ type: 'text', text: 'LayerFS foreground wait expired; sandbox process group stopped.' }] })
      }
      const id = this.backgroundTasks.runPromiseTask({
        kind: 'process', title: `LayerFS exec: ${String(args.script).slice(0, 80)}`,
        sessionId: context.sessionId, inputId: context.messageId, observe: () => output,
        callback: { sessionId: context.sessionId, replyTo: { channel: context.channel, chatId: context.chatId }, isGroup: context.isGroup, senderName: 'Background Task' },
        onCancel: cleanup,
      }, completion.then(result => {
        const text = requireToolText(result)
        if (typeof result === 'object' && result.isError) throw new Error(text)
        return text
      }))
      return `LayerFS process running in background.\nExecution ID: ${backgroundExecutionId(id)}\nOutput so far:\n${output}`
    } catch (error) {
      if (!(error instanceof ToolOutcomeUnknownError)) await cleanup()
      else if (foreground) context.tools.rejectExecution('LayerFS foreground outcome unknown.')
      throw error
    } finally { context.signal.removeEventListener('abort', abort) }
  }

  private async executeRemoteRequest(args: Record<string, unknown>, context: ExecutionContext, foreground = false): Promise<ToolResult> {
    const timeoutMs = args.timeout_ms === undefined ? (foreground ? MAX_CALL_TIMEOUT_MS : this._defaultTimeoutMs) : args.timeout_ms
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 0 || Number(timeoutMs) > 2_147_483_647) {
      return 'Error: `timeout_ms` must be a finite non-negative integer no greater than 2147483647'
    }
    const wireArgs = {
      script: args.script,
      ...(args.shell === undefined ? {} : { shell: parseExecShell(args.shell) }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.args === undefined ? {} : { args: args.args }),
    }
    try { parseWorkdirProcessArgs(wireArgs) } catch (error) { return `Error: ${errMsg(error)}` }
    const controller = new AbortController()
    const abort = () => controller.abort(context.signal.reason)
    let transferred = false
    let output = '(no output yet)'
    let completedFailure = false
    let cancellationConfirmed = false
    let remoteFailed = false
    const detach = () => context.signal.removeEventListener('abort', abort)
    // As with local OS exec, timeout=0 transfers ownership immediately.
    if (timeoutMs !== 0) context.signal.addEventListener('abort', abort, { once: true })
    const completion = executeRemoteShell({
      ...context.remoteWorkdir!, sessionId: context.sessionId,
      turnId: context.messageId ?? context.sessionId,
      ...(context.toolCallId ? { executionKey: createHash('sha256').update(JSON.stringify([
        'remote-shell-v1', context.physicalSessionId ?? context.sessionId, context.toolCallId,
      ])).digest('hex') } : {}),
      recovering: context.recoveringToolCall, signal: controller.signal,
    }, wireArgs, Number(timeoutMs), () => { completedFailure = true }, {
      untilExit: !foreground,
      observe: text => { output = text },
      onReceipt: receipt => {
        remoteFailed = receipt.state !== 'completed' || receipt.exitCode !== 0
        cancellationConfirmed = receipt.state === 'cancelled' || receipt.state === 'completed' || receipt.state === 'expired' || receipt.reason?.code === 'process-exit'
      },
    })
    // Always consume rejections even when the wait window/turn ends first.
    void completion.catch(() => {})
    try {
      let result: { status: string } | null
      if (foreground) {
        try { result = await waitForExit(completion, Number(timeoutMs), context.signal) }
        catch (error) {
          controller.abort(error)
          result = await waitForExit(completion, 10_000)
          if (!result || !cancellationConfirmed) {
            context.tools.rejectExecution('Remote foreground cleanup could not be verified.')
            throw new ToolOutcomeUnknownError('Remote foreground cancellation was not confirmed; outcome unknown. Do not rerun.')
          }
          throw error
        }
        if (!result) {
          controller.abort(new Error('Foreground wait window expired'))
          result = await waitForExit(completion, 10_000)
          if (!result || !cancellationConfirmed) throw new ToolOutcomeUnknownError('Remote foreground deadline cleanup was not confirmed; outcome unknown. Do not rerun.')
        }
      } else result = timeoutMs === 0 ? null : await waitForExit(completion, Number(timeoutMs), context.signal)
      if (result) {
        context.signal.throwIfAborted()
        return completedFailure ? completedToolFailure({ isError: true, content: [{ type: 'text', text: result.status }] }) : result.status
      }
      const id = this.backgroundTasks.runPromiseTask({
        kind: 'process', title: `remote exec: ${String(args.script).slice(0, 80)}`,
        sessionId: context.sessionId, inputId: context.messageId,
        observe: () => output,
        callback: { sessionId: context.sessionId, replyTo: { channel: context.channel, chatId: context.chatId }, isGroup: context.isGroup, senderName: 'Background Task' },
        onCancel: async () => {
          controller.abort(new Error('Background task cancelled'))
          const settled = await waitForExit(completion, 10_000)
          if (!settled || !cancellationConfirmed) throw new Error('Remote cleanup was not confirmed; outcome unknown. Reconcile the original execution; do not rerun.')
        },
      }, completion.then(text => {
        if (remoteFailed) throw new Error(text)
        return text
      }, error => {
        if (error instanceof ToolOutcomeUnknownError) throw new ToolOutcomeUnknownError(
          'OUTCOME UNKNOWN: the Child command may still be running; this is not a confirmed process failure. ' +
          'Do not rerun it. Inspect the Child and its original shell journal/side effects. ' +
          'This background handle cannot reconnect or reconcile; original-call reconciliation is currently an internal recovery API, not a background tool. ' +
          errMsg(error))
        throw error
      }))
      detach()
      transferred = true
      const header = timeoutMs === 0 ? 'Remote process started in background.'
        : `Remote process still running after ${formatElapsed(Number(timeoutMs))}.`
      return `${header}\nExecution ID: ${backgroundExecutionId(id)}\nRead v:bg/<executionId> for output; cancel({ executionId }) stops it.` +
        (timeoutMs === 0 ? '' : `\nOutput so far:\n${output}`)
    } catch (error) {
      if (error instanceof ToolOutcomeUnknownError) {
        if (foreground) context.tools.rejectExecution('Remote foreground cleanup/outcome could not be verified.')
        throw error
      }
      context.signal.throwIfAborted()
      return `Error: ${errMsg(error)}`
    } finally {
      detach()
      if (!transferred && context.signal.aborted) controller.abort(context.signal.reason)
    }
  }

  private async localEnvironment(context: ExecutionContext): Promise<Record<string, string>> {
    // The current logical session owns its data, even when cwd is inherited from
    // another session. Do not pass workspaceRoot or derive this path from cwd.
    // Called only after the remote branch has returned; never send Main paths.
    const { sessionDataDir } = resolveSessionLocations(this.workspace, { sessionId: context.sessionId })
    return {
      ...await localExecSafegitAliasEnv(await localExecSafegitEnv(await loadDotEnv(this.workspace)), sessionDataDir),
      SHADOW_SESSION_DATA_DIR: sessionDataDir,
    }
  }

  private async executeRequest(
    args: Record<string, unknown> & { script: string; shell: ManagedShell },
    context: ExecutionContext,
    foreground: boolean,
    cancel: () => void = () => {},
  ): Promise<ToolResult> {
    if (foreground) context.signal.throwIfAborted()
    const { script, shell } = args

    const scriptArgs = parseStringArray(args.args)
    const base = context.cwd ?? this.workspace
    const cwd = args.cwd
      ? resolveAgentPath(this.workspace, base, String(args.cwd))
      : base
    const timeoutMs = args.timeout_ms !== undefined
      ? Number(args.timeout_ms)
      : foreground ? MAX_CALL_TIMEOUT_MS : this._defaultTimeoutMs

    const resolvedShell = await resolveExecShell(shell)
    if (!resolvedShell) {
      return `Error: shell \`${shell}\` is not available on this machine`
    }

    const intercepted = context.javascriptInvocation ? null : await this.intercept(
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
    const dotEnv = await this.localEnvironment(context)
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
          { isolated: true },
        )
        : await this.localExecutor.startProcess({
          script,
          cwd,
          env: dotEnv,
          shell,
          args: scriptArgs,
        }, { isolated: true, ...(foreground ? { signal: context.signal } : {}) })
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
      if (taskId) lines.push(`Execution ID: ${backgroundExecutionId(taskId)}`)
      lines.push(
        'Read `v:bg/<executionId>` for output; use `cancel({ executionId })` to stop it.',
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

      const header = `Process PID=${pid} still running after ${formatElapsed(elapsed)}.`
      const taskId = this.registerBackgroundProcessTask(context, managed)
      const receipt = taskId
        ? `\nExecution ID: ${backgroundExecutionId(taskId)}\nRead v:bg/<executionId> for output; cancel({ executionId }) stops it.` : ''
      return `${header}${receipt}\nOutput collected so far (may be incomplete):\n${partial || '(no output yet)'}`
    }

    // Process finished within the timeout window
    return this.formatManagedProcessOutput(
      managed,
      result.status,
      result.status.signal === null && result.status.code >= 0 && !context.signal.aborted,
    )
  }

  private async cleanupForeground(
    context: ExecutionContext,
    cleanup: () => Promise<ManagedProcessStatus>,
  ): Promise<ManagedProcessStatus> {
    try { return await cleanup() }
    catch (error) {
      context.tools.rejectExecution(`Foreground process cleanup failed: ${errMsg(error)}`)
      if (context.javascriptInvocation) throw new ToolOutcomeUnknownError(`Nested process cleanup was not confirmed. Do not rerun: ${errMsg(error)}`)
      throw error
    }
  }

  private async executeForegroundProcess(
    managed: ManagedProcess,
    timeoutMs: number,
    context: ExecutionContext,
    cancel: () => void,
  ): Promise<ToolResult> {
    let cleanup: Promise<ManagedProcessStatus> | undefined
    const terminate = () => cleanup ??= this.cleanupForeground(context, () => this.processManager.terminate(managed))
    try {
      const result = await waitForExit(managed.exitPromise, timeoutMs, context.signal)
      if (result) return this.formatManagedProcessOutput(managed, result.status,
        result.status.signal === null && result.status.code >= 0 && !context.signal.aborted)
      cancel()
      const status = await terminate()
      return `Error: foreground exec timed out after ${formatElapsed(timeoutMs)}; process terminated.\n${
        requireToolText(this.formatManagedProcessOutput(managed, status))}`
    } finally {
      cancel()
      await terminate()
    }
  }

  private async executeJavaScript(script: string, args: string[], timeoutMs: number, context: ExecutionContext): Promise<ToolResult> {
    context.signal.throwIfAborted()
    const binding = bindScriptTools({
      ...context, resolveToolTarget: undefined, resolveStoredToolTarget: undefined,
      switchProjectFolder: undefined, afterToolResultPublished: undefined,
      soleDirectToolCall: false, javascriptInvocation: true,
    }, { infer: true })
    const allowed = new Set(binding.names)
    const offered = context.offeredToolNames ?? context.tools.getDefinitions().map(def => def.function.name)
    const admitted = new Map<string, NonNullable<Tool['javascriptBridge']>>()
    for (const name of offered) {
      if (!allowed.has(name)) continue
      const tool = context.tools.get(name)
      const mode = tool?.javascriptBridge
      if (mode && (mode !== 'foreground-shell' || tool === this && !this.nodeOnly)) admitted.set(name, mode)
    }
    const toolNames = [...admitted.keys()]
    const pendingExec = new Set<Promise<unknown>>()
    let unknown: ToolOutcomeUnknownError | undefined
    let activeCalls = 0
    try {
      const run = startScript({
        code: script, args, filename: 'exec.mjs', entry: 'script',
        policy: { kind: 'javascript' }, signal: binding.signal, timeoutMs, toolNames,
        infer: binding.infer,
        callModule: async (name, input, signal) => {
          if (['workspace', 'folder', 'target', 'grant', 'nodeId', 'capabilityId', 'resourceId', 'workdirId', 'space', 'cwd'].some(key => Object.hasOwn(input, key))) {
            throw new ToolNoEffectError('JavaScript tool calls require the bound target without a target selector or cwd.')
          }
          const mode = admitted.get(name)
          if (!mode || context.tools.get(name)?.javascriptBridge !== mode) throw new ToolNoEffectError('JavaScript tool is not admitted.')
          if (mode === 'read-only' && !context.tools.isReadonly(name, input)) {
            throw new ToolNoEffectError('JavaScript permits only read-only calls to this tool.')
          }
          if (mode === 'foreground-shell') {
            const shell = typeof input.shell === 'string' && parseExecShell(input.shell)
            const timeout = input.timeout_ms ?? MAX_CALL_TIMEOUT_MS
            if (!shell || shell === 'javascript' || !Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > MAX_CALL_TIMEOUT_MS) {
              throw new ToolNoEffectError('JavaScript may call exec only with an explicit OS shell and a positive foreground timeout up to 120000 ms.')
            }
            input = { ...input, shell, timeout_ms: timeout }
          } else if (mode === 'filesystem') {
            const path = input.path
            if (typeof path !== 'string' || !path || path.startsWith('~') || /[:\\\0]/.test(path) || path.startsWith('/') ||
              path.split('/').some(part => part === '..' || part === '.tmp') ||
              input.handler === 'web' || name === 'search' && input.handler === 'glob' && String(input.query).includes(':')) {
              throw new ToolNoEffectError('JavaScript filesystem tools require a relative path on the bound target.')
            }
          }
          if (activeCalls >= 4) throw new ToolNoEffectError('JavaScript permits at most 4 concurrent tool calls.')
          activeCalls++
          const pending = binding.call(name, input, signal)
          if (name === 'exec') pendingExec.add(pending)
          try {
            const result = await pending
            if (typeof result === 'string' && /^(Error:|Blocked:|Error executing |Tool execution aborted:)/.test(result)) throw new Error(result)
            if (result && typeof result === 'object' && 'isError' in result && result.isError) throw new Error(requireToolText(result as ToolResult))
            return result
          } catch (error) {
            if (error instanceof ToolOutcomeUnknownError) unknown ??= error
            throw error
          } finally {
            activeCalls--
            pendingExec.delete(pending)
          }
        },
      })
      try {
        const result = await run.completion
        return JSON.stringify({ ok: true, stdout: result.stdout, stderr: result.stderr, result: result.value })
      } catch (error) {
        context.signal.throwIfAborted()
        const result = { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: errMsg(error), ...run.output() }) }] }
        return error instanceof ScriptExecutionError ? completedToolFailure(result) : result
      }
    } finally {
      await binding.cleanup()
      // The worker can finish or hit its deadline with a command still pending.
      // Wait for the existing native process cleanup/receipt before releasing it.
      await Promise.allSettled(pendingExec)
      if (unknown) throw unknown
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
