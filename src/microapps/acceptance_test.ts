import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTempWorkspace } from '../testing/workspace.ts'
import { YieldError, YieldManager } from '../sessions/yield.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { MicroApps } from './service.ts'
import { microAppsPlugin } from './routes.ts'
import type { AppRecord, AppTestReport, AppWorkScope } from './contracts.ts'
import { AppReportValidationError, type AppAcceptanceHost } from './acceptance.ts'
import { MicroAppTool } from '../tools/micro-app.ts'
import { ToolNoEffectError } from '../tools/tool.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'

async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Acceptance did not reach the expected state'); await tick() }
}
const source = { sessionId: 'web:author', physicalId: 'segment', kind: 'tool' as const, id: 'browser-check', quote: 'Synthetic acceptance evidence' }
async function fixture(home: string, work: AppWorkScope[] = [],
  evidence: AppAcceptanceHost['evidence'] = async evidence => { assert.deepEqual(evidence, source) },
  resolveEvidence?: AppAcceptanceHost['resolveEvidence']) {
  let mode: 'ok' | 'fail' | 'wait' = 'ok', notifyFailure = false, providerEntered = false
  let blocker: string | undefined
  const notifications: string[] = []
  const yields = new YieldManager({
    getState: id => id === 'web:author' ? { sessionId: id, segmentIndex: 0 } : undefined,
    getPolicy: () => ({ timeoutMs: null }), notifyUser: async () => { throw new Error('Must stay in owner UI') }, notifyParent: async () => {},
  })
  const provider: LLMProvider = { name: 'synthetic', listModels: () => ['synthetic'], chat: async (_messages, _tools, options) => {
    providerEntered = true
    if (mode === 'fail') throw new Error('Synthetic failure')
    if (mode === 'wait') await new Promise<void>((_resolve, reject) => {
      assert.ok(options.signal)
      options.signal.throwIfAborted()
      options.signal.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })
    return { content: 'Synthetic provider result', toolCalls: [] }
  } }
  const service = new MicroApps('p', home, () => provider, () => 'synthetic', {
    ownerSession: id => yields.ownerSession(id),
    ask: (...args) => yields.askOwner(...args),
    notify: async (_record, acceptance) => { if (notifyFailure) throw new Error('Synthetic admission failure'); notifications.push(acceptance.id) },
    evidence, resolveEvidence,
    work: () => work,
    blocker: () => blocker,
  })
  await service.init()
  const directory = join(home, 'source'); await mkdir(directory)
  await writeFile(join(directory, 'index.html'), '<title>Acceptance fixture</title>')
  const manifest = { version: 1, name: 'Fixture', description: 'Synthetic fixture only', entry: 'index.html', files: ['index.html'],
    llm: { maxCalls: 8, maxOutputTokens: 32 } }
  const app = await service.publish(directory, manifest, 'web:author', AbortSignal.timeout(5000))
  const host = new Hono()
  microAppsPlugin(service, request => request.headers.get('x-owner') === 'yes')(host)
  const approve = async () => {
    await service.approve(app.id, service.get(app.id).revision)
    await wait(() => !!yields.get('web:author'))
  }
  const answer = async (index: number) => {
    const question = yields.get('web:author')!
    await yields.answerUser('web:author', question.id, question.options[index])
    await wait(() => service.get(app.id).acceptance!.status !== 'asking' && service.get(app.id).acceptance!.status !== 'dispatching')
  }
  const connect = async () => {
    const { url } = await service.openTest(app.id, app.revision, 'web:author', AbortSignal.timeout(5000))
    const parsed = new URL(url)
    const response = await fetch(`${parsed.origin}/_shadow/connect`, {
      method: 'POST', headers: { Authorization: `Bearer ${new URLSearchParams(parsed.hash.slice(1)).get('shadow_ticket')}` },
    })
    assert.equal(response.status, 200)
    const { token } = await response.json() as { token: string }
    const request = (path: string, options: RequestInit = {}) => fetch(parsed.origin + path, {
      ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
    })
    return { request, token, origin: parsed.origin }
  }
  return { service, yields, app, host, directory, manifest, notifications, approve, answer, connect,
    mode: (next: typeof mode) => { mode = next; providerEntered = false },
    entered: () => providerEntered, failNotification: (value: boolean) => { notifyFailure = value },
    block: (reason?: string) => { blocker = reason } }
}

