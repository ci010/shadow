import type { ExecutionContext } from '../../tools/context.ts'
import { isOwnerSession } from '../../sessions/owner-policy.ts'
import type { SessionState } from '../../sessions/session-store.ts'
import type { YieldDecisionRecord } from '../../sessions/yield-contract.ts'
import { parseYieldReference } from '../../sessions/yield-contract.ts'
import { matchesBootstrapApproval } from './bootstrap.ts'
import { managedProjectScope } from '../managed-workdir.ts'
import type { RemoteLayerFSConsentPlans } from './remote-consent.ts'
import { remoteLayerFSBranchActions, remoteLayerFSProjectReadActions } from './remote-contract.ts'
import type { VerifyRemoteLayerFSOwner } from './remote-client.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'

const ordinary = remoteLayerFSBranchActions
/** Authoritative Main service adapter. No caller-supplied admin/approval arguments
 * are used to establish identity, ownership, or a human decision. */
export function remoteLayerFSOwnerVerifier(options: {
  projectId: string
  consent?: RemoteLayerFSConsentPlans
  state: (session: string) => SessionState | null | undefined
  assertFolderAccess: (session: string) => void
  records: (session: string, physical: string) => Promise<YieldDecisionRecord[]>
}): VerifyRemoteLayerFSOwner {
  return async (context, target, action, input) => {
    if (context.projectId !== options.projectId || target.projectScope !== managedProjectScope(options.projectId) || context.recoveringToolCall || context.memoryAccess) throw new ToolNoEffectError('Direct current-Project LayerFS invocation required; no script or recovery replay')
    const state = options.state(context.sessionId)
    if (!state || state.projectId !== options.projectId) throw new ToolNoEffectError('LayerFS session does not belong to this Project')
    options.assertFolderAccess(context.sessionId)
    const projectRead = remoteLayerFSProjectReadActions.has(action)
    if (projectRead && context.scriptInvocation) throw new ToolNoEffectError('Direct current-Project LayerFS observation required')
    if (!ordinary.has(action) && !projectRead) {
      if (context.scriptInvocation || !isOwnerSession(state, options.projectId) || context.channel !== 'web' || context.admin !== true || context.isGroup || context.tools?.executionMode !== 'session' || context.tools.dynamicOwner !== context.tools) throw new ToolNoEffectError('Remote LayerFS lifecycle requires a direct durable owner Web session')
    } else if (ordinary.has(action) && typeof input.workspace !== 'string') throw new ToolNoEffectError('Remote LayerFS ordinary operation requires a registered workspace binding')
    if (!context.senderId) throw new ToolNoEffectError('LayerFS host actor identity missing')
    if (action !== 'bootstrap' && action !== 'setup') return { actorId: context.senderId, authorityKind: ordinary.has(action) || projectRead ? 'workspace-session' : 'direct-owner' }
    const reference = parseYieldReference(input.approval)
    if (reference.sessionId !== context.sessionId || typeof input.plan !== 'string') throw new ToolNoEffectError('Exact current-owner installation decision required')
    const records = await options.records(reference.sessionId, reference.physicalId)
    const record = records.find(value => value.request.id === reference.requestId && value.request.origin?.physicalId === reference.physicalId)
    const question = record && { question: record.request.question, options: record.request.options, defaultOption: record.request.defaultOption }
    const canonical = options.consent?.question(target, context, input.plan)
    if (!canonical || !question || question.question !== canonical.question || JSON.stringify(question.options) !== JSON.stringify(canonical.options) || question.defaultOption !== canonical.defaultOption
      || !matchesBootstrapApproval(canonical, reference, records, context.sessionId)) throw new ToolNoEffectError('Recorded human answer does not approve this exact canonical target/Project/plan; obtain a fresh target plan after restart or expiry')
    return { actorId: context.senderId, authorityKind: 'direct-owner', approval: { reference, question, plan: input.plan } }
  }
}
