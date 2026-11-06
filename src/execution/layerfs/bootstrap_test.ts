import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BackgroundTaskManager } from '../../agent/background-task.ts'
import { Bus } from '../../bus/bus.ts'
import { EventService } from '../../events/service.ts'
import { createProjectScope } from '../../projects/scope.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, toolResultText } from '../../tools/tool.ts'
import { ManagedLayerFS, type ManagedDriver } from './managed.ts'
import { LayerFSBootstrap, matchesBootstrapApproval, BootstrapCommandError, type BootstrapRun, type BootstrapReceipt, type BootstrapApprovalVerifier } from './bootstrap.ts'
import type { YieldQuestion, YieldDecisionRecord } from '../../sessions/yield-contract.ts'
import { bootstrapPins, bootstrapScript } from './bootstrap-script.ts'

const decisionReference = { sessionId: 'web:fresh', physicalId: 'fresh-0', requestId: 'test-owner-decision' }
function decisionRecord(question: YieldQuestion): YieldDecisionRecord {
  return { request: { ...question, id: decisionReference.requestId, sessionId: decisionReference.sessionId,
    origin: { physicalId: decisionReference.physicalId }, recipient: { kind: 'user', sessionId: decisionReference.sessionId }, createdAt: new Date().toISOString(), deadline: null },
    answer: { requestId: decisionReference.requestId, option: question.options[0], answeredBy: 'user', answeredAt: new Date().toISOString() } }
}
const testConsent: BootstrapApprovalVerifier = async (question, reference, ctx) => matchesBootstrapApproval(question, reference, [decisionRecord(question)], ctx.sessionId)
const originalPrompt = 'I just update our app, and we added the layerfs, which can help us to develop multiple feature at the same time, we want to test out layerfs skill over OfficeAgent, as we are going to use it a lot and maybe write some feature in parallel. So go ahead to test it out'
function context(home: string): ExecutionContext {
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  return { projectId: 'p', channel: 'web', chatId: 'fresh', sessionId: 'web:fresh', physicalSessionId: 'fresh-0', admin: true, isGroup: false,
    tools, cwd: home, workUserInput: originalPrompt, inputSource: 'user', signal: new AbortController().signal } as ExecutionContext
}
const reply = (stdout: string, code = 0): BootstrapReceipt => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), code })
const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
class BackgroundFixture {
  tasks: { options: Parameters<BackgroundTaskManager['runPromiseTask']>[0]; promise: Promise<string> }[] = []
  runPromiseTask: BackgroundTaskManager['runPromiseTask'] = (options, promise) => {
    this.tasks.push({ options, promise }); promise.catch(() => {})
    return this.tasks.length.toString(16).padStart(16, '0')
  }
}
async function fixture(work: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(process.cwd(), '.layerfs-bootstrap-test-'))
  try { await work(home) } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
async function apiFixture(root: string) {
  for (const name of ['agent', 'runtime']) {
    await mkdir(join(root, 'api', name, 'src'), { recursive: true })
    await writeFile(join(root, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name, type: 'module' }))
    await writeFile(join(root, 'api', name, 'src', 'index.js'), 'throw Error("native SDK must not execute in this fixture")')
  }
}
function managed(home: string, events: string[]) {
  const driver: ManagedDriver = { async request(action) { events.push(action); return ready }, async close() { events.push('close') } }
  return new ManagedLayerFS('p', home, () => driver, 'win32')
}

