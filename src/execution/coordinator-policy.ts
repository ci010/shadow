import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolResult } from '../tools/tool.ts'
import type { ToolExecutionPolicy } from '../tools/registry.ts'

export const LOCAL_EXECUTOR_DISABLED = 'Main local executor is disabled. Select an available Child workdir for supported execution; no Main fallback is allowed.'

/** A runtime-owned identity allowlist, not a sandbox or a tool-name permission. */
export class CoordinatorExecutionPolicy {
  private readonly allowed = new WeakSet<object>()
  private readonly remoteShells = new WeakSet<object>()

  allow(tool: object): void { this.allowed.add(tool) }
  allowRemoteShell(tool: object): void { this.remoteShells.add(tool) }
  canImport = (entry: object): boolean => this.allowed.has(entry)

  check: ToolExecutionPolicy = (tool: Tool<ToolResult>, args: Record<string, unknown>, context: ExecutionContext) => {
    // The virtual MCP writer performs executable contract discovery before saving.
    // Deny every spelling accepted by the VFS, not just the documented alias.
    if (tool.name === 'write' && typeof args.path === 'string' &&
      /^v:config(?:\/|$)/i.test(args.path.replace(/\\/g, '/').replace(/^\/+/, ''))) {
      return `Error: ${LOCAL_EXECUTOR_DISABLED} Executable MCP configuration writes are unavailable.`
    }
    if (this.allowed.has(tool)) return undefined
    if (this.remoteShells.has(tool) && context.remoteWorkdir) return undefined
    return `Error: ${LOCAL_EXECUTOR_DISABLED} Tool "${tool.name}" is not available in the coordinator capability profile.`
  }
}