test('approval asks the owner; only its timeout or explicit continue permits author testing', async t => withTempWorkspace(async home => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(home)
  try {
    await assert.rejects(f.service.openTest(f.app.id, f.app.revision, 'web:author', new AbortController().signal), /review/)
    await f.approve()
    assert.equal(f.yields.get('web:author')!.ownerOnly, true)
    assert.equal(f.service.get(f.app.id).lastRun, undefined)
    assert.throws(() => f.service.acceptance.authorize(f.app.id, f.app.revision, 'web:author'), /asking/)
    t.mock.timers.tick(59_999)
    assert.equal(f.notifications.length, 0)
    t.mock.timers.tick(1)
    await wait(() => f.notifications.length === 1)
    await wait(() => f.service.get(f.app.id).acceptance!.status === 'notified')
    assert.equal(f.service.get(f.app.id).acceptance!.decision, 'timeout')
    assert.ok(f.service.acceptance.authorize(f.app.id, f.app.revision, 'web:author'))
    assert.throws(() => f.service.acceptance.authorize(f.app.id, f.app.revision, 'web:peer'), /author/)
    assert.throws(() => f.service.acceptance.authorize(f.app.id, '0'.repeat(64), 'web:author'), /review/)
    const denied = await f.host.request(`/api/microapps/${f.app.id}/test`, {
      method: 'POST', body: JSON.stringify({ revision: f.app.revision }), headers: { 'Content-Type': 'application/json' },
    })
    assert.equal(denied.status, 401)
    await f.service.revoke(f.app.id)
    assert.throws(() => f.service.acceptance.authorize(f.app.id, f.app.revision, 'web:author'), /approval/)
  } finally { await f.service.shutdown() }
}))

test('pause, custom response, cancellation and revocation never become timeout permission', async t => {
  for (const choice of ['pause', 'custom', 'cancel', 'revoke'] as const) {
    await t.test(choice, async () => withTempWorkspace(async home => {
      const f = await fixture(home)
      try {
        await f.approve()
        const question = f.yields.get('web:author')!
        if (choice === 'pause') await f.answer(1)
        else if (choice === 'custom') await f.yields.answerUserText('web:author', question.id, question.defaultOption)
        else if (choice === 'cancel') await f.yields.cancelUser('web:author', question.id)
        else await f.service.revoke(f.app.id)
        await wait(() => f.service.get(f.app.id).acceptance!.status === 'paused')
        assert.equal(f.notifications.length, 0)
        assert.equal(f.service.get(f.app.id).lastRun, undefined)
        assert.throws(() => f.service.acceptance.authorize(f.app.id, f.app.revision, 'web:author'))
      } finally { await f.service.shutdown() }
    }))
  }
})

test('notification failures and restart require an explicit retry, without renewing allowance', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    f.failNotification(true)
    await f.approve(); await f.answer(0)
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'failed')
    const record = f.service.store.get(f.app.id)
    record.calls = 3; f.service.store.save(record)
    const approval = record.approval
    f.failNotification(false)
    await f.service.requestTesting(f.app.id, f.app.revision)
    await wait(() => !!f.yields.get('web:author'))
    assert.deepEqual(f.service.get(f.app.id).approval, approval)
    assert.equal(f.service.get(f.app.id).calls, 3)
    await f.answer(0)
    assert.equal(f.notifications.length, 1)
    await f.service.shutdown()
    const restored = new MicroApps('p', home, () => { throw new Error('Must not run') }, () => 'synthetic')
    await restored.init()
    assert.equal(restored.get(f.app.id).acceptance!.status, 'interrupted')
    assert.equal(restored.get(f.app.id).calls, 3)
    await restored.shutdown()
  } finally { await f.service.shutdown() }
}))

test('live SDK observations support version-bound reports, not fixture or self-declared passes', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await f.approve(); await f.answer(0)
    const first = await f.connect()
    const saved = await first.request('/_shadow/state', { method: 'PUT', body: JSON.stringify({ version: 0, values: { preference: 'retained' } }) })
    assert.equal(saved.status, 200)
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic text' }] })
    f.mode('fail')
    assert.equal((await first.request('/_shadow/generate', { method: 'POST', body })).status, 502)
    f.mode('ok')
    assert.equal((await first.request('/_shadow/generate', { method: 'POST', body })).status, 200)
    f.mode('wait')
    const controller = new AbortController()
    const pending = first.request('/_shadow/generate', { method: 'POST', body, signal: controller.signal })
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await wait(f.entered)
    controller.abort(); await rejected
    await wait(() => f.service.get(f.app.id).acceptance!.observations.some(item => item.kind === 'model_cancelled'))
    await f.service.stopFromAuthor(f.app.id, 'web:author')
    const second = await f.connect()
    assert.deepEqual(await (await second.request('/_shadow/state')).json(), { version: 1, values: { preference: 'retained' } })
    const acceptance = f.service.get(f.app.id).acceptance!
    assert.doesNotMatch(JSON.stringify(acceptance), /retained|shadow_ticket|Synthetic text/)
    const ids = (...kinds: string[]) => acceptance.observations.filter(item => kinds.includes(item.kind)).map(item => item.id)
    const checks: AppTestReport['checks'] = [
      { category: 'startup', result: 'passed', basis: 'runtime', summary: 'Actual host start and SDK handshake, synthetic app.', observations: ids('started', 'sdk_connected'), evidence: [source] },
      { category: 'state', result: 'passed', basis: 'runtime', summary: 'Actual persisted settings read by the next runtime.', observations: ids('state_saved', 'state_read'), evidence: [source] },
      { category: 'recovery', result: 'passed', basis: 'runtime', summary: 'Actual SDK/provider boundary failure then success; provider is a fixture.', observations: ids('model_failed', 'model_completed'), evidence: [source] },
      { category: 'reopen', result: 'passed', basis: 'runtime', summary: 'Stopped and reopened actual runtime.', observations: ids('stopped', 'sdk_connected'), evidence: [source] },
    ]
    await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author',
      { checks: checks.map(check => ({ ...check, observations: [randomUUID()] })) }, AbortSignal.timeout(5000)), /exact testing request/)
    await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author',
      { checks: checks.map(check => ({ ...check, evidence: [] })) }, AbortSignal.timeout(5000)), /tool evidence/)
    await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author',
      { checks: checks.map(check => ({ ...check, evidence: [{ ...source, sessionId: 'web:peer' }] })) }, AbortSignal.timeout(5000)), /author session/)
    const report = await f.service.acceptance.report(f.app.id, f.app.revision, 'web:author', { checks }, AbortSignal.timeout(5000))
    assert.equal(report!.status, 'reported')
    await f.service.stopFromAuthor(f.app.id, 'web:author')
    const archive = JSON.parse(await readFile(join(f.service.store.root, f.app.id, `acceptance-${acceptance.id}.json`), 'utf8'))
    assert.equal(archive.report.result.checks.length, 4)
    await writeFile(join(f.directory, 'index.html'), '<title>Changed revision</title>')
    const update = await f.service.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), f.app.id, f.app.revision)
    assert.equal(update.approval, undefined)
    assert.equal(update.acceptance, undefined)
    assert.equal(JSON.parse(await readFile(join(f.service.store.root, f.app.id, `acceptance-${acceptance.id}.json`), 'utf8')).revision, f.app.revision)
  } finally { await f.service.shutdown() }
}))

