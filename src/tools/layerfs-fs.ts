import { executionTargetContext, executionTargetParameters } from './execution-target.ts'
import { ToolNoEffectError, completedToolFailure, type Tool, type ToolParameters, type ToolResult } from './tool.ts'
import type { LayerFSResources } from '../execution/layerfs/resource-service.ts'
import { parseBranchWorkspace } from '../execution/layerfs/workspace-identity.ts'

// Positional signatures and apply fields: pinned @layerfs/agent agent.md and fs/apply.js.
const path = { type: 'string' as const, description: 'Absolute path within the selected LayerFS branch.' }
const changes = { type: 'array' as const, description: 'Ordered official fs.apply changes: write {path,content}, edit {path,oldText,newText}, mkdir/rm {path}, cp/mv {from,to}. One atomic publication; text only.', items: { type: 'object' as const, additionalProperties: false, required: ['op'], properties: Object.fromEntries(['op','path','content','oldText','newText','from','to'].map(key => [key, { type: 'string' }])) } }
const operations: Record<string, Record<string, typeof path | typeof changes | { type: 'integer'; minimum: number }>> = {
  mkdir: { path }, rm: { path }, cp: { from: path, to: path }, mv: { from: path, to: path }, apply: { changes },
  diff_files: { leftPath: path, rightPath: path, rightRef: { type: 'string', description: 'SDK ref within this same registered resource.' } },
  blame: { path, fromLine: { type: 'integer', minimum: 1 } },
}
export function layerfsFSContracts() {
  return Object.entries(operations).map(([action, fields]) => ({ name: `layerfs_fs_${action}`, supportsLayerFSWorkdir: true,
    description: `Official LayerFS fs.${action} on a registered current-Project workspace; lazily ensures its previously-ready runtime after validation. ${['blame', 'diff_files'].includes(action) ? 'Read-only committed state.' : 'Commits automatically; main is readonly. Unknown outcomes are never replayed.'}`,
    parameters: { type: 'object', additionalProperties: false, properties: { workspace: executionTargetParameters.workspace, ...fields }, required: Object.keys(fields).filter(key => key !== 'fromLine') } as ToolParameters,
  }))
}
function validatePath(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').includes('..')) throw new ToolNoEffectError('Absolute LayerFS path without traversal required.')
}
export function validateFSInput(action: string, input: Record<string, unknown>) {
  if (!Object.hasOwn(operations, action)) throw new ToolNoEffectError('Unsupported filesystem operation.')
  for (const key of Object.keys(input)) if (key !== 'workspace' && !Object.hasOwn(operations[action]!, key)) throw new ToolNoEffectError(`Unexpected ${key}.`)
  for (const key of Object.keys(operations[action]!)) {
    if (key === 'fromLine') {
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1)) throw new ToolNoEffectError('Invalid fromLine.')
      continue
    }
    if (input[key] === undefined) throw new ToolNoEffectError(`Missing ${key}.`)
    if (key !== 'changes' && key !== 'rightRef') validatePath(input[key])
  }
  if (action === 'diff_files' && (typeof input.rightRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(input.rightRef) || input.rightRef.split('/').includes('..'))) throw new ToolNoEffectError('Invalid rightRef.')
  if (action === 'apply') {
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 100) throw new ToolNoEffectError('apply requires 1–100 ordered changes.')
    const fields: Record<string, string[]> = { write: ['path', 'content'], edit: ['path', 'oldText', 'newText'], mkdir: ['path'], rm: ['path'], cp: ['from', 'to'], mv: ['from', 'to'] }
    for (const item of input.changes) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(fields, item.op)) throw new ToolNoEffectError('Invalid apply change.')
      const keys = fields[item.op]!
      if (Object.keys(item).some(k => k !== 'op' && !keys.includes(k))) throw new ToolNoEffectError('Unexpected apply field.')
      for (const key of keys) {
        if (['path', 'from', 'to'].includes(key)) validatePath(item[key])
        else if (typeof item[key] !== 'string' || item[key].includes('\0')) throw new ToolNoEffectError('Text apply content required.')
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new ToolNoEffectError('Filesystem request exceeds 64 KiB.')
}
export function createLayerFSFSTools(service: LayerFSResources): Tool<ToolResult>[] {
  return layerfsFSContracts().map(contract => ({ ...contract, async execute(input, context) {
    const action = contract.name.slice('layerfs_fs_'.length)
    validateFSInput(action, input)
    if (context.projectId !== service.projectId || context.remoteWorkdir || context.recoveringToolCall) throw new ToolNoEffectError('Current-Project invocation required; no replay/fallback.')
    const target = await executionTargetContext(input, context, ['blame', 'diff_files'].includes(action) ? 'filesystem.read' : 'filesystem.write')
    const workspace = target.layerfsWorkdir?.workspace
    if (!workspace || target.remoteWorkdir) throw new ToolNoEffectError('Registered LayerFS workspace required; no host fallback.')
    const binding = parseBranchWorkspace(workspace)
    if (binding.version !== 3 || binding.ownerProject !== service.projectId || !service.catalog.hasWorkspace(workspace)) throw new ToolNoEffectError('Unregistered current-Project LayerFS binding.')
    if (binding.branch === 'main' && !['blame', 'diff_files'].includes(action)) throw new ToolNoEffectError('main is readonly; fork a branch.')
    const output = await service.execute(action, { ...input, workspace }, target)
    if (typeof output === 'string' && JSON.parse(output).ok === false) return completedToolFailure({ isError: true, content: [{ type: 'text', text: output }] })
    return output
  } }))
}
