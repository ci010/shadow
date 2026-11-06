import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ExecutionContext } from '../../tools/context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { FILESYSTEM_READ_OPERATION, FILESYSTEM_WRITE_OPERATION } from '../capability-filesystem.ts'
import { backgroundExecutionId, type BackgroundTaskManager } from '../../agent/background-task.ts'
import { parseYieldReference, type YieldQuestion } from '../../sessions/yield-contract.ts'
import { assertLayerFSSetupOwner, type BootstrapApprovalVerifier } from './bootstrap.ts'
import type { ManagedLayerFS } from './managed.ts'
import { LayerFSBaseline } from './baseline.ts'

const TTL = 15 * 60_000
interface PlanBase { id: string; sessionId: string; expires: number; question: YieldQuestion }
interface RecoveryPlan extends PlanBase { kind: 'recovery'; fingerprint: string }
interface BaselinePlan extends PlanBase { kind: 'baseline'; helper: LayerFSBaseline; source: string; destination: string; sourceSelector: string; destinationSelector: string }
type Plan = RecoveryPlan | BaselinePlan
export type RegisterBaseline = (path: string, signal: AbortSignal) => Promise<{ id: string; name: string }>

/** Owner-approved workflow. Plans are observations, never permission to mutate.
 * Baselines live under an explicitly write-authorized registered destination,
 * not Project Home (which cannot be registered as a workspace).
 */