test('fresh-session request reaches automatic plan -> one consent -> async build -> saved connect with no user paths/env', async () => {
  await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), events: string[] = [], m = managed(home, events)
    let hostOutput = '', key = '', rootCalls = 0
    const run: BootstrapRun = async command => {
      if (command.args[0] === '--list') return { ...reply(''), stdout: Buffer.from('docker-desktop\r\nOfficeAI-WSL\r\n', 'utf16le') }
      rootCalls++
      assert.deepEqual(command.args.slice(0, 5), ['--distribution', 'OfficeAI-WSL', '--user', 'root', '--exec'])
      if (command.args.includes('/bin/true')) {
        assert.equal(command.timeoutMs, 120000)
        return { ...reply(''), diagnostic: { reason: 'exit', timeoutMs: 120000, elapsedMs: 25000, exitCode: 0, signal: null, launcherExited: true } }
      }
      if (command.args.includes('wslpath')) { assert.equal(command.timeoutMs, 30000); hostOutput = command.args.at(-1)!; return reply('/mnt/project/private/api-root\n') }
      assert.equal(command.input, bootstrapScript)
      key = command.args.at(-2)!; assert.match(key, /^[a-f0-9]{32}$/)
      await assert.rejects(readFile(join(hostOutput, 'api', 'agent', 'package.json')))
      await apiFixture(hostOutput)
      return reply('build log\nSHADOW_LAYERFS_BOOTSTRAP_RESULT=' + JSON.stringify({ bundle: `/var/lib/shadow-layerfs-bootstrap/${key}/bundle`, node: `/var/lib/shadow-layerfs-bootstrap/${key}/bin/node`, image: 'sha256:' + 'b'.repeat(64), revision: bootstrapPins.revision }))
    }
    const bootstrap = new LayerFSBootstrap('p', home, bg, m, run, 'win32', 'x64', testConsent), tool = new LayerFSTool('p', home, m, bootstrap)
    try {
      assert.equal(ctx.workUserInput, originalPrompt)
      const first = JSON.parse(toolResultText(await tool.execute({ action: 'connect' }, ctx))).result
      assert.equal(first.status, 'needs_approval'); assert.equal(first.distribution, 'OfficeAI-WSL')
      assert.equal(rootCalls, 0); assert.deepEqual(events, []); assert.equal(bg.tasks.length, 0)
      assert.match(first.next, /No manual paths/)
      // Independent raw sessions may inspect plans without invalidating A's consent.
      assert.equal((await bootstrap.plan({ ...ctx, sessionId: 'web:simultaneous' })).status, 'needs_approval')
      const start = { action: 'bootstrap', plan: first.plan, approval: decisionReference, approved: true, allowRootWorker: true, allowDownloads: true }
      for (const patch of [{ approved: false }, { allowRootWorker: false }, { allowDownloads: false }, { plan: 'invented' }, { approval: undefined }, { approval: { ...decisionReference, requestId: 'unrelated' } }]) await assert.rejects(tool.execute({ ...start, ...patch }, ctx), ToolNoEffectError)
      await assert.rejects(tool.execute(start, { ...ctx, sessionId: 'web:other' }), ToolNoEffectError)
      assert.equal(rootCalls, 0)
      const receipt = JSON.parse(toolResultText(await tool.execute(start, ctx))).result
      assert.match(receipt.executionId, /^bg:/)
      const result = JSON.parse(await bg.tasks[0]!.promise)
      assert.equal(result.status, 'ready'); assert.equal(result.runtime.sandboxVerified, false)
      assert.equal(rootCalls, 3); assert.equal(bg.tasks.length, 1)
      assert.equal(bg.tasks[0]!.options.callback?.sessionId, ctx.sessionId)
      assert.match(bg.tasks[0]!.options.callback?.contentPrefix ?? '', /original request/)
      assert.deepEqual(JSON.parse(toolResultText(await tool.execute({ action: 'connect' }, ctx))).result, ready)
      await assert.rejects(tool.execute(start, ctx), ToolNoEffectError)
      const journal = JSON.parse(await readFile(join(home, 'state', 'layerfs', 'bootstrap', 'bootstrap.json'), 'utf8'))
      assert.equal(journal.phase, 'ready'); assert.equal(journal.installation.apiRoot, hostOutput); assert.equal(journal.key, key)
      const status = JSON.parse(toolResultText(await tool.execute({ action: 'bootstrap_status' }, ctx))).result
      assert.equal(status.runtime, 'not_checked'); assert.equal(status.lastBootstrapReady, true)
    } finally { await m.close() }
    const fresh = new ManagedLayerFS('p', home, () => ({ async request() { return ready }, async close() {} }), 'win32')
    try {
      const freshBootstrap = new LayerFSBootstrap('p', home, bg, fresh, async () => { throw Error('must not provision again') }, 'win32', 'x64', testConsent)
      const freshTool = new LayerFSTool('p', home, fresh, freshBootstrap)
      assert.deepEqual(JSON.parse(toolResultText(await freshTool.execute({ action: 'connect' }, { ...context(home), sessionId: 'web:raw-next' }))).result, ready)
    } finally { await fresh.close() }
  })
})