test('author testing does not take over an owner-opened runtime', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await f.approve(); await f.answer(0)
    await f.service.start(f.app.id)
    const ownerRun = f.service.get(f.app.id).lastRun!.id
    await assert.rejects(f.connect(), /owner-opened/)
    await assert.rejects(f.service.stopFromAuthor(f.app.id, 'web:author'), /opened by the owner/)
    assert.equal(f.service.get(f.app.id).lastRun!.id, ownerRun)
    assert.deepEqual(f.service.get(f.app.id).acceptance!.observations, [])
  } finally { await f.service.shutdown() }
}))

test('rejected test entry is no-effect, but a failed browser after app startup is not', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  const tools = new SessionTools(new Tools(home), home)
  const context = { sessionId: 'web:author', projectId: 'p', tools, signal: AbortSignal.timeout(5000) } as ExecutionContext
  let openings = 0
  const tool = new MicroAppTool(f.service, () => {}, {
    openApp: async (_context, _identity, open) => { openings++; await open(); throw new Error('Synthetic failure after opening') },
  })
  try {
    const args = { action: 'test', id: f.app.id, revision: f.app.revision }
    await assert.rejects(tool.execute(args, context), ToolNoEffectError)
    await assert.rejects(tool.execute({ ...args, revision: 'invalid' }, context), ToolNoEffectError)
    await f.approve()
    await assert.rejects(tool.execute(args, context), ToolNoEffectError)
    assert.equal(openings, 0)
    assert.equal(f.service.get(f.app.id).lastRun, undefined)
    await f.answer(0)
    await assert.rejects(tool.execute(args, { ...context, inputSource: 'event', messageId: 'microapp-test:stale-request' }), ToolNoEffectError)
    assert.equal(openings, 0)
    await assert.rejects(tool.execute(args, context), error => error instanceof Error && !(error instanceof ToolNoEffectError))
    assert.equal(f.service.get(f.app.id).status, 'running')
    assert.equal(tool.workAdmission({ action: 'stop', id: f.app.id }), 'cleanup')
    assert.equal(tool.workAdmission({ action: 'stop', id: f.app.id, untrusted: true }), undefined)
  } finally { await f.service.shutdown(); await tools.resetDynamicAndWait() }
}))

const untestedChecks = (): AppTestReport['checks'] => (['startup', 'state', 'recovery', 'reopen'] as const).map(category => ({
  category, result: 'not_tested', basis: 'not_tested',
  summary: 'Not exercised; this is not a passing result.', observations: [], evidence: [],
}))

test('runtime schema errors locate every affected report field, including blocked requirements', async () => withTempWorkspace(async home => {
  const f = await fixture(home), tools = new SessionTools(new Tools(home), home)
  const tool = new MicroAppTool(f.service, () => {})
  const context = { sessionId: 'web:author', projectId: 'p', tools, signal: AbortSignal.timeout(5000) } as ExecutionContext
  try {
    await f.approve(); await f.answer(0)
    const before = f.service.get(f.app.id).acceptance!
    const checks = untestedChecks()
    checks[0] = { ...checks[0], result: 'passed', basis: 'runtime' }
    const requirements = [{ workKey: 'work:fixture', workRevision: 1, criterion: 0, result: 'failed',
      basis: 'runtime', summary: 'Actual attempted feature did not complete', observations: [], evidence: [] },
    { workKey: 'work:fixture', workRevision: 1, criterion: 1, result: 'blocked',
      basis: 'runtime', summary: 'Partly exercised, missing device test', observations: [], evidence: [] }]
    await assert.rejects(tool.execute({ action: 'report', id: f.app.id, revision: f.app.revision, report: { checks, requirements } }, context), error => {
      assert.ok(error instanceof ToolNoEffectError && error.cause instanceof z.ZodError)
      assert.deepEqual(error.cause.issues.map(issue => issue.path), [
        ['report', 'checks', 0, 'evidence'], ['report', 'checks', 0, 'observations'],
        ['report', 'requirements', 0, 'observations'], ['report', 'requirements', 1, 'observations'],
      ])
      assert.match(error.message, /even for blocked\/failed/)
      return true
    })
    assert.deepEqual(f.service.get(f.app.id).acceptance, before)
  } finally { await f.service.shutdown(); await tools.resetDynamicAndWait() }
}))

