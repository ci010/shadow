import { DEVICE_HOME_WORKDIR, deviceHomeNode } from '../execution/device-home.ts'
import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from './tool.ts'

const registeredWorkspace = { type: 'string' as const, description: 'Registered Workspace in the current Project: unique short name, name-ID selector or full Workspace ID. Uses that workspace on its actual local, remote or LayerFS backend for this call only; omit to retain the selected workspace. Location is reported in workspace metadata. Unavailable targets fail without Main fallback or automatic device switching. LayerFS accepts versioned branch-backed layerfs: IDs (not legacy mounts): UTF-8 read/list, exact edit/overwrite and literal grep/glob via SDK; writes checkpoint automatically. No append/global edit, binary input or grep include. Exec mounts current branch, checkpoints even nonzero exit, then unmounts; independent branches run concurrently while overlapping branch operations are reserved.' }

export const registeredWorkspaceParameters = { workspace: registeredWorkspace }
export const executionTargetParameters = {
  workspace: { ...registeredWorkspace, description: `${registeredWorkspace.description} In a direct owner Web turn, device:<nodeId> runs OS-shell exec from the Child's home by default. Direct read/search access to Child home requires opt-in.` },
}

/** Hidden compatibility for saved calls; never normalize third-party tool arguments. */
export function workspaceArguments(args: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(args, 'folder') && Object.hasOwn(args, 'workspace')) {
    throw new ToolNoEffectError('Use workspace, not both workspace and legacy folder. No operation was executed.')
  }
  if (!Object.hasOwn(args, 'folder')) return args
  const { folder, ...rest } = args
  return { ...rest, workspace: folder }
}

/** Resolve before filesystem, URL, virtual mount or shell handling; never change session locality. */
export async function executionTargetContext(
  args: Record<string, unknown>, context: ExecutionContext, operation: string,
): Promise<ExecutionContext> {
  args = workspaceArguments(args)
  if (args.resourceId !== undefined || args.workdirId !== undefined || args.target !== undefined || args.grant !== undefined) {
    throw new ToolNoEffectError('Directory tools accept a registered workspace selector, not raw node/workdir addresses. No operation was executed.')
  }
  const legacy = args.nodeId !== undefined || args.capabilityId !== undefined
  if (args.workspace === undefined && !legacy) return context
  if (legacy && (args.workspace !== undefined || !context.recoveringToolCall ||
    operation !== 'workdir.process.execute-once')) {
    throw new ToolNoEffectError('Use workspace to select a registered Project Workspace, not nodeId/capabilityId. No operation was executed.')
  }
  if (/(?:^|[\\/])v:|^https?:/i.test(String(args.path ?? '').replaceAll('\\', '/')) || args.handler === 'web' || args.space !== undefined
    || args.handler === 'glob' && /^v:/i.test(String(args.query))) {
    throw new ToolNoEffectError('Explicit Workspace selection supports ordinary filesystem paths and OS shells only, not virtual paths, URLs, web search or legacy search space.')
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
    if (typeof args.workspace !== 'string' || !args.workspace.trim()) {
      throw new ToolNoEffectError('workspace must be a nonempty registered Project Workspace identifier, not a path.')
    }
    if (args.workspace.startsWith('device:') && (context.scriptInvocation || !['filesystem.read', 'workdir.process.execute-once'].includes(operation))) {
      throw new ToolNoEffectError('Device home supports direct owner reads, searches and OS-shell execution only. No Main fallback is allowed.')
    }
    if (args.workspace.startsWith('layerfs:')) return { ...context, cwd: undefined, remoteWorkdir: undefined, layerfsWorkdir: { workspace: args.workspace }, fileChangeTarget: undefined }
    if (!context.resolveToolTarget) throw new ToolNoEffectError('Workspace targeting is unavailable in this execution context; no fallback is allowed.')
    try {
      const deviceNodeId = args.workspace.startsWith('device:') ? deviceHomeNode(args.workspace) : undefined
      target = await context.resolveToolTarget(args.workspace, operation)
      if (deviceNodeId && (target.remoteWorkdir?.nodeId !== deviceNodeId || target.remoteWorkdir.workdirId !== DEVICE_HOME_WORKDIR
        || target.cwd !== undefined || target.layerfsWorkdir !== undefined)) {
        throw new Error('Device home target unavailable or mismatched. No Main fallback is allowed.')
      }
    } catch (error) {
      if (context.recoveringToolCall) throw new ToolOutcomeUnknownError(`The original target cannot be reconciled: ${error instanceof Error ? error.message : String(error)}. The original outcome remains unknown; no command was re-executed.`)
      throw new ToolNoEffectError(error instanceof Error ? error.message : String(error))
    }
  }
  context.signal.throwIfAborted()
  return { ...context, cwd: target.cwd, remoteWorkdir: target.remoteWorkdir, layerfsWorkdir: target.layerfsWorkdir, fileChangeTarget: target.fileChangeTarget }
}