test('read-only discovery handles ambiguity, internal distros, unsupported platforms and authority without root execution', async () => {
  await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    let calls = 0
    const run: BootstrapRun = async command => { calls++; assert.deepEqual(command.args, ['--list', '--quiet']); return reply('docker-desktop\nUbuntu\nDebian\n') }
    const b = new LayerFSBootstrap('p', home, bg, m, run, 'win32', 'x64', testConsent)
    for (const patch of [{ admin: false }, { channel: 'a2a' }, { isGroup: true }, { scriptInvocation: true }, { recoveringToolCall: true }, { remoteWorkdir: {} }, { projectId: 'foreign' }]) await assert.rejects(b.plan({ ...ctx, ...patch } as ExecutionContext))
    assert.equal(calls, 0)
    const selection = await b.plan(ctx)
    assert.equal(selection.status, 'needs_selection'); assert.deepEqual('distributions' in selection ? selection.distributions : [], ['Debian', 'Ubuntu'])
    await assert.rejects(b.plan(ctx, 'docker-desktop'), /returned by bootstrap_plan/)
    assert.equal((await b.plan(ctx, 'Debian')).status, 'needs_approval')
    const unsupported = new LayerFSBootstrap('p', home, bg, m, async () => { throw Error('must not execute') }, 'darwin', 'arm64')
    assert.equal((await unsupported.plan(ctx)).status, 'blocked')
    const none = new LayerFSBootstrap('p', home, bg, m, async () => reply('docker-desktop\n'), 'win32', 'x64', testConsent)
    assert.equal((await none.plan(ctx)).status, 'blocked'); assert.equal(bg.tasks.length, 0)
  })
})

test('uncertain, malformed, escaped and failed build receipts never activate; durable state prevents automatic replay', async () => {
  for (const failure of ['unknown', 'invalid', 'escaped', 'failed']) await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), events: string[] = [], m = managed(home, events)
    const run: BootstrapRun = async command => {
      if (command.args[0] === '--list') return reply('Ubuntu\n')
      if (command.args.includes('/bin/true')) return reply('')
      if (command.args.includes('wslpath')) return reply('/mnt/host/api-root\n')
      if (failure === 'unknown') throw new ToolOutcomeUnknownError('lost WSL receipt')
      if (failure === 'invalid') return reply('no receipt')
      if (failure === 'failed') return reply('SHADOW_LAYERFS_BOOTSTRAP_FAILED={"code":"BUILD_FAILED","phase":"build","state":"unknown"}', 1)
      return reply('SHADOW_LAYERFS_BOOTSTRAP_RESULT=' + JSON.stringify({ bundle: '/etc/not-owned', node: '/bin/node', image: 'sha256:' + 'b'.repeat(64), revision: bootstrapPins.revision }))
    }
    const b = new LayerFSBootstrap('p', home, bg, m, run, 'win32', 'x64', testConsent)
    const p = await b.plan(ctx); assert.ok('plan' in p)
    await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowDownloads: true, allowRootWorker: true }, ctx)
    await assert.rejects(bg.tasks[0]!.promise, /uncertain/)
    assert.deepEqual(events, []); assert.equal(await m.configured(), false)
    const restarted = new LayerFSBootstrap('p', home, bg, m, async () => { throw Error('no automatic retry') }, 'win32', 'x64', testConsent)
    assert.equal((await restarted.plan(ctx)).status, 'existing_attempt')
  })
})