export class LayerFSWorkflow {
  private readonly plans = new Map<string, Plan>()
  private readonly baselines = new Map<string, LayerFSBaseline>()
  constructor(private readonly projectId: string, private readonly managed: ManagedLayerFS,
    private readonly verify: BootstrapApprovalVerifier, private readonly register: RegisterBaseline,
    private readonly background?: Pick<BackgroundTaskManager, 'runPromiseTask'>,
    private readonly baselineFactory: (root: string) => LayerFSBaseline = root => new LayerFSBaseline(root)) {}
  private owner(context: ExecutionContext) {
    assertLayerFSSetupOwner(context)
    if (context.projectId !== this.projectId) throw new ToolNoEffectError('LayerFS workflow Project mismatch.')
    context.signal.throwIfAborted()
    return `${this.projectId}\0${context.sessionId}`
  }
  private retain(plan: Plan) {
    for (const [id, value] of this.plans) if (value.expires <= Date.now()) this.plans.delete(id)
    while (this.plans.size >= 128) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(plan.id, plan)
    return { kind: 'decision', question: plan.question.question, options: plan.question.options, default_option: plan.question.defaultOption }
  }
  private async approved(kind: Plan['kind'], args: Record<string, unknown>, context: ExecutionContext): Promise<Plan> {
    this.owner(context)
    const plan = typeof args.plan === 'string' ? this.plans.get(args.plan) : undefined
    if (!plan || plan.kind !== kind || plan.sessionId !== context.sessionId || plan.expires <= Date.now()) throw new ToolNoEffectError('Workflow plan is absent, expired, used or belongs to another session. Obtain a fresh plan.')
    if (args.approved !== true || kind === 'recovery' && args.allowRootWorker !== true) throw new ToolNoEffectError('This workflow requires explicit approval of the exact plan and, for recovery, root-worker inspection/reuse.')
    let reference
    try { reference = parseYieldReference(args.approval) } catch { throw new ToolNoEffectError('A recorded human decision reference is required; flags alone do not authorize this workflow.') }
    if (reference.sessionId !== context.sessionId || !await this.verify(plan.question, reference, context)) throw new ToolNoEffectError('The recorded human decision does not approve this exact workflow plan.')
    context.signal.throwIfAborted()
    if (plan.expires <= Date.now() || this.plans.get(plan.id) !== plan) throw new ToolNoEffectError('Workflow plan expired or was consumed during approval verification.')
    this.plans.delete(plan.id)
    return plan
  }
  async recoveryPlan(context: ExecutionContext) {
    this.owner(context)
    if (process.env.SHADOW_LAYERFS_CONFIG) throw new ToolNoEffectError('Managed import recovery cannot replace operator configuration.')
    const observed = await this.managed.importRecoveryPlan(context.signal)
    const id = randomBytes(16).toString('hex')
    const approve = 'Approve quarantine and a fresh LayerFS namespace; retain all old resources.'
    const question: YieldQuestion = { question: `May Shadow quarantine the ${observed.importStage} import in namespace ${observed.namespace}, gracefully close its owned worker only if confirmed idle, inspect host/WSL ownership as root in ${observed.distribution}, and select a fresh private namespace using the existing approved installation? Root inspection may start WSL if its state changes. Later connect may start the approved root worker in that new namespace. No old Store, journal or source will be deleted or reused; no rebuild or import occurs in this action. Plan ${id}.`,
      options: [approve, 'Keep the current namespace and retained resources untouched.'], defaultOption: approve }
    const plan: RecoveryPlan = { kind: 'recovery', id, question, sessionId: context.sessionId, expires: Date.now() + TTL, fingerprint: observed.fingerprint }
    return { status: 'needs_approval', plan: id, namespace: observed.namespace, importStage: observed.importStage, importCode: observed.importCode,
      approvalRequest: this.retain(plan), next: 'Ask the exact approvalRequest. Only after explicit human approval call import_recover with plan, approval reference, approved:true and allowRootWorker:true. No automatic replay.' }
  }
  async recover(args: Record<string, unknown>, context: ExecutionContext) {
    if (process.env.SHADOW_LAYERFS_CONFIG) throw new ToolNoEffectError('Managed recovery cannot replace operator configuration.')
    const plan = await this.approved('recovery', args, context) as RecoveryPlan
    return this.run('LayerFS import quarantine', context, signal => this.managed.recoverImport(plan.fingerprint, context.sessionId, signal),
      'LayerFS quarantine result. Old resources are retained. Only a successful receipt selects a fresh namespace; use that explicit namespace for subsequent connect. No import or parallel-development success is implied.')
  }
  private async targets(args: Record<string, unknown>, context: ExecutionContext) {
    if (!context.resolveToolTarget || typeof args.workspace !== 'string' || typeof args.destinationWorkspace !== 'string') throw new ToolNoEffectError('Baseline preparation requires registered source and destinationWorkspace selectors.')
    const source = await context.resolveToolTarget(args.workspace, FILESYSTEM_READ_OPERATION)
    const destination = await context.resolveToolTarget(args.destinationWorkspace, FILESYSTEM_WRITE_OPERATION)
    if (source.remoteWorkdir || destination.remoteWorkdir || !source.cwd || !destination.cwd) throw new ToolNoEffectError('Baseline preparation supports authorized local source/destination workspaces only; no fallback.')
    return { source: source.cwd, destination: join(destination.cwd, '.layerfs-baselines') }
  }
  async baselinePlan(args: Record<string, unknown>, context: ExecutionContext) {
    const owner = this.owner(context), targets = await this.targets(args, context)
    let helper = this.baselines.get(targets.destination)
    if (!helper) { helper = this.baselineFactory(targets.destination); this.baselines.set(targets.destination, helper) }
    const result = await helper.plan(targets.source, owner, context.signal)
    const approve = 'Approve copying and registering this separate reviewed-baseline candidate.'
    const question: YieldQuestion = { question: `May Shadow copy ${result.summary.files} selected Git-tracked working-tree files (${result.summary.bytes} bytes) from workspace ${JSON.stringify(args.workspace)} to a new exclusive baseline directory under destination workspace ${JSON.stringify(args.destinationWorkspace)}, excluding Git/dependency trees and known credential artifacts, and register it in this Project? Untracked files are excluded. Filename warnings are not evidence of secrets or secret-free certification; content review is still required before import. The original checkout stays unchanged; no LayerFS import occurs. Plan ${result.plan}.`,
      options: [approve, 'Do not copy or register a baseline.'], defaultOption: approve }
    const plan: BaselinePlan = { kind: 'baseline', id: result.plan, question, sessionId: context.sessionId, expires: Date.now() + TTL, helper, ...targets,
      sourceSelector: String(args.workspace), destinationSelector: String(args.destinationWorkspace) }
    return { status: 'needs_approval', ...result, approvalRequest: this.retain(plan),
      next: 'Review exclusions/warnings and ask the exact approvalRequest. After approval call baseline_prepare with the same workspace/destinationWorkspace, plan, approval reference and approved:true. The original checkout is never stripped to satisfy preview.' }
  }
  async prepareBaseline(args: Record<string, unknown>, context: ExecutionContext) {
    const owner = this.owner(context)
    const plan = await this.approved('baseline', args, context) as BaselinePlan
    if (args.workspace !== plan.sourceSelector || args.destinationWorkspace !== plan.destinationSelector) throw new ToolNoEffectError('Baseline workspace selectors do not match the approved plan.')
    const targets = await this.targets(args, context)
    if (targets.source !== plan.source || targets.destination !== plan.destination) throw new ToolNoEffectError('A registered source/destination changed since the approved plan.')
    return this.run('LayerFS separate baseline preparation', context, async signal => {
      const baseline = await plan.helper.prepare(plan.id, targets.source, owner, signal)
      try {
        const registered = await this.register(baseline.path, signal)
        return { status: 'prepared', workspace: registered.id, name: registered.name, files: baseline.files, bytes: baseline.bytes, originalUnchanged: true, imported: false,
          next: 'Review the baseline contents, then run import_preview on this registered workspace. Creation still requires sourceReview and sourceReviewed:true. Use the fresh namespace returned by import_recover when applicable.' }
      } catch { throw new ToolOutcomeUnknownError('The prepared baseline was retained but workspace registration could not be confirmed. Inspect Project workspaces before preparing another copy; no import was started.') }
    }, 'Separate baseline preparation result. No source was imported. Review contents and run import_preview on the returned workspace before create; do not modify the original checkout.')
  }
  private async run(title: string, context: ExecutionContext, operation: (signal: AbortSignal) => Promise<unknown>, prefix: string) {
    context.signal.throwIfAborted()
    if (!this.background) return operation(context.signal)
    const controller = new AbortController(), outcome = Promise.withResolvers<string>()
    const task = this.background.runPromiseTask({ kind: 'tool', title, sessionId: context.sessionId, inputId: context.messageId,
      onCancel: async () => { controller.abort(); await outcome.promise; throw new Error('The operation completed before cancellation; its retained effects were not rolled back.') },
      callback: { sessionId: context.sessionId, replyTo: { channel: context.channel, chatId: context.chatId }, senderName: 'LayerFS workflow', contentPrefix: prefix, isGroup: false },
    }, outcome.promise)
    void operation(controller.signal).then(result => outcome.resolve(JSON.stringify(result)), error => outcome.reject(error))
    return { status: 'running', executionId: backgroundExecutionId(task), next: 'Wait for the background completion event; do not poll or replay the approved workflow.' }
  }
}