test('canonical evidence lookup repairs wrong physical IDs without changing evidence or approval rules', async () => withTempWorkspace(async home => {
  let lookups = 0
  const f = await fixture(home, [], async evidence => {
    if (evidence.physicalId !== source.physicalId) throw new YieldError('not_found', 'Decision segment does not belong to this session.')
    assert.deepEqual(evidence, source)
  }, async (sessionId, sources, signal) => {
    signal.throwIfAborted(); lookups++
    assert.equal(sessionId, source.sessionId)
    assert.deepEqual(sources, [{ id: source.id, quote: source.quote }])
    return [source]
  })
  const tools = new SessionTools(new Tools(home), home), tool = new MicroAppTool(f.service, () => {})
  const context = { sessionId: 'web:author', projectId: 'p', tools, signal: AbortSignal.timeout(5000) } as ExecutionContext
  const query = { action: 'evidence', id: f.app.id, revision: f.app.revision, sources: [{ id: source.id, quote: source.quote }] }
  try {
    assert.equal(tool.readonly(query), true)
    await assert.rejects(tool.execute(query, context), ToolNoEffectError)
    await f.approve(); await f.answer(0)
    const before = f.service.get(f.app.id).acceptance!
    await assert.rejects(tool.execute(query, { ...context, sessionId: 'web:peer' }), ToolNoEffectError)
    await assert.rejects(tool.execute({ ...query, sources: [{ ...query.sources[0], sessionId: 'web:peer' }] }, context), ToolNoEffectError)
    await assert.rejects(tool.execute({ ...query, revision: '0'.repeat(64) }, context), ToolNoEffectError)
    await assert.rejects(tool.execute(query, { ...context, inputSource: 'event', messageId: 'microapp-test:stale' }), ToolNoEffectError)
    assert.equal(lookups, 0)
    const checks = untestedChecks()
    checks[0] = { ...checks[0], result: 'passed', basis: 'fixture', evidence: [{ ...source, physicalId: 'guessed-uuid' }] }
    const args = { action: 'report', id: f.app.id, revision: f.app.revision, report: { checks } }
    await assert.rejects(tool.execute(args, context), error => {
      assert.ok(error instanceof ToolNoEffectError)
      assert.match(error.message, /checks\[0\]\.evidence\[0\]/)
      assert.deepEqual(JSON.parse(error.message.slice(error.message.indexOf('\n') + 1)), query)
      return true
    })
    const resolved = JSON.parse(await tool.execute(query, context))
    assert.equal(resolved.acceptanceId, before.id)
    assert.deepEqual(resolved.evidence, [source])
    assert.deepEqual(f.service.get(f.app.id).acceptance, before, 'Read-only lookup does not save or change a report')
    checks[0].evidence = resolved.evidence
    assert.equal(JSON.parse(await tool.execute(args, context)).status, 'reported')
    assert.equal(lookups, 1)
  } finally { await f.service.shutdown(); await tools.resetDynamicAndWait() }
}))

test('evidence lookup propagates failures and rechecks cancellation, approval and request identity', async t => {
  for (const failure of ['io', 'abort', 'revoke', 'replace', 'unavailable'] as const) {
    await t.test(failure, async () => withTempWorkspace(async home => {
      const controller = new AbortController()
      const ioFailure = new Error('Synthetic receipt read failure')
      const f = await fixture(home, [], undefined, failure === 'unavailable' ? undefined : async () => {
        if (failure === 'io') throw ioFailure
        if (failure === 'abort') controller.abort()
        if (failure === 'revoke') await f.service.revoke(f.app.id)
        if (failure === 'replace') {
          const record = f.service.store.get(f.app.id)
          record.acceptance = f.service.acceptance.create(record)
          record.acceptance!.decision = 'user'; record.acceptance!.status = 'notified'
          f.service.store.save(record)
        }
        return [source]
      })
      try {
        await f.approve(); await f.answer(0)
        await assert.rejects(f.service.acceptance.evidence(f.app.id, f.app.revision, source.sessionId,
          [{ id: source.id, quote: source.quote }], controller.signal), error => {
          if (failure === 'io') assert.equal(error, ioFailure)
          else assert.match(String(error), failure === 'abort' ? /AbortError/ : failure === 'revoke' ? /approval/
            : failure === 'replace' ? /Testing request changed/ : /lookup is unavailable/)
          return true
        })
        assert.equal(f.service.get(f.app.id).acceptance!.report, undefined)
      } finally { await f.service.shutdown() }
    }))
  }
})