test('prerequisite refusal is actionable and cancellation is uncertain, with no silent fallback', async () => {
  await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    const b = new LayerFSBootstrap('p', home, bg, m, async command => command.args[0] === '--list' ? reply('Ubuntu\n') : command.args.includes('/bin/true') ? reply('') : command.args.includes('wslpath') ? reply('/mnt/host/api-root\n') : reply('SHADOW_LAYERFS_BOOTSTRAP_BLOCKED={"code":"DOCKER_API_TOO_OLD","phase":"prerequisites","state":"not_started"}', 1), 'win32', 'x64', testConsent)
    const p = await b.plan(ctx); assert.ok('plan' in p)
    await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowDownloads: true, allowRootWorker: true }, ctx)
    await assert.rejects(bg.tasks[0]!.promise, /blocked.*DOCKER_API_TOO_OLD/)
    assert.equal((await b.status(ctx)).phase, 'blocked')
    assert.equal((await b.plan(ctx)).status, 'needs_approval')
  })
  await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    const entered = Promise.withResolvers<void>()
    const b = new LayerFSBootstrap('p', home, bg, m, async (command, signal) => {
      if (command.args[0] === '--list') return reply('Ubuntu\n')
      if (command.args.includes('/bin/true')) return reply('')
      if (command.args.includes('wslpath')) return reply('/mnt/host/api-root\n')
      entered.resolve()
      return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new ToolOutcomeUnknownError('cancelled')), { once: true }); if (signal.aborted) reject(new ToolOutcomeUnknownError('cancelled')) })
    }, 'win32', 'x64', testConsent)
    const p = await b.plan(ctx); assert.ok('plan' in p)
    await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowDownloads: true, allowRootWorker: true }, ctx)
    await entered.promise
    await assert.rejects(async () => bg.tasks[0]!.options.onCancel?.('cancel'), /uncertain/)
    await assert.rejects(bg.tasks[0]!.promise, /uncertain/)
    assert.equal((await b.status(ctx)).phase, 'uncertain')
  })
})

test('real BackgroundTaskManager exposes unconfirmed WSL cleanup on cancellation and shutdown', async () => {
  for (const reason of ['cancel', 'shutdown']) await fixture(async home => {
    const scope = createProjectScope('p'), bus = new Bus()
    const events = new EventService(home, bus, async (sessionId, input) => ({ status: 'accepted', sessionId, inputId: input.id }), scope)
    const bg = new BackgroundTaskManager(bus, events, scope, home), ctx = context(home), m = managed(home, [])
    const entered = Promise.withResolvers<void>()
    const b = new LayerFSBootstrap('p', home, bg, m, async (command, signal) => {
      if (command.args[0] === '--list') return reply('Ubuntu\n')
      if (command.args.includes('/bin/true')) return reply('')
      if (command.args.includes('wslpath')) return reply('/mnt/host/api-root\n')
      entered.resolve()
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new ToolOutcomeUnknownError('Linux work may continue')), { once: true })
      })
    }, 'win32', 'x64', testConsent)
    try {
      const p = await b.plan(ctx); assert.ok('plan' in p)
      const receipt = await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowRootWorker: true, allowDownloads: true }, ctx)
      await entered.promise
      if (reason === 'cancel') await assert.rejects(bg.cancelTask(receipt.executionId.slice(3), ctx), /uncertain/)
      else await assert.rejects(bg.stop(), /shutdown failed/)
      const task = bg.listTasks()[0]!
      assert.equal(task.status, 'failed')
      assert.match(task.cancellationError ?? '', /uncertain/)
      assert.equal((await b.status(ctx)).phase, 'uncertain')
    } finally { await bg.stop(); await events.stop(); bus.stopAll(); scope.close(); await m.close() }
  })
})

