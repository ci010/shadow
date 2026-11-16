import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BackgroundTaskManager } from '../../agent/background-task.ts'
import { LayerFSBootstrap } from './bootstrap.ts'
import { managedLayerFS, closeManagedLayerFS, installationSchema, type LayerFSInstallation } from './managed.ts'
import type { YieldQuestion, YieldReference } from '../../sessions/yield-contract.ts'
import { layerfsResources, closeLayerFSResources, existingLayerFSResources, type LayerFSResources } from './resource-service.ts'
import { LayerFSTool, validateLayerArgs } from '../../tools/layerfs.ts'
import { validateFSInput } from '../../tools/layerfs-fs.ts'
import { verifyLayerFSHostApproval } from './host-authority.ts'
import { remoteLayerFSTargetQuestion, type RemoteLayerFSCall } from './remote-contract.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { ToolNoEffectError, toolResultText } from '../../tools/tool.ts'
import { z } from 'zod'
import { remoteLayerFSLeaseFactory } from './remote-lease.ts'
import { inspectRemoteBootstrapTerminal } from './remote-bootstrap-journal.ts'

/** A narrow target Project service. No provider, session loop or second HTTP gateway. */
export class RemoteLayerFSRuntimes {
  private services = new Map<string, { home: string; bootstrap: LayerFSBootstrap }>()
  private setupPlans = new Map<string, { project: string; session: string; actor: string; installation: LayerFSInstallation; question: YieldQuestion; expires: number }>()
  private contextEpochs = new Map<string, number>()
  private bootstrapPlans = new Map<string, { question: YieldQuestion; actor: string; expires: number }>()
  private background = new Map<string, { project: string; promise: Promise<string>; cancel: Parameters<BackgroundTaskManager['runPromiseTask']>[0]['onCancel'] }>()
  constructor(private readonly root: string, private readonly nodeId: string, private readonly connection: () => { online: boolean; epoch: number; pairingId: string }, private readonly dependencies: { platform?: NodeJS.Platform; resources?: (project: string, home: string) => LayerFSResources; bootstrap?: (project: string, home: string, background: Pick<BackgroundTaskManager, 'runPromiseTask'>) => LayerFSBootstrap } = {}) {}
  private service(project: string) {
    let value = this.services.get(project)
    if (!value) {
      const home = join(this.root, project)
      const background: Pick<BackgroundTaskManager, 'runPromiseTask'> = { runPromiseTask: (options, promise) => {
        const id = randomUUID()
        this.background.set(id, { project, promise, cancel: options.onCancel })
        // Bootstrap's durable journal retains the actual failure; this handler merely
        // prevents an unhandled rejection in the target service with no session bus.
        void promise.then(() => this.background.delete(id), () => this.background.delete(id))
        return id
      } }
      const bootstrap = this.dependencies.bootstrap?.(project, home, background) ?? new LayerFSBootstrap(project, home, background, managedLayerFS(project, home), undefined, process.platform, process.arch,
        async (question, reference, context) => verifyLayerFSHostApproval(question, reference, context))
      value = { home, bootstrap }; this.services.set(project, value)
    }
    return value
  }
  /** Read-only semantic consent admission, before target receipt/effect claims. */
  preflight(call: RemoteLayerFSCall): void {
    if (call.action !== 'bootstrap' && call.action !== 'setup') return
    const a = call.authority, plan = String(call.input.plan)
    const setup = call.action === 'setup' ? this.setupPlans.get(plan) : undefined
    const bootstrap = call.action === 'bootstrap' ? this.bootstrapPlans.get(`${a.projectScope}\0${a.ownerSessionId}\0${plan}`) : undefined
    const retained = setup ?? bootstrap
    const expected = setup ? { ...setup.question, question: remoteLayerFSTargetQuestion(this.nodeId, a.projectScope, plan, setup.question.question) } : bootstrap?.question
    const approval = a.approval, reference = call.input.approval as YieldReference | undefined
    if (!retained || !expected || retained.expires <= Date.now() || retained.actor !== a.actorId || setup && (setup.project !== a.projectScope || setup.session !== a.ownerSessionId)
      || !approval || !reference || reference.sessionId !== a.ownerSessionId || reference.sessionId !== approval.reference.sessionId || reference.physicalId !== approval.reference.physicalId || reference.requestId !== approval.reference.requestId
      || approval.question.question !== expected.question || JSON.stringify(approval.question.options) !== JSON.stringify(expected.options) || approval.question.defaultOption !== expected.defaultOption) throw new ToolNoEffectError('Target canonical installation plan/actor/decision mismatch or expiry; no provisioning admitted')
  }
  async dispatch(call: RemoteLayerFSCall, context: ExecutionContext, observe?: (text: string) => void): Promise<unknown> {
    if ((this.dependencies.platform ?? process.platform) !== 'win32') throw new ToolNoEffectError('Remote Windows LayerFS service requires the actual Windows target')
    const project = call.authority.projectScope
    const { home, bootstrap } = this.service(project)
    const resources = () => layerfsResources(project, home, this.dependencies.resources ? () => this.dependencies.resources!(project, home) : undefined)
    const input = { ...call.input }
    const exact = (required: string[], optional: string[] = []) => {
      for (const key of required) if (input[key] === undefined) throw new ToolNoEffectError(`Missing ${key}`)
      for (const key of Object.keys(input)) if (![...required, ...optional].includes(key)) throw new ToolNoEffectError(`Unexpected ${key}`)
    }
    switch (call.action) {
      case 'contexts_revoke': exact([]); this.contextEpochs.set(project, (this.contextEpochs.get(project) ?? 0) + 1); return { revoked: true, targetNodeId: this.nodeId, projectScope: project }
      case 'doctor': case 'bootstrap_plan': case 'bootstrap_status': case 'bootstrap': {
        const raw = await new LayerFSTool(project, home, managedLayerFS(project, home), bootstrap).execute({ ...input, action: call.action }, context)
        const value = JSON.parse(toolResultText(raw))
        if (call.action === 'bootstrap_plan' && value.result?.approvalRequest) {
          const q = value.result.approvalRequest
          q.question = remoteLayerFSTargetQuestion(this.nodeId, project, String(value.result.plan), q.question)
          const prefix = `${project}\0${context.sessionId}\0`
          for (const key of this.bootstrapPlans.keys()) if (key.startsWith(prefix)) this.bootstrapPlans.delete(key)
          this.bootstrapPlans.set(prefix + String(value.result.plan), { question: { question: q.question, options: q.options, defaultOption: q.default_option }, actor: call.authority.actorId, expires: Date.now() + 900000 })
        }
        if (value.result?.executionId) {
          value.result.targetJobId = 'layerfs-target:' + String(value.result.executionId).replace(/^bg:/, '')
          delete value.result.executionId
          value.result.targetNodeId = this.nodeId
          value.result.next = 'Inspect layerfs_bootstrap_status on this exact Windows target; use layerfs_bootstrap_cancel with targetJobId if needed. No Main v:bg task or completion event exists. Cancellation is not rollback; unknown provisioning must not be replayed.'
        }
        return value
      }
      case 'bootstrap_reconcile': {
        exact(['targetJobId'])
        const targetJobId = z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/).parse(input.targetJobId)
        return inspectRemoteBootstrapTerminal(home, { nodeId: this.nodeId, pairingId: call.authority.pairingId, projectScope: project }, targetJobId, this.background.has(targetJobId.slice('layerfs-target:'.length)))
      }
      case 'bootstrap_cancel': {
        exact(['targetJobId'])
        const id = z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/).parse(input.targetJobId).slice('layerfs-target:'.length)
        const task = this.background.get(id)
        if (!task || task.project !== project || !task.cancel) throw new ToolNoEffectError('Exact live target job unavailable; inspect durable bootstrap_status; do not replay or kill retained resources')
        try { await task.cancel('cancel'); return { targetJobId: input.targetJobId, cancellation: 'confirmed', rollback: false } }
        catch (error) { return { targetJobId: input.targetJobId, cancellation: 'requested', outcome: 'inspect_target_status', rollback: false, message: error instanceof Error ? error.message : String(error) } }
      }
      case 'setup_plan': {
        exact(['installation'])
        const installation = installationSchema.parse(input.installation)
        const plan = randomUUID()
        const question: YieldQuestion = { question: `May Shadow connect and reuse this trusted Windows LayerFS installation and run its root WSL worker? Installation ${JSON.stringify(installation)}.`,
          options: ['Approve this target installation and root WSL worker.', 'Do not connect this installation.'], defaultOption: 'Approve this target installation and root WSL worker.' }
        this.setupPlans.set(plan, { project, session: context.sessionId, actor: call.authority.actorId, installation, question, expires: Date.now() + 900000 })
        return { ok: true, result: { plan, approvalRequest: { kind: 'decision', question: remoteLayerFSTargetQuestion(this.nodeId, project, plan, question.question), options: question.options, default_option: question.defaultOption } } }
      }
      case 'setup': {
        exact(['plan', 'approval', 'approved', 'allowRootWorker'])
        const plan = this.setupPlans.get(String(input.plan))
        if (!plan || plan.project !== project || plan.session !== context.sessionId || plan.expires <= Date.now() || input.approved !== true || input.allowRootWorker !== true
          || !verifyLayerFSHostApproval(plan.question, input.approval as YieldReference, context)) throw new ToolNoEffectError('Exact target setup decision required')
        this.setupPlans.delete(String(input.plan))
        return { ok: true, result: await managedLayerFS(project, home).setup(plan.installation, context.signal) }
      }
      case 'runtime_plan': exact(['runtimeId']); return { ok: true, result: await resources().runtimePlan(z.string().parse(input.runtimeId), context) }
      case 'runtime_recover': exact(['runtimeId']); return { ok: true, result: await resources().runtimeRecover(z.string().parse(input.runtimeId), context) }
      case 'runtime_start': exact(['runtimeId']); return { ok: true, result: await resources().runtimeStart(z.string().parse(input.runtimeId), context) }
      case 'runtime_status': exact(['runtimeId']); return { ok: true, result: await resources().runtimeStatus(z.string().parse(input.runtimeId), context.signal) }
      case 'runtime_context': exact(['runtimeId'], ['sourceName']); return { ok: true, targetNodeId: this.nodeId, result: await resources().runtimeContext(z.string().parse(input.runtimeId), context, input.sourceName === undefined ? undefined : z.string().parse(input.sourceName), remoteLayerFSLeaseFactory(call, () => { const live = this.connection(); return { ...live, epoch: `${live.epoch}:${this.contextEpochs.get(project) ?? 0}` } })) }
      case 'resource_register': return { ok: true, result: await resources().register(input, context) }
      case 'resource_list': exact([]); return { ok: true, result: resources().catalog.list() }
      case 'resource_inspect': exact(['resourceId']); return { ok: true, result: resources().catalog.get(z.string().uuid().parse(input.resourceId)) }
      case 'workspace_create': case 'workspace_fork': {
        const sourceBinding = call.action === 'workspace_fork' ? z.string().parse(input.sourceBinding) : undefined
        delete input.sourceBinding
        // Work associations belong to Main. Target accepts only a Main-validated request
        // with that field removed, never a request to read another device's Work store.
        if (input.workKey !== undefined) throw new ToolNoEffectError('Work association must be validated on the owning Main')
        const text = await resources().createWorkspace(input, context, async mount => ({ id: mount }), () => { throw new ToolNoEffectError('Target has no Main Work store') }, sourceBinding)
        return JSON.parse(text)
      }
      case 'branches': case 'history': case 'diff_commits': {
        const existing = existingLayerFSResources(project, home)
        if (!existing) throw new ToolNoEffectError('Target LayerFS runtime is not active; observation did not initialize a catalog or worker')
        return JSON.parse(await existing.observe(call.action, input, context))
      }
      case 'mkdir': case 'rm': case 'cp': case 'mv': case 'apply': case 'diff_files': case 'blame':
        validateFSInput(call.action, input)
        return JSON.parse(toolResultText(await resources().execute(call.action, input, context)))
      case 'read': case 'write': case 'search': case 'exec': case 'status':
        validateLayerArgs({ ...input, action: call.action }, project)
        return JSON.parse(toolResultText(await resources().execute(call.action, input, context, call.action === 'exec' ? { observe: observe ?? (() => {}) } : undefined)))
      default: throw new ToolNoEffectError('Unsupported target LayerFS dispatch')
    }
  }
  async close(): Promise<void> {
    if (this.background.size) throw new Error('LayerFS bootstrap still running; target resources retained, not cancelled implicitly')
    const results = await Promise.allSettled([...this.services].flatMap(([project, value]) => [closeManagedLayerFS(project, value.home), closeLayerFSResources(project, value.home)]))
    const errors = results.filter(result => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Target LayerFS shutdown uncertain')
    this.services.clear()
  }
}