test('report citation diagnostics batch the Sol trace mistakes and preserve supported results on repair', async () => withTempWorkspace(async home => {
  let evidenceChecks = 0
  const work = [{ key: 'work:report', revision: 2, acceptance: ['Show translated text'] }]
  const f = await fixture(home, work, async evidence => { evidenceChecks++; assert.deepEqual(evidence, source) })
  const tools = new SessionTools(new Tools(home), home), tool = new MicroAppTool(f.service, () => {})
  const context = { sessionId: 'web:author', projectId: 'p', tools, signal: AbortSignal.timeout(5000) } as ExecutionContext
  try {
    await f.approve(); await f.answer(0)
    const first = await f.connect()
    assert.equal((await first.request('/_shadow/state', { method: 'PUT', body: JSON.stringify({ version: 0, values: { font: 'large' } }) })).status, 200)
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic text' }] })
    f.mode('fail')
    assert.equal((await first.request('/_shadow/generate', { method: 'POST', body })).status, 502)
    f.mode('ok')
    assert.equal((await first.request('/_shadow/generate', { method: 'POST', body })).status, 200)
    await f.service.stopFromAuthor(f.app.id, 'web:author')
    const second = await f.connect()
    assert.equal((await second.request('/_shadow/state')).status, 200)
    const before = f.service.get(f.app.id).acceptance!
    const archivePath = join(f.service.store.root, f.app.id, `acceptance-${before.id}.json`)
    const archiveBefore = await readFile(archivePath, 'utf8')
    const ids = (...kinds: string[]) => before.observations.filter(item => kinds.includes(item.kind)).map(item => item.id)
    const report: AppTestReport = {
      checks: [
        { category: 'startup', result: 'passed', basis: 'runtime', summary: 'Actual SDK start; no device or readiness claim.', observations: ids('started', 'sdk_connected'), evidence: [source] },
        { category: 'state', result: 'passed', basis: 'runtime', summary: 'Settings read on the second run.', observations: ids('state_saved', 'state_read'), evidence: [source] },
        { category: 'recovery', result: 'passed', basis: 'runtime', summary: 'Synthetic provider failure then success.', observations: ids('model_completed'), evidence: [source] },
        { category: 'reopen', result: 'passed', basis: 'runtime', summary: 'Stopped then reconnected; not a Shadow restart.', observations: ids('stopped', 'started', 'state_read'), evidence: [source] },
      ],
      requirements: [{ workKey: work[0].key, workRevision: 2, criterion: 0, result: 'passed', basis: 'runtime',
        summary: 'Synthetic provider result returned through the SDK.', observations: ids('model_completed'), evidence: [source] }],
    }
    const original = structuredClone(report)
    const args = { action: 'report', id: f.app.id, revision: f.app.revision, report }
    let diagnostics: { acceptanceId: string; revision: string; issues: Array<{
      path: string; code: string; required: string; candidateObservationIds: string[]; missingCitationIds: string[]
    }>; detail: { action: string; id: string } } | undefined
    await assert.rejects(tool.execute(args, context), error => {
      assert.ok(error instanceof ToolNoEffectError)
      assert.ok(error.cause instanceof AppReportValidationError)
      assert.match(error.message, /Report not saved/)
      assert.match(error.message, /other evidence has not yet been validated/)
      assert.match(error.message, /do not downgrade the whole report/)
      diagnostics = JSON.parse(error.message.slice(error.message.indexOf('\n') + 1))
      return true
    })
    assert.ok(diagnostics)
    assert.equal(diagnostics.acceptanceId, before.id)
    assert.equal(diagnostics.revision, f.app.revision)
    assert.deepEqual(diagnostics.detail, { action: 'get', id: f.app.id })
    assert.deepEqual(diagnostics.issues.map(issue => issue.path), ['checks[2]', 'checks[3]', 'requirements[0]'])
    assert.ok(diagnostics.issues.every(issue => issue.code === 'insufficient_observations'))
    assert.deepEqual(diagnostics.issues[0].missingCitationIds, ids('model_failed'))
    const secondConnection = before.observations.find(item => item.kind === 'sdk_connected' && item.runId === f.service.get(f.app.id).lastRun!.id)!
    assert.deepEqual(diagnostics.issues[1].missingCitationIds, [secondConnection.id])
    assert.match(diagnostics.issues[1].required, /full Shadow restart is not required/)
    assert.equal(evidenceChecks, 0, 'Batch citation rejection does not claim to validate excerpts')
    assert.deepEqual(report, original, 'Hints never mutate or silently fill the report')
    assert.deepEqual(f.service.get(f.app.id).acceptance, before, 'No partial report or acceptance status change')
    assert.equal(await readFile(archivePath, 'utf8'), archiveBefore)
    for (const issue of diagnostics.issues) {
      const index = Number(issue.path.match(/\[(\d+)\]/)![1])
      const check = issue.path.startsWith('checks') ? report.checks[index] : report.requirements![index]
      check.observations = [...new Set([...check.observations, ...issue.missingCitationIds])]
    }
    const result = JSON.parse(await tool.execute(args, context))
    assert.equal(result.status, 'reported')
    assert.deepEqual(result.report.result, report)
    assert.deepEqual(JSON.parse(await readFile(archivePath, 'utf8')).report.result, report)
    assert.equal(evidenceChecks, 5, 'Corrected citations still require all original tool excerpts')
    assert.deepEqual(report.checks.slice(0, 2), original.checks.slice(0, 2))
    assert.ok(report.checks.every(check => check.result === 'passed' && check.evidence.length === 1))
  } finally { await f.service.shutdown(); await tools.resetDynamicAndWait() }
}))

