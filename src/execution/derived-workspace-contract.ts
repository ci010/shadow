import type { DerivedWorkspaceReceipt } from '../folders/derived-workspace.ts'
export type { DerivedWorkspaceReceipt } from '../folders/derived-workspace.ts'
import { isExecutionIdentifier, validateWorkdirAdvertisement, type WorkdirAdvertisement } from './workdir-contracts.ts'

export const DERIVED_WORKSPACE_OPERATION = 'workdir.git.derive'
export type DerivedWorkspaceArgs =
  | { action: 'inspect' }
  | { action: 'create'; key: string; branch: string; description?: string; name?: string }
  | { action: 'verify'; key: string }
export interface DerivedWorkspaceInspectResult {
  version: 1
  nodeId: string
  sourceWorkdirId: string
  branch: string
}
export interface DerivedWorkspaceResult {
  version: 1
  nodeId: string
  sourceWorkdirId: string
  workdir: WorkdirAdvertisement
  receipt: DerivedWorkspaceReceipt & { workspaceId: string }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(v)
function strict(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new TypeError('Unknown derived workspace field')
}
function invalid(): never { throw new TypeError('Invalid derived workspace contract') }
export function parseDerivedWorkspaceArgs(value: unknown): DerivedWorkspaceArgs {
  if (!record(value)) invalid()
  if (value.action === 'inspect') strict(value, ['action'])
  else if (value.action === 'verify' || value.action === 'create') {
    strict(value, value.action === 'verify' ? ['action', 'key'] : ['action', 'key', 'branch', 'description', 'name'])
    if (!text(value.key, 256)) invalid()
    if (value.action === 'create' && (!text(value.branch) ||
      (value.description !== undefined && value.description !== '' && !text(value.description)) ||
      (value.name !== undefined && (typeof value.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.name))))) invalid()
  } else invalid()
  return structuredClone(value) as DerivedWorkspaceArgs
}
function envelope(value: unknown): Record<string, unknown> {
  if (!record(value) || value.version !== 1 || !isExecutionIdentifier(value.nodeId) || !isExecutionIdentifier(value.sourceWorkdirId)) invalid()
  return value
}
export function parseDerivedWorkspaceInspectResult(value: unknown): DerivedWorkspaceInspectResult {
  const item = envelope(value)
  strict(item, ['version', 'nodeId', 'sourceWorkdirId', 'branch'])
  if (!text(item.branch)) invalid()
  return structuredClone(item) as unknown as DerivedWorkspaceInspectResult
}
/** Paths are opaque Child display snapshots, including Windows paths, never Main addresses. */
export function parseDerivedWorkspaceResult(value: unknown): DerivedWorkspaceResult {
  const item = envelope(value)
  strict(item, ['version', 'nodeId', 'sourceWorkdirId', 'workdir', 'receipt'])
  const workdir = validateWorkdirAdvertisement(item.workdir)
  if (!workdir.success || !workdir.value.online || workdir.value.nodeId !== item.nodeId) invalid()
  const receipt = item.receipt
  if (!record(receipt)) invalid()
  strict(receipt, ['backend', 'projectId', 'sourceId', 'sourcePath', 'commonDir', 'commonIdentity', 'path', 'branch', 'baseBranch', 'baseCommit', 'description', 'workKey', 'workspaceId'])
  if (receipt.backend !== 'git-worktree' || typeof receipt.projectId !== 'string' || !/^[0-9a-f]{32}$/.test(receipt.projectId) ||
    receipt.sourceId !== item.sourceWorkdirId || receipt.workspaceId !== workdir.value.workdirId ||
    receipt.workspaceId === receipt.sourceId || workdir.value.displayPath !== receipt.path ||
    !text(receipt.sourcePath, 32768) || !text(receipt.commonDir, 32768) || !text(receipt.path, 32768) ||
    typeof receipt.commonIdentity !== 'string' || !/^\d+:\d+$/.test(receipt.commonIdentity) ||
    typeof receipt.branch !== 'string' || !/^shadow(?:\/|-)derived-[0-9a-f-]{36}$/.test(receipt.branch) ||
    !text(receipt.baseBranch) || typeof receipt.baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(receipt.baseCommit) ||
    typeof receipt.description !== 'string' || receipt.description.length > 65536 || receipt.description.includes('\0') ||
    (receipt.workKey !== undefined && !text(receipt.workKey))) invalid()
  return structuredClone(item) as unknown as DerivedWorkspaceResult
}
