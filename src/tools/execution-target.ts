import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError } from './tool.ts'

export const executionTargetParameters = {
  nodeId: { type: 'string' as const, description: 'Explicit execution device ID (not shell=node). Requires capabilityId. Omit both to keep session locality; never falls back to Main.' },
  capabilityId: { type: 'string' as const, description: 'Project-authorized workdir capability on nodeId, not a path. Required with nodeId; relative paths use this capability root.' },
}

/** Resolve once before any filesystem, URL, virtual mount or shell handling. */
export function executionTargetContext(args: Record<string, unknown>, context: ExecutionContext): ExecutionContext {
  if (args.nodeId === undefined && args.capabilityId === undefined) return context
  if (typeof args.nodeId !== 'string' || !args.nodeId.trim() || typeof args.capabilityId !== 'string' || !args.capabilityId.trim()) {
    throw new ToolNoEffectError('Explicit execution targeting requires nonempty nodeId and capabilityId together.')
  }
  if (/(?:^|[\\/])v:|^https?:/i.test(String(args.path ?? '').replaceAll('\\', '/')) || args.handler === 'web' || args.space !== undefined
    || args.handler === 'glob' && /^v:/i.test(String(args.query))) {
    throw new ToolNoEffectError('Explicit device selection supports ordinary filesystem paths and OS shells only, not virtual paths, URLs, web search or legacy search space.')
  }
  if (!context.resolveToolTarget) throw new ToolNoEffectError('Explicit device selection is unavailable in this execution context; no fallback is allowed.')
  const target = context.resolveToolTarget(args.nodeId, args.capabilityId)
  return { ...context, cwd: target.cwd, remoteWorkdir: target.remoteWorkdir, fileChangeTarget: { nodeId: args.nodeId, capabilityId: args.capabilityId } }
}
