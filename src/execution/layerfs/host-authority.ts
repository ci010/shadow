import type { ExecutionContext } from '../../tools/context.ts'
import type { YieldQuestion, YieldReference } from '../../sessions/yield-contract.ts'
import { remoteLayerFSTargetQuestion, validateRemoteLayerFSCall, type RemoteLayerFSAction, type RemoteLayerFSCall } from './remote-contract.ts'

interface Admission { call: RemoteLayerFSCall; projectId: string; sessionId: string; signal: AbortSignal; active: boolean }
const admissions = new WeakMap<ExecutionContext, Admission>()
/** Only target service dispatch may issue a context. No admin/channel/tools booleans are fabricated.
 * Call after verifying the authenticated connection and Main host assertion. Never export to tools. */
export async function withLayerFSHostAuthority<T>(value: unknown, target: { nodeId: string; pairingId: string; projectScope: string }, signal: AbortSignal,
  run: (context: ExecutionContext, call: RemoteLayerFSCall) => Promise<T>): Promise<T> {
  const call = validateRemoteLayerFSCall(value, target)
  signal.throwIfAborted()
  const context = { projectId: target.projectScope, sessionId: call.authority.ownerSessionId, signal } as ExecutionContext
  const admission: Admission = { call, projectId: context.projectId!, sessionId: context.sessionId, signal, active: true }
  admissions.set(context, admission)
  try { return await run(context, call) }
  finally { admission.active = false; admissions.delete(context) }
}
/** An exact-object, one-dispatch sidecar; copying, changing scope or reusing after return fails.
 * Dispatch must match action before calling any existing local service. */
export function hasLayerFSHostAuthority(context: ExecutionContext, action?: RemoteLayerFSAction): boolean {
  const a = admissions.get(context)
  return !!a && a.active && !a.signal.aborted && a.projectId === context.projectId && a.sessionId === context.sessionId && a.signal === context.signal
    && Date.parse(a.call.authority.expiresAt) > Date.now() && (action === undefined ? a.call.authority.kind === 'direct-owner' : a.call.action === action)
}
export function verifyLayerFSHostApproval(question: YieldQuestion, reference: YieldReference, context: ExecutionContext): boolean {
  if (!hasLayerFSHostAuthority(context, 'bootstrap') && !hasLayerFSHostAuthority(context, 'setup')) return false
  const a = admissions.get(context)!.call.authority
  const approval = a.approval
  return !!approval && approval.reference.sessionId === reference.sessionId && approval.reference.physicalId === reference.physicalId
    && approval.reference.requestId === reference.requestId && reference.sessionId === a.ownerSessionId
    && approval.question.question === remoteLayerFSTargetQuestion(a.nodeId, a.projectScope, approval.plan, question.question)
    && JSON.stringify(approval.question.options) === JSON.stringify(question.options) && approval.question.defaultOption === question.defaultOption
}