test('citation candidates never invent absent, truncated, reversed or mismatched lifecycle evidence', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await f.approve(); await f.answer(0)
    const acceptanceId = f.service.get(f.app.id).acceptance!.id
    const run1 = randomUUID(), run2 = randomUUID()
    const observe = (run: string, kind: Parameters<typeof f.service.acceptance.observe>[3], version?: number) =>
      f.service.acceptance.observe(f.app.id, acceptanceId, run, kind, version)
    observe(run1, 'started')
    observe(run1, 'sdk_connected')
    observe(run1, 'state_read', 1)
    observe(run1, 'state_saved', 1)
    observe(run1, 'state_read', 1)
    observe(run2, 'state_read', 2)
    observe(run2, 'sdk_connected')
    observe(run1, 'stopped')
    observe(run1, 'model_completed')
    observe(run1, 'model_failed')
    observe(run1, 'backend_completed')
    const record = f.service.store.get(f.app.id)
    record.acceptance!.observationsTruncated = true
    f.service.store.save(record)
    const before = f.service.get(f.app.id).acceptance!
    const checks = untestedChecks().map(check => check.category === 'startup' ? check : ({
      ...check, result: 'passed' as const, basis: 'runtime' as const, evidence: [source], observations: [before.observations[0].id],
    }))
    await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author', { checks }, AbortSignal.timeout(5000)), error => {
      assert.ok(error instanceof AppReportValidationError)
      const diagnostic = JSON.parse(error.message.slice(error.message.indexOf('\n') + 1))
      assert.deepEqual(diagnostic.issues.map((issue: { category: string }) => issue.category), ['state', 'recovery', 'reopen'])
      for (const issue of diagnostic.issues) {
        assert.deepEqual(issue.candidateObservationIds, [])
        assert.deepEqual(issue.missingCitationIds, [])
        assert.equal(issue.observationsTruncated, true)
      }
      return true
    })
    assert.deepEqual(f.service.get(f.app.id).acceptance, before)
  } finally { await f.service.shutdown() }
}))

test('unknown and previous-request observations are rejected together, not silently replaced by candidates', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await f.approve(); await f.answer(0)
    const oldId = f.service.get(f.app.id).acceptance!.id
    f.service.acceptance.observe(f.app.id, oldId, randomUUID(), 'sdk_connected')
    const oldObservationId = f.service.get(f.app.id).acceptance!.observations[0].id
    await f.service.revoke(f.app.id)
    await f.approve(); await f.answer(0)
    const checks = untestedChecks()
    checks[0].observations = [oldObservationId]
    checks[1].observations = [randomUUID()]
    const before = f.service.get(f.app.id).acceptance!
    await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author', { checks }, AbortSignal.timeout(5000)), error => {
      assert.ok(error instanceof AppReportValidationError)
      assert.equal(error.code, 'unknown_observation')
      const diagnostic = JSON.parse(error.message.slice(error.message.indexOf('\n') + 1))
      assert.notEqual(diagnostic.acceptanceId, oldId)
      assert.deepEqual(diagnostic.issues.map((issue: { unknownObservationIds: string[] }) => issue.unknownObservationIds),
        [checks[0].observations, checks[1].observations])
      assert.ok(diagnostic.issues.every((issue: { candidateObservationIds?: string[] }) => issue.candidateObservationIds === undefined))
      return true
    })
    assert.deepEqual(f.service.get(f.app.id).acceptance, before)
  } finally { await f.service.shutdown() }
}))

test('recovery hints preserve coalesced completion sequences and failure/cancel kind matching', async t => {
  for (const failure of ['backend_failed', 'backend_cancelled', 'model_cancelled'] as const) {
    await t.test(failure, async () => withTempWorkspace(async home => {
      const f = await fixture(home)
      try {
        await f.approve(); await f.answer(0)
        const acceptanceId = f.service.get(f.app.id).acceptance!.id, run = randomUUID()
        const completion = failure.startsWith('backend_') ? 'backend_completed' : 'model_completed'
        f.service.acceptance.observe(f.app.id, acceptanceId, run, completion)
        f.service.acceptance.observe(f.app.id, acceptanceId, run, failure)
        f.service.acceptance.observe(f.app.id, acceptanceId, run, completion)
        const observations = f.service.get(f.app.id).acceptance!.observations
        const completed = observations.find(item => item.kind === completion)!, failed = observations.find(item => item.kind === failure)!
        assert.equal(completed.count, 2)
        assert.ok(completed.firstSequence < failed.firstSequence && completed.lastSequence > failed.lastSequence)
        const checks = untestedChecks()
        checks[2] = { ...checks[2], result: 'passed', basis: 'runtime', summary: 'Synthetic host sequence, not a real business test.',
          observations: [completed.id], evidence: [source] }
        await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author', { checks }, AbortSignal.timeout(5000)), error => {
          assert.ok(error instanceof AppReportValidationError)
          const diagnostic = JSON.parse(error.message.slice(error.message.indexOf('\n') + 1))
          assert.equal(diagnostic.issues.length, 1)
          assert.deepEqual(diagnostic.issues[0].candidateObservationIds, [failed.id, completed.id])
          assert.deepEqual(diagnostic.issues[0].missingCitationIds, [failed.id])
          return true
        })
        checks[2].observations.push(failed.id)
        const result = await f.service.acceptance.report(f.app.id, f.app.revision, 'web:author', { checks }, AbortSignal.timeout(5000))
        assert.equal(result!.report!.result.checks[2].result, 'passed')
        assert.deepEqual(result!.observations, observations, 'Repair needs no extra run or observation')
      } finally { await f.service.shutdown() }
    }))
  }
})

