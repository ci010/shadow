import { z } from 'zod'
import { managedProjectScope } from '../managed-workdir.ts'
import type { RemoteLayerFSTarget } from './remote-client.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { YieldQuestion } from '../../sessions/yield-contract.ts'
import { remoteLayerFSTargetQuestion } from './remote-contract.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'
const planResult = z.object({ ok: z.literal(true), result: z.object({ plan: z.string().min(1), approvalRequest: z.object({ question: z.string().min(1).max(4000), options: z.array(z.string().min(1)).min(2).max(3), default_option: z.string() }).passthrough() }).passthrough() }).passthrough()
/** Main remembers the canonical authenticated target response, never a model-supplied
 * question. Like target plans this cache is short-lived; restart requires a fresh plan. */
export class RemoteLayerFSConsentPlans {
  private plans = new Map<string, { question: YieldQuestion; actor: string; expires: number; scope: string }>()
  constructor(private readonly projectId: string) {}
  private key(target: RemoteLayerFSTarget, session: string, plan: string) {
    if (target.projectScope !== managedProjectScope(this.projectId)) throw new ToolNoEffectError('Consent plan Project mismatch')
    return JSON.stringify([target.nodeId, target.pairingId, target.projectScope, session, plan])
  }
  remember(target: RemoteLayerFSTarget, context: ExecutionContext, value: unknown): void {
    const parsed = planResult.safeParse(value)
    if (!parsed.success) return // discovery can legitimately report blocked/configured, no approval plan
    const { plan, approvalRequest: q } = parsed.data.result
    if (!q.question.startsWith(remoteLayerFSTargetQuestion(target.nodeId, target.projectScope, plan, '')) || !q.options.includes(q.default_option)) throw new ToolNoEffectError('Invalid canonical target consent question')
    const scope = this.key(target, context.sessionId, '')
    for (const [key, value] of this.plans) if (value.expires <= Date.now() || value.scope === scope) this.plans.delete(key)
    while (this.plans.size >= 1000) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(this.key(target, context.sessionId, plan), { scope, actor: context.senderId, expires: Date.now() + 900000, question: { question: q.question, options: q.options as YieldQuestion['options'], defaultOption: q.default_option } })
  }
  question(target: RemoteLayerFSTarget, context: ExecutionContext, plan: string): YieldQuestion | undefined {
    const retained = this.plans.get(this.key(target, context.sessionId, plan))
    return retained && retained.actor === context.senderId && retained.expires > Date.now() ? structuredClone(retained.question) : undefined
  }
}
