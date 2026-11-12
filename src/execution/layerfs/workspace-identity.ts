import { ToolNoEffectError } from '../../tools/tool.ts'

export interface LayerFSBranchWorkspace { version: 2; project: string; branch: string }
export function branchWorkspace(project: string, branch: string): string {
  return 'layerfs:' + Buffer.from(JSON.stringify({ version: 2, project, branch })).toString('base64url')
}
export function parseBranchWorkspace(value: string, project?: string): LayerFSBranchWorkspace {
  let identity: LayerFSBranchWorkspace
  try { identity = JSON.parse(Buffer.from(value.replace(/^layerfs:/, ''), 'base64url').toString()) } catch { throw new ToolNoEffectError('Invalid LayerFS workspace ID.') }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new ToolNoEffectError('Invalid LayerFS workspace ID.')
  if (project !== undefined && identity.project !== project) throw new ToolNoEffectError('Workspace belongs to another Project or quarantined namespace.')
  if (identity.version !== 2) throw new ToolNoEffectError('Legacy LayerFS mount IDs cannot use ordinary file/exec tools. Inspect status, explicitly checkpoint and close the old mount, then workspace_create backend=layerfs from its known branch. Records and uncommitted changes are retained; no branch is inferred.')
  if (!value.startsWith('layerfs:') || typeof identity.project !== 'string' || typeof identity.branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(identity.branch) || identity.branch.split('/').includes('..') || Object.keys(identity).some(k => !['version', 'project', 'branch'].includes(k))) throw new ToolNoEffectError('Invalid LayerFS branch workspace ID.')
  return identity
}
