import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ManagedLayerFS, type ManagedDriver } from './managed.ts'
import { LayerFSWorkflow } from './workflow.ts'
import { LayerFSBaseline } from './baseline.ts'
import { matchesBootstrapApproval } from './bootstrap.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { YieldDecisionRecord, YieldQuestion } from '../../sessions/yield-contract.ts'
import type { BootstrapRun } from './bootstrap-command.ts'

async function fixture(work: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), '.layerfs-workflow-test-'))
  const home = join(root, 'home'), source = join(root, 'source'), destination = join(root, 'destination')
  const state = join(home, 'state', 'layerfs')
  let managed: ManagedLayerFS | undefined
  try {
    await mkdir(join(home, 'config'), { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(source); await mkdir(destination)
    const sourceFiles = new Map([['index.ts', 'export const value = 1'], ['secret-redaction.ts', 'export const redact = () => "redacted"'], ['credentials.svg', '<svg/>'], ['.env', 'FIXTURE_ONLY=yes'], ['.git/config', '[core]'], ['node_modules/dependency.js', 'dependency'], ['untracked.ts', 'not copied']])
    for (const [path, content] of sourceFiles) { await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), content) }
    await writeFile(join(home, 'config', 'layerfs-managed.json'), JSON.stringify({ version: 1, projectId: 'p', approvedRootWorker: true,
      installation: { apiRoot: root, bundle: '/fixture/build', image: 'sha256:' + 'a'.repeat(64), distribution: 'FixtureWSL', node: '/fixture/node' } }))
    await writeFile(join(state, 'worker-state.json'), JSON.stringify({ phase: 'uncertain' }))
    await writeFile(join(state, 'import-state.json'), JSON.stringify({ stage: 'failed', code: 'ImportDeadline' }))
    let importedSource = '', starts = 0, project = ''
    const driver: ManagedDriver = { async request(action, input: any) {
      if (action === 'open') { starts++; project = input.project; return { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false } }
      if (action === 'status') return { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
      if (action === 'create') { importedSource = input.source; return { kind: 'Initialized', project } }
      if (action === 'import_status') return { stage: 'not_started' }
      throw Error('Unexpected request')
    }, async close() {} }
    managed = new ManagedLayerFS('p', home, () => driver, 'win32')
    const originalRecover = managed.recoverImport.bind(managed)
    const inactive: BootstrapRun = async command => ({ code: 0, stdout: Buffer.from(command.file === 'powershell.exe' ? '0' : command.args.includes('--running') ? '' : 'FixtureWSL\r\n'), stderr: Buffer.alloc(0) })
    managed.recoverImport = (fingerprint, owner, signal) => originalRecover(fingerprint, owner, signal, inactive)
    const records: YieldDecisionRecord[] = [], paths = new Map([['source', source], ['destination', destination]])
    const modes: any = { executionMode: 'session' }; modes.dynamicOwner = modes
    const access: string[] = []
    const context: ExecutionContext = { projectId: 'p', sessionId: 'web:owner', physicalSessionId: 'physical', senderId: 'owner', messageId: 'input', channel: 'web', chatId: 'owner', admin: true, isGroup: false,
      tools: modes, signal: new AbortController().signal, resolveToolTarget: async (selector, operation) => {
        access.push(`${selector}:${operation}`)
        const cwd = paths.get(selector); if (!cwd) throw Error('Unknown fixture workspace')
        return { cwd, fileChangeTarget: { nodeId: 'main', workdirId: selector } }
      } }
    let registerFailure = false
    const workflow = new LayerFSWorkflow('p', managed, async (question, reference, ctx) => matchesBootstrapApproval(question, reference, records, ctx.sessionId),
      async path => { if (registerFailure) throw Error('synthetic registration uncertainty'); assert.ok(!relative(destination, path).startsWith('..')); paths.set('curated', path); return { id: 'curated', name: 'reviewed-baseline' } },
      undefined, root => new LayerFSBaseline(root, { inventory: async () => [...sourceFiles.keys()].filter(name => name !== 'untracked.ts') }))
    const tool = new LayerFSTool('p', home, managed, undefined, undefined, workflow)
    const invoke = async (args: Record<string, unknown>, ctx = context) => JSON.parse(toolResultText(await tool.execute(args, ctx))).result
    const approve = (result: any, changes: Partial<YieldDecisionRecord> = {}) => {
      const id = `decision-${records.length}`, q = result.approvalRequest
      const question: YieldQuestion = { question: q.question, options: q.options, defaultOption: q.default_option }
      records.push({ request: { ...question, id, sessionId: context.sessionId, origin: { physicalId: context.physicalSessionId }, recipient: { kind: 'user', sessionId: context.sessionId }, createdAt: new Date().toISOString(), deadline: null },
        answer: { requestId: id, option: question.options[0], answeredBy: 'user', answeredAt: new Date().toISOString() }, ...changes })
      return { sessionId: context.sessionId, physicalId: context.physicalSessionId, requestId: id }
    }
    await work({ root, home, state, source, destination, sourceFiles, context, invoke, approve, records, managed, paths, access,
      activity: () => ({ starts, importedSource }), failRegistration: () => { registerFailure = true } })
  } finally { await managed?.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('supported synthetic workflow: exact approvals -> quarantined namespace -> separate registered baseline -> reviewed import', async () => {
  await fixture(async f => {
    const recoveryPlan = await f.invoke({ action: 'import_recovery_plan' })
    assert.equal(recoveryPlan.status, 'needs_approval')
    await assert.rejects(f.invoke({ action: 'import_recover', plan: recoveryPlan.plan, approved: true, allowRootWorker: true }), ToolNoEffectError)
    assert.equal(f.activity().starts, 0)
    const recoveryArgs = { action: 'import_recover', plan: recoveryPlan.plan, approval: f.approve(recoveryPlan), approved: true, allowRootWorker: true }
    const recovered = await f.invoke(recoveryArgs)
    assert.equal(recovered.status, 'quarantined'); assert.equal(f.activity().starts, 0)
    await assert.rejects(f.invoke(recoveryArgs), /absent, expired, used/)
    const baselinePlan = await f.invoke({ action: 'baseline_plan', workspace: 'source', destinationWorkspace: 'destination', namespace: recovered.namespace })
    assert.equal(baselinePlan.summary.files, 3); assert.ok(baselinePlan.warnings.length >= 2)
    assert.ok(f.access.includes('destination:filesystem.write'))
    await assert.rejects(lstat(join(f.destination, '.layerfs-baselines')), { code: 'ENOENT' })
    const prepared = await f.invoke({ action: 'baseline_prepare', workspace: 'source', destinationWorkspace: 'destination', plan: baselinePlan.plan, approval: f.approve(baselinePlan), approved: true })
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.workspace, 'curated'); assert.equal(prepared.imported, false)
    assert.equal(f.activity().starts, 0)
    const baseline = f.paths.get('curated')
    for (const name of ['index.ts', 'secret-redaction.ts', 'credentials.svg']) assert.equal(await readFile(join(baseline, name), 'utf8'), f.sourceFiles.get(name))
    for (const name of ['.env', '.git', 'node_modules', 'untracked.ts']) await assert.rejects(lstat(join(baseline, name)), { code: 'ENOENT' })
    for (const [path, content] of f.sourceFiles) assert.equal(await readFile(join(f.source, path), 'utf8'), content)
    const preview = await f.invoke({ action: 'import_preview', workspace: 'curated', namespace: recovered.namespace })
    assert.equal(preview.status, 'review_required'); assert.ok(preview.warnings.length >= 2)
    const created = await f.invoke({ action: 'create', workspace: 'curated', namespace: recovered.namespace, sourceReview: preview.reviewToken, sourceReviewed: true })
    assert.equal(created.kind, 'Initialized'); assert.equal(created.project, recovered.project)
    assert.equal(f.activity().importedSource, baseline); assert.equal(f.activity().starts, 1)
    assert.equal(JSON.parse(await readFile(join(f.state, 'worker-state.json'), 'utf8')).phase, 'uncertain', 'Old worker marker must stay archived in place')
    assert.equal(JSON.parse(await readFile(join(f.state, 'import-state.json'), 'utf8')).code, 'ImportDeadline')
  })
})

for (const kind of ['recovery', 'baseline']) test(`${kind} plan rejects non-owner, foreign, deferred and unrelated approval without live effects`, async () => {
  await fixture(async f => {
    const planArgs = kind === 'recovery' ? { action: 'import_recovery_plan' } : { action: 'baseline_plan', workspace: 'source', destinationWorkspace: 'destination' }
    for (const patch of [{ admin: false }, { channel: 'a2a' }, { scriptInvocation: true }, { recoveringToolCall: true }, { tools: { executionMode: 'task' } }, { tools: { executionMode: 'call' } }]) {
      await assert.rejects(f.invoke(planArgs, { ...f.context, ...patch }))
    }
    const plan = await f.invoke(planArgs)
    const request = kind === 'recovery' ? { action: 'import_recover', allowRootWorker: true } : { action: 'baseline_prepare', workspace: 'source', destinationWorkspace: 'destination' }
    await assert.rejects(f.invoke({ ...request, plan: plan.plan, approved: true, approval: { sessionId: 'web:other', physicalId: 'physical', requestId: 'foreign' } }), ToolNoEffectError)
    const deferred = f.approve(plan); f.records.at(-1).answer = undefined
    await assert.rejects(f.invoke({ ...request, plan: plan.plan, approved: true, approval: deferred }), ToolNoEffectError)
    const unrelated = f.approve(plan); f.records.at(-1).request.question += ' changed'
    await assert.rejects(f.invoke({ ...request, plan: plan.plan, approved: true, approval: unrelated }), ToolNoEffectError)
    assert.equal(f.activity().starts, 0); assert.equal(f.activity().importedSource, '')
    await assert.rejects(lstat(join(f.state, 'active-generation.json')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(f.destination, '.layerfs-baselines')), { code: 'ENOENT' })
  })
})

test('approved baseline rejects changed registered targets, and post-copy registration failure retains effects honestly', async () => {
  await fixture(async f => {
    const plan = await f.invoke({ action: 'baseline_plan', workspace: 'source', destinationWorkspace: 'destination' })
    const approval = f.approve(plan)
    const changed = join(f.root, 'changed'); await mkdir(changed); f.paths.set('destination', changed)
    await assert.rejects(f.invoke({ action: 'baseline_prepare', workspace: 'source', destinationWorkspace: 'destination', plan: plan.plan, approval, approved: true }), /changed since/)
    f.paths.set('destination', f.destination)
    const retryPlan = await f.invoke({ action: 'baseline_plan', workspace: 'source', destinationWorkspace: 'destination' })
    f.failRegistration()
    await assert.rejects(f.invoke({ action: 'baseline_prepare', workspace: 'source', destinationWorkspace: 'destination', plan: retryPlan.plan, approval: f.approve(retryPlan), approved: true }), ToolOutcomeUnknownError)
    assert.ok((await lstat(join(f.destination, '.layerfs-baselines'))).isDirectory())
    assert.equal(f.activity().starts, 0)
  })
})