test('valid observation hints cannot bypass tool evidence, aborts, approval changes or request replacement', async t => {
  for (const failure of ['evidence', 'aborted', 'revoked', 'replaced'] as const) {
    await t.test(failure, async () => withTempWorkspace(async home => {
      const controller = new AbortController()
      const f = await fixture(home, [], async () => {
        if (failure === 'evidence') throw new Error('Recorded excerpt does not match')
        if (failure === 'aborted') controller.abort()
        if (failure === 'revoked') await f.service.revoke(f.app.id)
        if (failure === 'replaced') {
          const record = f.service.store.get(f.app.id)
          record.acceptance = f.service.acceptance.create(record)
          record.acceptance!.decision = 'user'
          record.acceptance!.status = 'notified'
          f.service.store.save(record)
        }
      })
      try {
        await f.approve(); await f.answer(0)
        await f.connect()
        const observations = f.service.get(f.app.id).acceptance!.observations.map(item => item.id)
        const checks = untestedChecks()
        checks[0] = { ...checks[0], result: 'passed', basis: 'runtime', observations, evidence: [source] }
        await assert.rejects(f.service.acceptance.report(f.app.id, f.app.revision, 'web:author', { checks }, controller.signal),
          failure === 'evidence' ? /excerpt does not match/ : failure === 'aborted' ? { name: 'AbortError' }
            : failure === 'revoked' ? /approval/ : /Testing request changed/)
        assert.equal(f.service.get(f.app.id).acceptance?.report, undefined)
      } finally { await f.service.shutdown() }
    }))
  }
})

test('reports cover the immutable published Work criteria, including unavailable hardware, and validation does not fence repairs', async () => withTempWorkspace(async home => {
  const work = [{ key: 'work:fixture', revision: 2, acceptance: ['Text becomes speech', 'Incoming audio becomes subtitles'] }]
  const f = await fixture(home, work)
  const tools = new SessionTools(new Tools(home), home)
  const tool = new MicroAppTool(f.service, () => {})
  const context = { sessionId: 'web:author', projectId: 'p', tools, signal: AbortSignal.timeout(5000) } as ExecutionContext
  try {
    work[0].acceptance[0] = 'Changed after publication'
    await f.approve(); await f.answer(0)
    const acceptance = f.service.get(f.app.id).acceptance!
    assert.equal(acceptance.work![0].acceptance[0], 'Text becomes speech')
    const report = { checks: untestedChecks() }
    const args = { action: 'report', id: f.app.id, revision: f.app.revision, report }
    await assert.rejects(tool.execute(args, context), error => error instanceof ToolNoEffectError && /every published Work/.test(error.message))
    assert.equal(f.service.get(f.app.id).acceptance!.report, undefined)
    const requirements = acceptance.work!.flatMap(scope => scope.acceptance.map((_text, criterion) => ({
      result: 'not_tested' as const, basis: 'not_tested' as const, summary: 'No device access.', observations: [], evidence: [],
      workKey: scope.key, workRevision: scope.revision, criterion,
    })))
    await assert.rejects(tool.execute({ ...args, report: { ...report, requirements: [requirements[0], requirements[0]] } }, context), ToolNoEffectError)
    await assert.rejects(tool.execute({ ...args, report: { ...report, requirements: requirements.map(check => ({ ...check, workRevision: 3 })) } }, context), ToolNoEffectError)
    await assert.rejects(tool.execute({ ...args, report: { ...report, requirements: requirements.map(check => ({ ...check, result: 'passed', basis: 'fixture' })) } }, context), ToolNoEffectError)
    const result = JSON.parse(await tool.execute({ ...args, report: { ...report, requirements } }, context))
    assert.equal(result.status, 'reported')
    assert.equal(result.report.result.requirements.length, 2)
    assert.equal(result.report.result.requirements[1].result, 'not_tested')
    const restored = new MicroApps('p', home, () => { throw new Error('No model') }, () => 'fixture')
    await restored.init()
    assert.deepEqual(restored.get(f.app.id).acceptance!.report, result.report)
    await restored.shutdown()
  } finally { await tools.resetDynamicAndWait(); await f.service.shutdown() }
}))

