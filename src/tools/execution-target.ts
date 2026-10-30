import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from './tool.ts'

export const executionTargetParameters = {
  folder: { type: 'string' as const, description: 'Registered Folder in the current Project: unique short name, name-ID selector or full Folder ID. Selects its exact device and directory for this call only. Omit to retain session locality. Unavailable targets fail; no Main fallback or automatic device switch.' },
}

/** Resolve before filesystem, URL, virtual mount or shell handling; never change session locality. */
export async function executionTargetContext(
  args: Record<string, unknown>, context: ExecutionContext, operation: string,
): Promise<ExecutionContext> {
  if (args.resourceId !== undefined || args.workdirId !== undefined || args.target !== undefined || args.grant !== undefined) {
    throw new ToolNoEffectError('Directory tools accept a registered folder selector, not raw node/workdir addresses. No operation was executed.')
  }
  const legacy = args.nodeId !== undefined || args.capabilityId !== undefined
  if (args.folder === undefined && !legacy) return context
  if (legacy && (args.folder !== undefined || !context.recoveringToolCall ||
    operation !== 'workdir.process.execute-once')) {
    throw new ToolNoEffectError('Use folder to select a registered Project Folder, not nodeId/capabilityId. No operation was executed.')
  }
  if (/(?:^|[\\/])v:|^https?:/i.test(String(args.path ?? '').replaceAll('\\', '/')) || args.handler === 'web' || args.space !== undefined
    || args.handler === 'glob' && /^v:/i.test(String(args.query))) {
    throw new ToolNoEffectError('Explicit Folder selection supports ordinary filesystem paths and OS shells only, not virtual paths, URLs, web search or legacy search space.')
  }
  context.signal.throwIfAborted()
  let target: Awaited<ReturnType<NonNullable<ExecutionContext['resolveToolTarget']>>>
  if (legacy) {
    // Only host-stamped recovery interprets saved V1 arguments. It resolves the
    // original directory for reconciliation, never admits another command.
    if (typeof args.nodeId !== 'string' || !args.nodeId.trim() || typeof args.capabilityId !== 'string' || !args.capabilityId.trim()
      || !context.resolveStoredToolTarget) {
      throw new ToolOutcomeUnknownError('The saved execution target cannot be resolved for reconciliation. The original command outcome remains unknown; it was not re-executed and no fallback is allowed.')
    }
    try { target = await context.resolveStoredToolTarget(args.nodeId, args.capabilityId, operation) }
    catch (error) {
      throw new ToolOutcomeUnknownError(`The original execution target is unavailable for reconciliation: ${error instanceof Error ? error.message : String(error)}. The original outcome remains unknown; no command was re-executed.`)
    }
  } else {
    if (typeof args.folder !== 'string' || !args.folder.trim()) {
      throw new ToolNoEffectError('folder must be a nonempty registered Project Folder identifier, not a path.')
    }
    if (!context.resolveToolTarget) throw new ToolNoEffectError('Folder targeting is unavailable in this execution context; no fallback is allowed.')
    try { target = await context.resolveToolTarget(args.folder, operation) }
    catch (error) {
      if (context.recoveringToolCall) throw new ToolOutcomeUnknownError(`The original target cannot be reconciled: ${error instanceof Error ? error.message : String(error)}. The original outcome remains unknown; no command was re-executed.`)
      throw new ToolNoEffectError(error instanceof Error ? error.message : String(error))
    }
  }
  context.signal.throwIfAborted()
  return { ...context, cwd: target.cwd, remoteWorkdir: target.remoteWorkdir, fileChangeTarget: target.fileChangeTarget }
}
