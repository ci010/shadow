import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

// Private utility-process wire contract, validated again by the Electron host.
const RESTART_MESSAGE = { type: 'shadow:dev-restart' } as const
export const DEVELOPMENT_RESTART_DELAY_MS = 1500

interface RestartProcess {
  env: NodeJS.ProcessEnv
  parentPort?: { postMessage(message: typeof RESTART_MESSAGE): void }
}

export function developmentRestartAvailable(runtime: RestartProcess): boolean {
  return runtime.env.SHADOW_DEV_RESTART_TOOL === '1'
    && runtime.env.SHADOW_DESKTOP_DEV_IPC === '1'
    && runtime.env.NODE_ENV !== 'production'
    && typeof runtime.parentPort?.postMessage === 'function'
}

/** One instance per backend process, shared by all Project catalogs. */
export class DevelopmentRestartTool implements Tool {
  readonly name = 'development_restart'
  readonly description = 'Restart the whole Shadow desktop app through its development supervisor (dev only). Saves and publishes the tool receipt first, then waits 1.5 seconds before requesting restart. Other sessions are interrupted. Only direct local admin invocations are supported; not scripts or recovery.'
  readonly parameters: ToolParameters = { type: 'object', properties: {}, additionalProperties: false }
  private pending = false

  constructor(
    private readonly runtime: RestartProcess = process as RestartProcess,
    private readonly schedule: (callback: () => void, delay: number) => void = (callback, delay) => { setTimeout(callback, delay).unref() },
    private readonly onError: (error: unknown) => void = error => console.error('[development-restart] Request failed:', error),
  ) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (!developmentRestartAvailable(this.runtime)) return 'Error: development restart is unavailable.'
    if (!context.admin || context.remoteWorkdir || context.scriptInvocation || context.recoveringToolCall
      || !context.afterToolResultPublished || context.toolCallName !== 'invoke_tool') {
      return 'Error: development restart requires a direct local admin invoke_tool call with a publishable receipt.'
    }
    if (Object.keys(args).length) return 'Error: development_restart accepts no arguments.'
    context.signal.throwIfAborted()
    if (this.pending) return 'Development restart is already pending.'
    // Reserve only once the host has persisted and published the result. Failed
    // persistence/output must never trigger a restart or poison future retries.
    context.afterToolResultPublished(() => {
      if (this.pending || context.signal.aborted || !developmentRestartAvailable(this.runtime)) return
      this.pending = true
      this.schedule(() => {
        if (!developmentRestartAvailable(this.runtime)) { this.pending = false; return }
        try { this.runtime.parentPort!.postMessage(RESTART_MESSAGE) }
        catch (error) { this.pending = false; this.onError(error) }
      }, DEVELOPMENT_RESTART_DELAY_MS)
    })
    return 'Development restart requested. This receipt is saved and published before a 1.5 second delay; Shadow will then restart and interrupt active sessions. Reconnect after startup.'
  }
}

export const developmentRestartTool = new DevelopmentRestartTool()

export function registerDevelopmentRestart(
  catalog: { registerBuiltin(name: string, tool: Tool): void },
  runtime: RestartProcess = process as RestartProcess,
  tool: DevelopmentRestartTool = developmentRestartTool,
): void {
  if (developmentRestartAvailable(runtime)) catalog.registerBuiltin(tool.name, tool)
}
