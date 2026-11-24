import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { McpServerConfig } from '../config/schema.ts'
import { McpConnection } from '../mcp/client.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, type ToolResult } from '../tools/tool.ts'
import type { SessionTools } from '../tools/registry.ts'
import { verifyAgentDesktopAssets, agentDesktopDirectory } from '../../scripts/agent-desktop-integrity.ts'
import { DesktopStdioTransport } from './transport.ts'

export const DESKTOP_DESCRIPTION = 'Official agent-desktop MCP v1.2.0. Targets the Main host even with a Child workdir selected. Broad logged-in-user desktop access: applications, screenshots, input, clipboard and application launch within host OS permissions; NOT isolated to a bound window and NOT excluding Shadow/browser windows. Use only task-relevant content, obtain existing consequence confirmations before consequential operations, and never replay an unknown outcome. Source initialization only discovers official tools. Guide: v:skills/computer-use.'

/** One gate per physical host process, shared across every Project/conversation.
 * No API silently clears uncertainty. An operator must establish an idle desktop
 * and restart the host before resuming after an unknown dispatched outcome. */
export class DesktopDeviceGate {
  private tail = Promise.resolve()
  private blocked?: string
  block(reason: string): void { this.blocked ??= reason }
  assertReady(): void {
    if (this.blocked) throw new ToolNoEffectError(`Desktop device is blocked: ${this.blocked}. Do not retry the action. Ask the user to verify that desktop activity has stopped, reconcile the intended effect, and restart Shadow before resuming desktop use.`)
  }
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    let release!: () => void
    const own = new Promise<void>(resolve => { release = resolve })
    const previous = this.tail
    this.tail = previous.then(() => own)
    let onAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try {
      await Promise.race([previous, cancelled])
      signal.throwIfAborted()
      this.assertReady()
      return await action()
    } finally { signal.removeEventListener('abort', onAbort); release() }
  }
}
export const desktopDeviceGate = new DesktopDeviceGate()

export class DesktopConnection extends McpConnection {
  private desktopTransport?: DesktopStdioTransport
  constructor(config: McpServerConfig, private gate: DesktopDeviceGate,
    private validate: (context: ExecutionContext) => void = () => {},
    private grace?: { eof: number; term: number }) { super(config) }
  override validateContext(context: ExecutionContext): void { this.validate(context) }
  protected override async createTransport(config: McpServerConfig, signal: AbortSignal) {
    signal.throwIfAborted()
    // Do not load workspace dotenv or inherit desktop scope/preload injection.
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
      !/^(AGENT_DESKTOP_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$|NODE_PATH$)/.test(entry[0].toUpperCase())))
    this.desktopTransport = new DesktopStdioTransport(config.command!, config.args ?? [], { ...env, ...config.env }, reason => this.gate.block(reason), this.grace)
    return this.desktopTransport
  }
  override async callToolInContext(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    const authorize = () => {
      this.validateContext(context)
      if (!context.tools.canUseDynamic(`${this.config.name}__${name}`)) throw new ToolNoEffectError('Desktop tool is unavailable for this role')
    }
    authorize()
    // Capture this call's authority, not a mutable connection-level context.
    return this.runTool(name, args, context.signal, authorize)
  }
  override async callTool(name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<ToolResult> {
    return this.runTool(name, args, signal)
  }
  private async runTool(name: string, args: Record<string, unknown>, signal: AbortSignal, authorize: () => void = () => {}): Promise<ToolResult> {
    return this.gate.run(signal, async () => {
      authorize() // Revalidate after queue wait, before any dispatch/unknown marking.
      const before = this.desktopTransport?.dispatched ?? 0
      const audit = (event: string) => console.info('[desktop-mcp]', JSON.stringify({ event,
        generation: this.config.env?.AGENT_DESKTOP_AGENT_ID, tool: name }))
      audit('admitted')
      try {
        const result = await super.callTool(name, args, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
        audit('completed')
        return result
      } catch (error) {
        if ((this.desktopTransport?.dispatched ?? 0) > before) {
          audit('outcome-unknown-device-blocked')
          this.gate.block('A dispatched desktop action has no confirmed result')
          try { await this.disconnect() } catch { /* blocked gate retains cleanup uncertainty */ }
          throw new ToolOutcomeUnknownError('Desktop outcome unknown after dispatch; the device is blocked. Do not replay. Ask the user to inspect/reconcile the desktop, ensure activity has stopped, and restart Shadow before further desktop actions.')
        }
        throw error
      }
    })
  }
}

/** Reserved built-in MCP source. Configuration is derived from host identity,
 * never from model arguments, project config, workspace files or PATH. */
export function managedDesktopSource(projectId: string, workspace: string,
  assertSession: (id: string) => void, enabled: boolean, assetsRoot = fileURLToPath(new URL('../../', import.meta.url)), verifyAssets = verifyAgentDesktopAssets) {
  const bindings = new WeakMap<SessionTools, { sessionId: string; config: McpServerConfig }>()
  const root = assetsRoot
  const command = join(agentDesktopDirectory(root, process.platform, process.arch), process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop')
  const authorize = (context: ExecutionContext) => {
    context.signal.throwIfAborted()
    if (!enabled || context.projectId !== projectId || context.channel !== 'web'
      || context.tools.dynamicOwner !== context.tools || context.tools.executionMode !== 'session') {
      throw new ToolNoEffectError('Desktop MCP targets Main and requires host-device authorization in the owning web conversation; no Child desktop or borrowed execution.')
    }
    if (!context.tools.canUseDynamic('agent-desktop')) {
      throw new ToolNoEffectError('Desktop MCP is unavailable for this role')
    }
    assertSession(context.sessionId)
    desktopDeviceGate.assertReady()
    const existing = bindings.get(context.tools)
    if (existing && existing.sessionId !== context.sessionId) throw new ToolNoEffectError('Desktop MCP conversation binding mismatch')
    if (!existing) {
      const scope = createHash('sha256').update(`${projectId}\0${context.sessionId}`).digest('hex')
      const id = randomUUID()
      bindings.set(context.tools, { sessionId: context.sessionId, config: {
        name: 'agent-desktop', description: DESKTOP_DESCRIPTION, transport: 'stdio', command,
        args: ['--session', id, 'mcp'], env: { AGENT_DESKTOP_HOME: join(workspace, 'desktop-mcp', scope, id), AGENT_DESKTOP_AGENT_ID: id },
      } })
    }
  }
  return { config: { name: 'agent-desktop', description: DESKTOP_DESCRIPTION, transport: 'stdio' as const, command },
    supportsRemoteWorkdir: true,
    managed: {
      authorize,
      configuration: async (tools: SessionTools) => {
        const binding = bindings.get(tools)
        if (!binding) throw new ToolNoEffectError('Desktop MCP must first be authorized by its owning conversation')
        tools.ownerSignal.throwIfAborted()
        assertSession(binding.sessionId)
        desktopDeviceGate.assertReady()
        await verifyAssets(root)
        await mkdir(binding.config.env!.AGENT_DESKTOP_HOME, { recursive: true, mode: 0o700 })
        return binding.config
      },
      connection: (config: McpServerConfig, tools: SessionTools) => new DesktopConnection(config, desktopDeviceGate, context => {
        authorize(context)
        if (context.tools !== tools) throw new ToolNoEffectError('Desktop MCP cannot be borrowed by another tool owner')
      }),
    },
  }
}