test('host approval matches only the exact current recorded human choice, not flags or unrelated/deferred/custom answers', () => {
  const question: YieldQuestion = { question: 'Approve exact plan 123?', options: ['Approve exact plan', 'Decline'], defaultOption: 'Approve exact plan' }
  const record = decisionRecord(question)
  const matches = (records: YieldDecisionRecord[]) => matchesBootstrapApproval(question, decisionReference, records, decisionReference.sessionId)
  assert.equal(matches([record]), true)
  assert.equal(matches([]), false)
  assert.equal(matchesBootstrapApproval(question, decisionReference, [record], 'web:foreign'), false)
  for (const change of [
    (r: YieldDecisionRecord) => { r.answer = undefined },
    (r: YieldDecisionRecord) => { r.answer!.answeredBy = 'timeout' },
    (r: YieldDecisionRecord) => { r.answer!.answeredBy = 'parent' },
    (r: YieldDecisionRecord) => { r.answer!.custom = true },
    (r: YieldDecisionRecord) => { r.answer!.option = 'Decline' },
    (r: YieldDecisionRecord) => { r.request.question = 'Approve a different operation?' },
    (r: YieldDecisionRecord) => { r.request.options = ['Something else', 'Decline'] },
    (r: YieldDecisionRecord) => { r.request.origin!.physicalId = 'different-history' },
    (r: YieldDecisionRecord) => { r.closed = { at: new Date().toISOString(), reason: 'deferred', message: 'not approved' } },
    (r: YieldDecisionRecord) => { r.invalidated = { reference: decisionReference, at: new Date().toISOString(), reason: 'premise changed' } },
  ]) {
    const changed = structuredClone(record); change(changed); assert.equal(matches([changed]), false)
  }
})

test('readiness/path timeout retains diagnostics and is explicitly recoverable without dispatching provisioning', async () => {
  for (const failedStep of ['wsl_ready', 'resolve_paths']) await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), events: string[] = [], m = managed(home, events)
    let builds = 0, probes = 0
    const b = new LayerFSBootstrap('p', home, bg, m, async command => {
      if (command.args[0] === '--list') return reply('Ubuntu\n')
      if (command.input !== undefined) { builds++; throw Error('installer must not run') }
      probes++
      if (command.args.includes('/bin/true') && failedStep === 'resolve_paths') return reply('')
      throw new BootstrapCommandError({ reason: 'timeout', timeoutMs: command.timeoutMs, elapsedMs: command.timeoutMs + 50,
        exitCode: null, signal: 'SIGTERM', launcherExited: true }, Buffer.from('PRIVATE_STDOUT'), Buffer.from('PRIVATE_STDERR'))
    }, 'win32', 'x64', testConsent)
    const p = await b.plan(ctx); assert.ok('plan' in p)
    const admission = await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowRootWorker: true, allowDownloads: true }, ctx)
    await assert.rejects(bg.tasks[0]!.promise, /probe_failed.*TIMEOUT.*not dispatched/)
    assert.equal(builds, 0); assert.deepEqual(events, [])
    const status = await b.status(ctx)
    assert.equal(status.phase, 'probe_failed')
    assert.ok('diagnostic' in status); assert.equal(status.diagnostic?.reason, 'timeout')
    assert.equal(status.provisioningStarted, false); assert.equal(status.probeRecoveryCandidate, true)
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_STD/)
    const journalPath = join(home, 'state', 'layerfs', 'bootstrap', 'bootstrap.json')
    const before = await readFile(journalPath, 'utf8'), state = JSON.parse(before)
    const directory = join(home, 'state', 'layerfs', 'bootstrap')
    const log = JSON.parse(await readFile(join(directory, state.key, `${failedStep}.log`), 'utf8'))
    assert.equal(log.stderr, 'PRIVATE_STDERR'); assert.equal(log.diagnostic.reason, 'timeout')
    await assert.rejects(b.recover(ctx, 'bg:wrong'), ToolNoEffectError)
    await assert.rejects(b.recover({ ...ctx, admin: false }, admission.executionId), ToolNoEffectError)
    assert.equal(await readFile(journalPath, 'utf8'), before)
    const count = probes
    assert.equal((await b.recover(ctx, admission.executionId)).status, 'recovered')
    assert.equal(probes, count); assert.equal(bg.tasks.length, 1)
    assert.equal(JSON.parse(await readFile(join(directory, 'history', `${state.key}-probe_failed.json`), 'utf8')).code, state.code)
    assert.equal((await b.plan(ctx)).status, 'needs_approval')
    assert.equal((await b.status(ctx)).phase, 'recovered')
  })
})

