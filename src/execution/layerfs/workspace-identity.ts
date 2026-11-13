import { ToolNoEffectError } from '../../tools/tool.ts'

export interface LayerFSBranchWorkspace { version: 2 | 3; project: string; branch: string; ownerProject?: string; runtimeId?: string; resourceId?: string }
export function branchWorkspace(project: string, branch: string, binding?: { ownerProject: string; runtimeId: string; resourceId: string }): string {
  return 'layerfs:' + Buffer.from(JSON.stringify({ version: binding ? 3 : 2, project, branch, ...binding })).toString('base64url')
}
export function parseBranchWorkspace(value: string, project?: string): LayerFSBranchWorkspace {
  let identity: LayerFSBranchWorkspace
  try { identity = JSON.parse(Buffer.from(value.replace(/^layerfs:/, ''), 'base64url').toString()) } catch { throw new ToolNoEffectError('Invalid LayerFS workspace ID.') }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new ToolNoEffectError('Invalid LayerFS workspace ID.')
  if (project !== undefined && identity.project !== project) throw new ToolNoEffectError('Workspace belongs to another Project or quarantined namespace.')
  if (![2, 3].includes(identity.version)) throw new ToolNoEffectError('Legacy LayerFS mount IDs are not routable. Retained resources are not removed or inferred.')
  const keys = identity.version === 3 ? ['version', 'project', 'branch', 'ownerProject', 'runtimeId', 'resourceId'] : ['version', 'project', 'branch']
  if (!value.startsWith('layerfs:') || typeof identity.project !== 'string' || typeof identity.branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(identity.branch) || identity.branch.split('/').includes('..') || Object.keys(identity).some(k => !keys.includes(k))) throw new ToolNoEffectError('Invalid LayerFS branch workspace ID.')
  if (identity.version === 3 && (typeof identity.ownerProject !== 'string' || !identity.ownerProject || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(identity.runtimeId ?? '') || !/^[a-f0-9-]{36}$/.test(identity.resourceId ?? ''))) throw new ToolNoEffectError('Invalid immutable resource binding.')
  return identity
}
