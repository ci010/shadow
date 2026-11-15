import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionContext } from '../../tools/context.ts'
import type { SessionState } from '../../sessions/session-store.ts'
import type { YieldDecisionRecord, YieldQuestion, YieldReference } from '../../sessions/yield-contract.ts'
import type { LayerFSBootstrap } from './bootstrap.ts'
import { verifyLayerFSHostApproval } from './host-authority.ts'
import { RemoteLayerFSRuntimes } from './remote-runtime.ts'
import { RemoteLayerFSService } from './remote-service.ts'
import { RemoteLayerFSGateway } from './remote-gateway.ts'
import { remoteLayerFSOwnerVerifier } from './remote-owner.ts'
import { LocalExecutor } from '../local-executor.ts'
import { ProjectExecutor } from '../../projects/executor.ts'
import { ProcessManager } from '../processes/manager.ts'
import { managedProjectScope } from '../managed-workdir.ts'
import { toolResultText, ToolNoEffectError } from '../../tools/tool.ts'
import type { ExecutionRequestV2 } from '../contracts.ts'
import { RemoteLayerFSJobReservations } from './remote-jobs.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { RemoteLayerFSConsentPlans } from './remote-consent.ts'

// Human records and official provisioning are synthetic. Real Main verifier, transport
// adapters and target job mapping execute; no installer, WSL/Docker or worker starts.
test('Main gateway checks recorded target consent before transport; target bootstrap jobs/status/cancel remain distinct and unknown is never replayed', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-remote-bootstrap-'))
  const projectId = 'bootstrap-project', target = { nodeId: 'windows', pairingId: 'pair', projectScope: managedProjectScope(projectId) }
  const question: YieldQuestion = { question: 'Install pinned fixture revision in Fixture distro. Plan fixed-plan.', options: ['Approve pinned fixture plan.', 'Do not install.'], defaultOption: 'Approve pinned fixture plan.' }
  const records: YieldDecisionRecord[] = [], requests: ExecutionRequestV2[] = []
  let starts = 0, phase = 'not_started', taskId = ''
  let writeJournal: () => Promise<void> = async () => { throw Error('fixture journal not admitted') }
  const execution = Promise.withResolvers<string>()
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const context = { projectId, sessionId: 'web:owner', channel: 'web', senderId: 'actual-human', admin: true, isGroup: false, tools, signal: AbortSignal.timeout(10000), remoteWorkdir: { nodeId: target.nodeId, workdirId: 'native', executor: {} } } as ExecutionContext
  const state = { projectId, sessionId: context.sessionId } as SessionState
  const runtimes = new RemoteLayerFSRuntimes(join(dir, 'target'), target.nodeId, () => ({ online: true, epoch: 1, pairingId: target.pairingId }), { platform: 'win32', bootstrap: (_project, _home, background) => ({
    plan: async () => ({ plan: 'fixed-plan', approvalRequest: { kind: 'decision', question: question.question, options: question.options, default_option: question.defaultOption } }),
    start: async (args: Record<string, unknown>, ctx: ExecutionContext) => {
      if (!verifyLayerFSHostApproval(question, args.approval as YieldReference, ctx)) throw new ToolNoEffectError('canonical target consent mismatch')
      if (starts) throw new ToolNoEffectError('bootstrap plan already consumed; no replay')
      starts++; phase = 'running'
      writeJournal = async () => {
        const directory = join(projectDataPaths(_home).state, 'layerfs', 'bootstrap'); await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'bootstrap.json'), JSON.stringify({ version: 1, projectId: target.projectScope, sessionId: ctx.sessionId, executionId: 'bg:' + taskId, approval: args.approval, phase, step: phase === 'ready' ? 'complete' : 'build', provisioningStarted: true, diagnostic: { reason: 'exit', launcherExited: true } }))
      }
      taskId = background.runPromiseTask({ kind: 'tool', title: 'fixture only', onCancel: async () => { phase = 'uncertain'; await writeJournal(); execution.reject(new Error('fixture cancellation uncertain')); await execution.promise } }, execution.promise)
      await writeJournal()
      return { status: 'running', executionId: 'bg:' + taskId }
    },
    status: async () => ({ phase, executionId: taskId ? 'bg:' + taskId : undefined }),
  }) as unknown as LayerFSBootstrap })
  const service = new RemoteLayerFSService({ ...target, directory: join(dir, 'receipts'), authorize: async () => {}, preflight: call => runtimes.preflight(call), dispatch: (call, ctx) => runtimes.dispatch(call, ctx) })
  const local = new LocalExecutor(new ProcessManager(), target.nodeId, [service], (request, signal) => service.admit(request, signal).then(() => {}))
  const executor = new ProjectExecutor(projectId, { ...local, assertCanExecute: (request, signal) => local.assertCanExecute(request, signal), execute: (request, signal) => { requests.push(structuredClone(request)); return local.execute(request, signal) }, getStatus: id => local.getStatus(id), cancel: id => local.cancel(id) }, () => {})
  const pending = new Set<string>()
  const jobs = new RemoteLayerFSJobReservations(projectId, { remoteJobIds: () => [...pending], recordRemoteJob: (_project, id, active) => { if (active) pending.add(id); else pending.delete(id) } }, id => executor.settleVerifiedRemoteOperation(id))
  const consent = new RemoteLayerFSConsentPlans(projectId)
  const gateway = new RemoteLayerFSGateway({ projectId, jobs, consent, folders: () => [], executor, target: () => target, verify: remoteLayerFSOwnerVerifier({ projectId, consent, state: () => state, assertFolderAccess: () => {}, records: async () => records }), register: async () => { throw Error('unused') }, validateWork: () => {} })
  try {
    const invoke = async (action: Parameters<typeof gateway.tryCall>[0], args: Record<string, unknown> = {}) => JSON.parse(toolResultText((await gateway.tryCall(action, args, context))!))
    const plan = (await invoke('bootstrap_plan')).result
    assert.match(plan.approvalRequest.question, /^Target Windows device windows;/)
    const reference = { sessionId: context.sessionId, physicalId: 'physical', requestId: 'human-decision' }
    const input = { plan: plan.plan, approval: reference, approved: true, allowRootWorker: true, allowDownloads: true }
    const before = requests.length
    await assert.rejects(invoke('bootstrap', input), /Recorded human/)
    assert.equal(requests.length, before)
    records.push({ request: { id: reference.requestId, sessionId: context.sessionId, origin: { physicalId: reference.physicalId }, recipient: { kind: 'user', sessionId: context.sessionId }, createdAt: new Date().toISOString(), deadline: null, question: plan.approvalRequest.question, options: plan.approvalRequest.options, defaultOption: plan.approvalRequest.default_option }, answer: { requestId: reference.requestId, answeredBy: 'user', answeredAt: new Date().toISOString(), option: question.options[0] } })
    records[0]!.request.question += ' This is not the canonical target plan body.'
    const beforeWrongQuestion = requests.length
    await assert.rejects(invoke('bootstrap', input), /canonical target/)
    assert.equal(requests.length, beforeWrongQuestion)
    assert.equal(jobs.list().length, 0)
    records[0]!.request.question = plan.approvalRequest.question
    const running = (await invoke('bootstrap', input)).result
    assert.equal(starts, 1)
    assert.equal(jobs.list().length, 1)
    assert.equal(jobs.list()[0]!.targetJobId, running.targetJobId)
    assert.match(running.targetJobId, /^layerfs-target:/)
    assert.equal(running.targetNodeId, 'windows')
    assert.equal(running.executionId, undefined)
    assert.match(running.next, /No Main v:bg task/)
    const original = requests.at(-1)!
    const cancel = await invoke('bootstrap_cancel', { targetJobId: running.targetJobId })
    assert.equal(cancel.rollback, false)
    assert.equal(cancel.cancellation, 'requested')
    assert.equal((await invoke('bootstrap_status')).result.phase, 'uncertain')
    await service.execute(original, context.signal) // exact receipt replay, no build replay
    assert.equal(starts, 1)
    await assert.rejects(invoke('bootstrap', input), /not confirmed complete/)
    assert.equal(starts, 1)
    assert.equal(executor.hasPendingJobs, true)
    assert.equal((await invoke('bootstrap_reconcile', { targetJobId: running.targetJobId })).projectReservationsReleased, 0)
    assert.equal(jobs.list().length, 2) // original admitted job plus unknown second dispatch
    phase = 'ready'; await writeJournal() // synthetic authoritative target terminal evidence only
    assert.equal((await invoke('bootstrap_reconcile', { targetJobId: running.targetJobId })).projectReservationsReleased, 2)
    assert.equal(executor.hasPendingJobs, false)
    assert.equal(jobs.list().length, 0)
  } finally { execution.resolve('fixture stopped'); await runtimes.close(); await rm(dir, { recursive: true, force: true }) }
})