test('legacy resolve_paths failure requires stopped WSL evidence and retains the original journal in history', async () => {
  await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    const directory = join(home, 'state', 'layerfs', 'bootstrap')
    await mkdir(directory, { recursive: true })
    const state = { version: 1, projectId: 'p', sessionId: 'web:previous', phase: 'uncertain', step: 'resolve_paths',
      key: 'a'.repeat(32), distribution: 'Ubuntu', executionId: 'bg:' + 'b'.repeat(16), code: 'OUTCOME_UNKNOWN', approval: decisionReference }
    const path = join(directory, 'bootstrap.json'); await writeFile(path, JSON.stringify(state))
    let running = true, inventory = 0
    const b = new LayerFSBootstrap('p', home, bg, m, async command => {
      inventory++; assert.deepEqual(command.args, ['--list', '--running', '--quiet'])
      assert.equal(command.input, undefined)
      return { ...reply(''), stdout: Buffer.from(running ? 'Ubuntu\r\n' : '', 'utf16le') }
    }, 'win32', 'x64', testConsent)
    await assert.rejects(b.recover(ctx, state.executionId), /running or its state cannot be checked/)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).phase, 'uncertain')
    running = false
    const recovered = await b.recover(ctx, state.executionId)
    assert.equal(recovered.status, 'recovered'); assert.equal(inventory, 2)
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'history', `${state.key}-uncertain.json`), 'utf8')), state)
    assert.equal(bg.tasks.length, 0); assert.equal(await m.configured(), false)
    await assert.rejects(b.recover(ctx, state.executionId), /terminal pre-provisioning/)
  })
})

test('recovery cannot reopen running work, dispatched/uncertain builds, unconfirmed launchers or conflicting artifacts', async () => {
  for (const kind of ['running', 'build', 'boundary', 'launcher', 'artifact', 'bad-journal']) await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    const directory = join(home, 'state', 'layerfs', 'bootstrap'), key = 'a'.repeat(32)
    await mkdir(join(directory, key), { recursive: true })
    const state: any = { version: 1, projectId: 'p', sessionId: ctx.sessionId, phase: 'probe_failed', step: 'resolve_paths',
      key, distribution: 'Ubuntu', executionId: 'bg:' + 'b'.repeat(16), code: 'PATH_MAPPING_TIMEOUT', approval: decisionReference,
      provisioningStarted: false, diagnostic: { reason: 'timeout', timeoutMs: 30000, elapsedMs: 30001, exitCode: null, signal: 'SIGTERM', launcherExited: true } }
    if (kind === 'running') state.phase = 'running'
    if (kind === 'build') { state.phase = 'uncertain'; state.step = 'source_build' }
    if (kind === 'boundary') state.provisioningStarted = true
    if (kind === 'launcher') state.diagnostic.launcherExited = false
    if (kind === 'artifact') await writeFile(join(directory, key, 'build-tail.log'), 'retained build evidence')
    const path = join(directory, 'bootstrap.json'), raw = kind === 'bad-journal' ? 'invalid' : JSON.stringify(state)
    await writeFile(path, raw)
    const b = new LayerFSBootstrap('p', home, bg, m, async () => { throw Error('recovery must not run any native command') }, 'win32', 'x64', testConsent)
    await assert.rejects(b.recover(ctx, state.executionId))
    assert.equal(await readFile(path, 'utf8'), raw); assert.equal(bg.tasks.length, 0)
  })
})

