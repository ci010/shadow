import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools } from '../tools/registry.ts'
import type { ToolResult } from '../tools/tool.ts'

/** Independent snapshot borrowing resources only while the caller awaits this leaf. */
export class CallTools extends SessionTools {
  private readonly caller: SessionTools
  constructor(caller: SessionTools, workspace: string, allowed?: string[], blocked?: string[], allowedModules?: readonly string[]) {
    const snapshot = caller.snapshot()
    const modules = allowedModules === undefined ? caller.allowedModules
      : caller.allowedModules === undefined ? allowedModules : allowedModules.filter(name => caller.allowedModules!.includes(name))
    super(snapshot, workspace, allowed, blocked, modules)
    this.caller = snapshot
  }
  override canUseDynamic(name: string): boolean {
    return super.canUseDynamic(name) && this.caller.canUseDynamic(name)
  }
  override get dynamicOwner(): SessionTools { return this.caller.dynamicOwner }
  override get ownerSignal(): AbortSignal { return this.caller.ownerSignal }
  override hasDynamic(name: string): boolean {
    return this.canUseDynamic(name) && (super.hasDynamic(name) || this.caller.hasDynamic(name))
  }
  override activeDynamicTools() {
    const tools = new Map([...this.caller.activeDynamicTools(), ...super.activeDynamicTools()].map(tool => [tool.name, tool]))
    return [...tools.values()].filter(tool => this.canUseDynamic(tool.name))
  }
  override async execute(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    const denial = this.executionDenial(name, args)
    if (denial) return denial
    if (!this.has(name)) return this.rejectExecution(`tool "${name}" is unavailable in the caller/role capability intersection.`)
    return super.execute(name, args, context)
  }
  override async executeDynamic(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    const denial = this.executionDenial(name, args)
    if (denial) return denial
    if (!this.canUseDynamic(name)) return this.rejectExecution(`dynamic tool "${name}" is unavailable to this call.`)
    return super.hasDynamic(name) ? super.executeDynamic(name, args, context) : this.caller.executeDynamic(name, args, context)
  }
}