test('handoff observes only the matching native event and records missing reports or blockers without replay', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await f.approve(); await f.answer(0)
    const acceptance = f.service.get(f.app.id).acceptance!
    const fact = { sessionId: 'web:author', inputId: `microapp-test:${acceptance.id}`, turnId: 'turn-1',
      source: { kind: 'event' as const, eventId: acceptance.id, type: 'microapp.testing.ready', source: 'system' } }
    f.service.acceptance.authorTurn({ ...fact, sessionId: 'web:peer' })
    f.service.acceptance.authorTurn({ ...fact, inputId: 'unrelated' })
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'notified')
    f.service.acceptance.authorTurn(fact)
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'running')
    await assert.rejects(f.service.requestTesting(f.app.id, f.app.revision), /already active/)
    await f.connect()
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'testing')
    await f.service.stopFromAuthor(f.app.id, 'web:author')
    f.service.acceptance.authorTurn({ ...fact, turnId: 'other-turn' }, 'completed')
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'testing')
    f.service.acceptance.authorTurn(fact, 'completed')
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'incomplete')
    assert.equal(f.service.get(f.app.id).acceptance!.authorTurn!.outcome, 'completed')
    assert.throws(() => f.service.acceptance.authorize(f.app.id, f.app.revision, 'web:author'), /incomplete/)
    assert.equal(f.notifications.length, 1)
    await f.service.requestTesting(f.app.id, f.app.revision)
    await wait(() => !!f.yields.get('web:author')); await f.answer(0)
    const second = { ...fact, inputId: `microapp-test:${f.service.get(f.app.id).acceptance!.id}`, turnId: 'turn-2',
      source: { ...fact.source, eventId: f.service.get(f.app.id).acceptance!.id } }
    f.service.acceptance.authorTurn(fact, 'failed')
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'notified')
    f.block('Waiting for device permission')
    f.service.acceptance.authorTurn(second)
    f.service.acceptance.authorTurn(second, 'completed')
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'blocked')
    assert.match(f.service.get(f.app.id).acceptance!.error!, /device permission/)
    assert.equal(f.notifications.length, 2)
  } finally { await f.service.shutdown() }
}))

test('failed and cancelled author turns are terminal without replacing an already saved report', async t => {
  for (const outcome of ['failed', 'cancelled', 'reported'] as const) {
    await t.test(outcome, async () => withTempWorkspace(async home => {
      const f = await fixture(home)
      try {
        await f.approve(); await f.answer(0)
        const acceptance = f.service.get(f.app.id).acceptance!
        const fact = { sessionId: 'web:author', inputId: `microapp-test:${acceptance.id}`, turnId: 'terminal-turn',
          source: { kind: 'event' as const, eventId: acceptance.id, type: 'microapp.testing.ready', source: 'system' } }
        f.service.acceptance.authorTurn(fact)
        if (outcome === 'reported') await f.service.acceptance.report(f.app.id, f.app.revision, 'web:author',
          { checks: untestedChecks() }, AbortSignal.timeout(5000))
        f.block('Waiting for approval of this already approved version')
        f.service.acceptance.authorTurn({ ...fact, error: 'live_test_call_budget_exhausted' }, outcome === 'cancelled' ? 'cancelled' : 'failed')
        const current = f.service.get(f.app.id).acceptance!
        assert.equal(current.status, outcome === 'cancelled' ? 'interrupted' : outcome)
        assert.ok(current.authorTurn!.finishedAt)
        assert.equal(f.notifications.length, 1)
        if (outcome === 'reported') assert.ok(current.report)
        else {
          assert.doesNotMatch(current.error!, /Waiting for approval/)
          assert.match(current.error!, outcome === 'failed' ? /live_test_call_budget_exhausted/ : /cancelled/)
          const restored = new MicroApps('p', home, () => { throw new Error('No provider call expected') }, () => 'fixture')
          await restored.init()
          assert.equal(restored.get(f.app.id).acceptance!.error, current.error)
          await restored.shutdown()
        }
      } finally { await f.service.shutdown() }
    }))
  }
})

test('a report persistence acknowledgement failure is not classified as a no-effect validation rejection', async t => withTempWorkspace(async home => {
  const f = await fixture(home), tools = new SessionTools(new Tools(home), home)
  const tool = new MicroAppTool(f.service, () => {})
  const context = { sessionId: 'web:author', projectId: 'p', tools, signal: AbortSignal.timeout(5000) } as ExecutionContext
  try {
    await f.approve(); await f.answer(0)
    const save = f.service.store.save.bind(f.service.store)
    t.mock.method(f.service.store, 'save', (record: AppRecord) => { save(record); throw new Error('Synthetic lost persistence acknowledgement') })
    await assert.rejects(tool.execute({ action: 'report', id: f.app.id, revision: f.app.revision, report: { checks: untestedChecks() } }, context),
      error => error instanceof Error && !(error instanceof ToolNoEffectError) && /lost persistence/.test(error.message))
    assert.equal(f.service.get(f.app.id).acceptance!.status, 'reported')
  } finally { await tools.resetDynamicAndWait(); await f.service.shutdown() }
}))