test('manual setup cannot race a background bootstrap or guarded recovery after their configuration checks', async () => {
  for (const action of ['bootstrap', 'recover']) await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    const directory = join(home, 'state', 'layerfs', 'bootstrap')
    const b = new LayerFSBootstrap('p', home, bg, m, async command => {
      if (command.args[0] === '--list' && !command.args.includes('--running')) return reply('Ubuntu\n')
      if (command.args.includes('/bin/true')) return reply('')
      if (command.args.includes('wslpath')) return reply('/mnt/host/api-root\n')
      entered.resolve(); await resume.promise
      return action === 'recover' ? reply('') : reply('SHADOW_LAYERFS_BOOTSTRAP_BLOCKED={"code":"DOCKER_API_148_REQUIRED","phase":"prerequisites","state":"not_started"}', 1)
    }, 'win32', 'x64', testConsent)
    let recovering: Promise<unknown> | undefined
    if (action === 'recover') {
      await mkdir(directory, { recursive: true })
      const state = { version: 1, projectId: 'p', sessionId: ctx.sessionId, phase: 'uncertain', step: 'resolve_paths', key: 'a'.repeat(32),
        distribution: 'Ubuntu', executionId: 'bg:' + 'b'.repeat(16), code: 'OUTCOME_UNKNOWN', approval: decisionReference }
      await writeFile(join(directory, 'bootstrap.json'), JSON.stringify(state))
      recovering = b.recover(ctx, state.executionId)
    } else {
      const p = await b.plan(ctx); assert.ok('plan' in p)
      await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowRootWorker: true, allowDownloads: true }, ctx)
    }
    await entered.promise
    try { await assert.rejects(m.setup({}, ctx.signal), /already owned/) } finally { resume.resolve() }
    if (recovering) await recovering
    else await assert.rejects(bg.tasks[0]!.promise, /blocked/)
    await assert.rejects(m.setup({}, ctx.signal), /Invalid LayerFS installation/)
    assert.equal(await m.configured(), false)
  })
})

test('private evidence-write failures never mask probe exit codes or trusted preflight refusals', async () => {
  for (const failedStep of ['wsl_ready', 'source_build']) await fixture(async home => {
    const ctx = context(home), bg = new BackgroundFixture(), m = managed(home, [])
    const directory = join(home, 'state', 'layerfs', 'bootstrap')
    const b = new LayerFSBootstrap('p', home, bg, m, async command => {
      if (command.args[0] === '--list') return reply('Ubuntu\n')
      if (command.args.includes('/bin/true') && failedStep === 'source_build') return reply('')
      if (command.args.includes('wslpath')) return reply('/mnt/host/api-root\n')
      const state = JSON.parse(await readFile(join(directory, 'bootstrap.json'), 'utf8'))
      await mkdir(join(directory, state.key, `${failedStep}.log`))
      if (failedStep === 'source_build') {
        await mkdir(join(directory, state.key, 'build-tail.log'))
        return reply('SHADOW_LAYERFS_BOOTSTRAP_BLOCKED={"code":"DOCKER_API_148_REQUIRED","phase":"prerequisites","state":"not_started"}', 1)
      }
      return { ...reply('', 7), diagnostic: { reason: 'exit', timeoutMs: 120000, elapsedMs: 10, exitCode: 7, signal: null, launcherExited: true } }
    }, 'win32', 'x64', testConsent)
    const p = await b.plan(ctx); assert.ok('plan' in p)
    await b.start({ plan: p.plan, approval: decisionReference, approved: true, allowRootWorker: true, allowDownloads: true }, ctx)
    await assert.rejects(bg.tasks[0]!.promise, failedStep === 'wsl_ready' ? /WSL_READY_EXIT_NONZERO/ : /blocked.*DOCKER_API_148_REQUIRED/)
    const status = await b.status(ctx)
    assert.ok('evidenceWriteFailed' in status); assert.equal(status.evidenceWriteFailed, true)
    assert.equal(status.phase, failedStep === 'wsl_ready' ? 'probe_failed' : 'blocked')
    if (failedStep === 'wsl_ready') assert.equal(status.diagnostic?.exitCode, 7)
  })
})
