import { z } from 'zod'
import { createHash } from 'node:crypto'

/** A node service, not a native workdir operation or arbitrary script dispatcher. */
export const LAYERFS_REMOTE_OPERATION = 'layerfs.service'
export const LAYERFS_REMOTE_FEATURE = 'layerfs-service-v1'
export interface RemoteLayerFSLocation { version: 1; nodeId: string; pairingId: string; projectScope: string }
export const remoteLayerFSActions = ['doctor', 'setup_plan', 'setup', 'bootstrap_plan', 'bootstrap', 'bootstrap_status', 'bootstrap_cancel', 'bootstrap_reconcile',
  'runtime_plan', 'runtime_start', 'runtime_status', 'runtime_context', 'resource_register', 'resource_list',
  'resource_inspect', 'workspace_create', 'workspace_fork', 'read', 'write', 'search', 'exec', 'status',
  'mkdir', 'rm', 'cp', 'mv', 'apply', 'diff_files', 'blame', 'branches', 'history', 'diff_commits', 'reconcile', 'contexts_revoke'] as const
export const remoteLayerFSBranchActions = new Set<RemoteLayerFSAction>(['read', 'write', 'search', 'exec', 'status', 'mkdir', 'rm', 'cp', 'mv', 'apply', 'diff_files', 'blame', 'branches', 'history', 'diff_commits'])
export const remoteLayerFSProjectReadActions = new Set<RemoteLayerFSAction>(['doctor', 'bootstrap_status', 'runtime_status', 'resource_list', 'resource_inspect'])
const id = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
const reference = z.object({ sessionId: id, physicalId: id, requestId: id }).strict()
const question = z.object({ question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(4000)).min(2).max(3), defaultOption: z.string().min(1).max(4000) }).strict()
/** Filled by Main host only after reading real session/human records. The authenticated
 * paired connection is the issuer boundary. Never accepted as tool input. */
export const remoteLayerFSAuthoritySchema = z.object({
  version: z.literal(1), nodeId: id, pairingId: id, projectScope: z.string().regex(/^[a-f0-9]{32}$/),
  actorId: id, kind: z.enum(['direct-owner', 'workspace-session', 'project-host']), ownerSessionId: id, requestId: z.string().uuid(), action: z.enum(remoteLayerFSActions),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
  approval: z.object({ reference, question, plan: id }).strict().optional(),
}).strict()
export type RemoteLayerFSAuthority = z.infer<typeof remoteLayerFSAuthoritySchema>
export const remoteLayerFSReceiptSchema = z.object({ version: z.literal(1), requestId: z.string().uuid(), payloadHash: z.string(), actorId: z.string(), phase: z.enum(['dispatched', 'completed', 'unknown']), authority: remoteLayerFSAuthoritySchema.optional(), result: z.unknown().optional() }).strict()
export const remoteLayerFSCallSchema = z.object({
  version: z.literal(1), action: z.enum(remoteLayerFSActions), input: z.record(z.unknown()), authority: remoteLayerFSAuthoritySchema,
}).strict()
export type RemoteLayerFSCall = z.infer<typeof remoteLayerFSCallSchema>
export type RemoteLayerFSAction = RemoteLayerFSCall['action']
export const remoteLayerFSReadActions = new Set<RemoteLayerFSAction>(['doctor', 'bootstrap_status', 'bootstrap_reconcile', 'runtime_status', 'resource_list', 'resource_inspect', 'read', 'search', 'status', 'diff_files', 'blame', 'branches', 'history', 'diff_commits', 'reconcile'])
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value)
    if (result === undefined) throw new TypeError('LayerFS transport accepts JSON only')
    return result
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('LayerFS transport accepts plain JSON objects only')
  return '{' + Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
}
export function layerFSPayloadHash(action: RemoteLayerFSAction, input: Record<string, unknown>): string {
  const text = canonical({ action, input })
  if (Buffer.byteLength(text) > 262144) throw new TypeError('LayerFS request exceeds 256 KiB')
  return createHash('sha256').update(text).digest('hex')
}
export function validateRemoteLayerFSCall(value: unknown, target: { nodeId: string; pairingId: string; projectScope: string }, now = Date.now()): RemoteLayerFSCall {
  const call = remoteLayerFSCallSchema.parse(structuredClone(value))
  const a = call.authority
  if (a.nodeId !== target.nodeId || a.pairingId !== target.pairingId || a.projectScope !== target.projectScope || a.action !== call.action || a.payloadHash !== layerFSPayloadHash(call.action, call.input)) throw new Error('LayerFS host authority target, Project or payload mismatch')
  if (call.action === 'contexts_revoke') {
    if (a.kind !== 'project-host') throw new Error('Context revocation requires the owning Project host service')
  } else {
    if (a.kind === 'project-host') throw new Error('Project host assertion is revocation-only, never installer or management authority')
    if (!remoteLayerFSBranchActions.has(call.action) && !remoteLayerFSProjectReadActions.has(call.action) && a.kind !== 'direct-owner') throw new Error('LayerFS management requires a verified direct-owner host assertion')
  }
  if (Date.parse(a.expiresAt) <= now || Date.parse(a.expiresAt) > now + 300000) throw new Error('LayerFS host authority expired or exceeds admission lifetime')
  if (['bootstrap', 'setup'].includes(call.action) && (!a.approval || a.approval.plan !== call.input.plan)) throw new Error('LayerFS installation requires its exact host-verified human plan decision')
  return call
}
export function remoteLayerFSTargetQuestion(nodeId: string, projectScope: string, plan: string, text: string): string {
  return `Target Windows device ${nodeId}; Project ${projectScope}; plan ${plan}.\n${text}`
}
