import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Hono } from 'hono'
import { LearningMaintenanceTool, maintenanceOwnerAccess } from './learning-maintenance.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'
import { YieldManager } from '../sessions/yield.ts'
import type { YieldDecisionRecord, YieldOutcome } from '../sessions/yield-contract.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectMaintenanceSources } from '../agent/learning/maintenance-sources.ts'
import { DocumentMaintenanceOperation, DocumentMaintenanceRestoration } from '../agent/learning/maintenance-documents.ts'
import { MaintenanceGate } from '../agent/learning/maintenance-gate.ts'
import { DocumentMaintenanceProtection } from '../agent/learning/maintenance-protection.ts'
import { checksum } from '../agent/learning/maintenance-contracts.ts'
import { SkillsManager } from '../skills/loader.ts'
import { SkillEditStore } from '../skills/edit-store.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { KnowledgeService } from '../knowledge/service.ts'
import { MemoryStore } from '../agent/memory.ts'
import { createMemoryHandler } from '../vfs/mounts.ts'
import { encapsulationInputs } from '../agent/learning/inputs.ts'
import { registerKnowledgeRoutes } from '../knowledge/routes.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { Bus } from '../bus/bus.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import { executionModeAllowsTool } from '../sessions/execution-mode.ts'

const projectId = 'synthetic-owner-entry'
const sessionId = 'web:synthetic-owner'
const skill = (name: string, text: string) => `---\nname: ${name}\ndescription: Synthetic owner entry test\n---\n${text}\n`
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10_000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Synthetic host waiter did not open')
    await new Promise(resolve => setImmediate(resolve))
  }
}
async function fixture(home: string, fault: (stage: string) => void = () => {}) {
  const skills = new SkillsManager(home)
  const file = (path: string, text: string) => { const name = projectStoragePath(home, path); mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text) }
  for (const name of ['archive', 'seed', 'retain', 'manual']) file(`memory/topics/${name}.md`, `# ${name}\nOriginal ${name} bytes\n`)
  file('memory/events/2026-11-17.jsonl', JSON.stringify({ what: 'Synthetic untouched evidence', who: 'synthetic' }) + '\n')
  const store = new SkillEditStore(home, skills)
  await store.save('archive-fixture', { 'SKILL.md': skill('archive-fixture', 'Original skill') }, null)
  await store.save('seed-fixture', { 'SKILL.md': skill('seed-fixture', 'Original full skill') }, null)
  const state: SessionState = { projectId, sessionId, segmentIndex: 0, physicalIdVersion: 2, mode: 'session' }
  let managed = false, local = true, available = true
  const sources = new ProjectMaintenanceSources(home, projectId, skills, {
    async inventory() { throw new Error('History must never be enumerated') }, async messages() { throw new Error('History must never be read') },
  }, new Set(['memory/topics/manual.md']))
  const protection = new DocumentMaintenanceProtection(home, projectId)
  const executionSources = new ProjectMaintenanceSources(home, projectId, skills, sources.history, new Set(['memory/topics/manual.md']), path => protection.assertUnprotected(path))
  const operation = new DocumentMaintenanceOperation(home, projectId, executionSources, skills, fault)
  const restoration = new DocumentMaintenanceRestoration(home, projectId, executionSources, skills, fault)
  const gate = new MaintenanceGate(home), records: YieldDecisionRecord[] = []
  const yields = new YieldManager({ getState: id => id === sessionId ? state : undefined, getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => { throw new Error('Host ownerOnly questions use existing UI state, not agent notifications') }, notifyParent: async () => { throw new Error('Never a parent decision') },
    journal: { open: async request => ({ ...request, origin: { physicalId: physicalSessionId(state) } }), write: async record => { records.push(record) } },
  })
  const tools = new SessionTools(new Tools(home), home); tools.setExecutionScope('session', ['task', 'call'])
  const context: ExecutionContext = { projectId, sessionId, physicalSessionId: physicalSessionId(state), channel: 'web', chatId: 'synthetic', senderId: 'synthetic', messageId: 'synthetic',
    cwd: home, admin: true, inputSource: 'user', soleDirectToolCall: true, tools, signal: new AbortController().signal }
  const canUse = (ctx: ExecutionContext) => available && maintenanceOwnerAccess(ctx, projectId, state, managed, local)
  const make = (broker: Pick<YieldManager, 'askOwner'> = yields) => new LearningMaintenanceTool(projectId, sources, operation, restoration, gate, protection, broker, canUse)
  const tool = make()
  const call = async (args: Record<string, unknown>, ctx = context) => JSON.parse(await tool.execute(args, ctx))
  const paths = ['memory/topics/archive.md', 'memory/topics/seed.md', 'memory/topics/retain.md', 'skills/archive-fixture/SKILL.md', 'skills/seed-fixture/SKILL.md']
  const documents = (await call({ action: 'inspect', paths })).map(({ provenance: _, ...item }: Record<string, string>) => ({ ...item,
    disposition: item.path!.includes('retain') ? 'retain' : item.path!.includes('seed') ? 'seed' : 'archive',
    ...(item.path!.includes('seed') ? { replacementText: item.path!.startsWith('memory/') ? '# seed\nCondensed\n' : skill('seed-fixture', 'Condensed skill') } : {}),
  }))
  const preview = () => call({ action: 'preview', documents })
  const respond = async (pending: Promise<unknown>, option = 0, before?: () => void) => {
    await until(() => !!yields.get(sessionId))
    const request = yields.get(sessionId)!
    assert.equal(request.ownerOnly, true); assert.equal(request.recipient.kind, 'user')
    before?.()
    await yields.answerUser(sessionId, request.id, request.options[option]!)
    return pending as Promise<any>
  }
  const reviewed = async () => { const draft = await preview(); return respond(call({ action: 'review', revision: draft.revision })) }
  return { home, skills, file, sources, executionSources, protection, operation, restoration, gate, state, yields, records, tools, context, make, tool, call, documents, preview, respond, reviewed,
    managed: (value: boolean) => { managed = value }, local: (value: boolean) => { local = value }, available: (value: boolean) => { available = value } }
}

test('sole direct durable local owner boundary and mode/discovery ceiling use current host identity', async () => withTempWorkspace(async home => {
  const f = await fixture(home), baseline = f.gate.status()
  for (const override of [
    { projectId: 'foreign' }, { channel: 'a2a' }, { sessionId: 'web:foreign' }, { admin: false }, { inputSource: 'session' as const }, { inputSource: 'event' as const },
    { soleDirectToolCall: false }, { recoveringToolCall: true }, { scriptInvocation: true }, { isGroup: true },
    { remoteWorkdir: {} as ExecutionContext['remoteWorkdir'] }, { layerfsWorkdir: { workspace: 'synthetic' } }, { memoryAccess: {} as ExecutionContext['memoryAccess'] }, { physicalSessionId: 'stale-physical' },
  ]) await assert.rejects(f.call({ action: 'status' }, { ...f.context, ...override }), /owning local durable/)
  for (const patch of [{ mode: 'task' as const }, { mode: 'call' as const }, { parentSessionId: 'web:parent' }, { parent: { sessionId: 'web:parent' } }, { projectId: 'foreign' }, { automation: {} }, { statePersistence: {} }]) {
    const old = { ...f.state }; Object.assign(f.state, patch)
    await assert.rejects(f.call({ action: 'status' }), /owning local durable/)
    for (const key of Object.keys(f.state)) delete (f.state as any)[key]
    Object.assign(f.state, old)
  }
  f.managed(true); await assert.rejects(f.call({ action: 'status' }), /owning local durable/); f.managed(false)
  f.local(false); await assert.rejects(f.call({ action: 'status' }), /owning local durable/); f.local(true)
  f.available(false); await assert.rejects(f.call({ action: 'status' }), /owning local durable/); f.available(true)
  for (const mode of ['call', 'task'] as const) assert.equal(executionModeAllowsTool(mode, 'learning_maintenance'), false)
  f.tools.setExecutionScope('task', ['call']); await assert.rejects(f.call({ action: 'status' }), /owning local durable/)
  assert.deepEqual(f.gate.status(), baseline); assert.equal(f.operation.status(), null); assert.equal(f.records.length, 0)
}))

test('current formal sources and full retained/seed bodies are registered; stale checklist hashes and forged authority are rejected without writes', async () => withTempWorkspace(async home => {
  const f = await fixture(home), before = f.gate.status(), draft = await f.preview()
  assert.equal(draft.plan.provenance, 'unknown-not-automatic')
  assert.equal(draft.plan.effects.history, 'none'); assert.equal(draft.plan.effects.epoch, 'unchanged')
  assert.match(Buffer.from(draft.plan.originals['memory/topics/retain.md'].files['page.md'], 'base64').toString(), /Original retain/)
  assert.match(draft.plan.documents.find((item: any) => item.path === 'memory/topics/seed.md').replacementText, /Condensed/)
  const skillSelection = f.documents.find((item: any) => item.path === 'skills/seed-fixture/SKILL.md')!
  assert.notEqual(skillSelection.sourceRevision, skillSelection.sourceTextDigest)
  for (const path of ['memory/identities/owner.md', 'memory/decisions/policy.md', 'memory/events/2026-11-17.jsonl', 'memory/topics/manual.md', 'src/skills/builtin/SKILL.md']) {
    await assert.rejects(f.call({ action: 'inspect', paths: [path] }))
  }
  f.file('skills/archive-fixture/resource.txt', 'protected resource')
  await assert.rejects(f.call({ action: 'inspect', paths: ['skills/archive-fixture/SKILL.md'] }), /members|protected/)
  for (const action of ['review', 'execute']) {
    await assert.rejects(f.call({ action, revision: draft.revision, approved: true }))
    await assert.rejects(f.call({ action, revision: checksum('forged reference') }), /Unknown/)
  }
  const edited = structuredClone(draft); edited.plan.documents[0].replacementText = 'tampered only detached return'
  assert.deepEqual((await f.call({ action: 'read', revision: draft.revision })).plan, draft.plan)
  f.file('memory/topics/seed.md', 'CHANGED SINCE OLD CHECKLIST')
  await assert.rejects(f.call({ action: 'preview', documents: f.documents.filter((item: any) => item.path !== 'skills/archive-fixture/SKILL.md') }), /changed/i)
  assert.equal(f.operation.status(), null); assert.deepEqual(f.gate.status(), before); assert.equal(f.records.length, 0)
  assert.equal(existsSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json')), false)
}))

for (const mode of ['denied', 'cancelled', 'parent', 'forged-user-reference', 'wrong-origin', 'default', 'revoked', 'changed-source', 'gate-race'] as const) {
  test(`${mode}: no unapproved operation/fence/source mutation at the actual entry`, async t => withTempWorkspace(async home => {
    const f = await fixture(home), reviewed = await f.reviewed(), before = f.gate.status()
    let pending: Promise<unknown>
    if (mode === 'forged-user-reference' || mode === 'wrong-origin' || mode === 'default') {
      const broker: Pick<YieldManager, 'askOwner'> = { askOwner: async (...args) => {
        const answer = await f.yields.askOwner(...args)
        if (mode === 'wrong-origin' && 'reference' in answer) return { ...answer, reference: { ...answer.reference!, physicalId: 'forged' } }
        if (mode === 'default') return { ...answer, answeredBy: 'timeout' } as YieldOutcome
        return { ...answer, requestId: 'forged' } as YieldOutcome
      } }
      const guarded = f.make(broker)
      const draft = JSON.parse(await guarded.execute({ action: 'preview', documents: f.documents }, f.context))
      // A malformed USER receipt is rejected during content review itself.
      pending = guarded.execute({ action: 'review', revision: draft.revision }, f.context)
    } else pending = f.call({ action: 'execute', revision: reviewed.revision })
    const rejected = assert.rejects(pending)
    await until(() => !!f.yields.get(sessionId))
    const request = f.yields.get(sessionId)!
    if (mode === 'parent') {
      assert.throws(() => f.yields.answerParent('web:parent', request.id, request.options[0]!), /parent|user/i)
      await f.yields.cancelUser(sessionId, request.id)
    } else if (mode === 'cancelled') await f.yields.cancelUser(sessionId, request.id)
    else {
      if (mode === 'revoked') f.managed(true)
      if (mode === 'changed-source') f.file('memory/topics/seed.md', 'Concurrent user edit')
      if (mode === 'gate-race') f.gate.writeSync(['memory/topics/retain.md'], () => undefined)
      await f.yields.answerUser(sessionId, request.id, request.options[mode === 'denied' ? 1 : 0]!)
    }
    await rejected
    assert.equal(f.operation.status(), null); assert.equal(f.restoration.status(), null)
    if (mode !== 'gate-race') assert.deepEqual(f.gate.status(), before)
    assert.equal(f.gate.status().operation, null); assert.equal(f.gate.status().retired.length, 0)
    assert.match(readFileSync(projectStoragePath(home, 'memory/topics/archive.md'), 'utf8'), /Original archive/)
  }))
}

test('real broker timeout/default cannot authorize execution, and duplicate attempts never replay', async t => withTempWorkspace(async home => {
  const f = await fixture(home), reviewed = await f.reviewed(), before = f.gate.status()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = f.call({ action: 'execute', revision: reviewed.revision }), rejected = assert.rejects(pending, /approval/)
  await until(() => !!f.yields.get(sessionId))
  t.mock.timers.tick(600_001)
  await rejected
  await assert.rejects(f.call({ action: 'execute', revision: reviewed.revision }), /attempted|unknown/)
  assert.equal(f.operation.status(), null); assert.deepEqual(f.gate.status(), before)
}))

test('archive → independent restoration through the real adapter restores original readers/consumers and preserves receipts', async () => withTempWorkspace(async home => {
  const f = await fixture(home), reviewed = await f.reviewed()
  assert.equal(f.operation.status(), null, 'content approval is not execution approval')
  const originals = new Map<string, Buffer>(f.documents.map((item: any) => [item.path, readFileSync(projectStoragePath(home, item.path))]))
  const committed = await f.respond(f.call({ action: 'execute', revision: reviewed.revision }))
  assert.equal(committed.phase, 'committed')
  const originalReceipt = readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json'))
  assert.equal(new KnowledgeService(home, f.skills).catalog().entries.some(item => item.id === 'memory/topics/archive.md'), false)
  await assert.rejects(async () => createMemoryHandler(home, projectId).read('topics/archive.md', f.context), /Retired document/)
  assert.equal(f.skills.getSkillBody('archive-fixture'), undefined)
  assert.match(f.skills.getSkillBody('seed-fixture')!, /Condensed skill/)
  assert.doesNotMatch(await new MemoryStore(home).readKeywords(), /archive —/)
  assert.equal((await encapsulationInputs(home, f.context.signal)).some(item => item.path === 'memory/topics/archive.md'), false)
  for (const item of committed.plan.request.documents) assert.equal(f.operation.snapshot(item.snapshotRevision).historical, true)
  const restore = await f.call({ action: 'recovery_preview', direction: 'restore' })
  assert.equal(f.restoration.status(), null)
  await assert.rejects(f.call({ action: 'execute', revision: reviewed.revision }), /changed|attempted/)
  const restored = await f.respond(f.call({ action: 'execute', revision: restore.revision }))
  assert.equal(restored.phase, 'committed')
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(projectStoragePath(home, path)), bytes)
  assert.deepEqual(readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json')), originalReceipt)
  assert.deepEqual(f.gate.status().retired, [])
  assert.match(await createMemoryHandler(home, projectId).read('topics/archive.md', f.context), /Original archive/)
  assert.match(f.skills.getSkillBody('archive-fixture')!, /Original skill/)
  assert.equal(new KnowledgeService(home, f.skills).catalog().entries.some(item => item.id === 'memory/topics/archive.md'), true)
  assert.match(await new MemoryStore(home).readKeywords(), /archive/)
  assert.equal((await encapsulationInputs(home, f.context.signal)).some(item => item.path === 'memory/topics/archive.md'), true)
  assert.equal(f.records.filter(record => record.answer?.answeredBy === 'user').length, 3)
}))

for (const direction of ['resume', 'rollback'] as const) test(`unknown result and restart: ${direction} requires fresh exact-receipt plan and human confirmation`, async () => withTempWorkspace(async home => {
  let fault = true
  const f = await fixture(home, stage => { if (fault && stage === 'before-visibility') { fault = false; throw new Error('Synthetic interrupted outcome') } })
  const reviewed = await f.reviewed()
  await assert.rejects(f.respond(f.call({ action: 'execute', revision: reviewed.revision })), /Synthetic interrupted/)
  const restarted = f.make(), invoke = async (args: Record<string, unknown>) => JSON.parse(await restarted.execute(args, f.context))
  assert.ok((await invoke({ action: 'status' })).archive)
  await assert.rejects(invoke({ action: 'execute', revision: reviewed.revision }), /Unknown/)
  const next = await invoke({ action: 'recovery_preview', direction })
  const before = f.operation.status()
  assert.deepEqual((await invoke({ action: 'status' })).archive, before)
  const pending = invoke({ action: 'execute', revision: next.revision })
  await until(() => !!f.yields.get(sessionId)); assert.deepEqual(f.operation.status(), before)
  const result = await f.respond(pending)
  assert.equal(result.phase, direction === 'resume' ? 'committed' : 'rolled-back')
  await assert.rejects(invoke({ action: 'execute', revision: next.revision }), /changed|attempted/)
}))

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: real host session decision UI authorization and journal settlement feed the production adapter`, async () => withTempWorkspace(async home => {
  const f = await fixture(home), store = new Store(join(home, 'sessions')); await store.init()
  const provider: any = { name: 'synthetic', listModels: () => ['fixture'], chat: async () => { throw new Error('No inference in host approval test') } }
  const sessions = new SessionManager({ workspace: home, projectId, store, bus: new Bus(), provider, tools: new Tools(home), context: new ContextBuilder(home),
    handoffManager: new HandoffManager(provider, 128000, { autoHandoff: false }, home, store), getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
    getYieldPolicy: () => ({ timeoutMs: null }), agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }) },
    events: { emit: async () => {} },
  } as unknown as SessionManagerDeps)
  const app = new Hono()
  sessionsApiPlugin(sessions, { authorizeOwnerDecision: request => request.headers.get('x-owner') === 'yes' })(app)
  const adapter = f.make(sessions.yields)
  registerKnowledgeRoutes(app, { workspace: home, skills: f.skills, authorize: request => request.headers.get('x-owner') === 'yes', ownerMaintenancePlan: revision => adapter.ownerPlan(revision) })
  try {
    await sessions.start(); await sessions.buildSession(sessionId, undefined, { agentType: 'general' })
    const state = sessions.getSessionState(sessionId)!
    const context = { ...f.context, physicalSessionId: physicalSessionId(state) }
    // Fixture durable state has the same physical lineage as the real host state.
    assert.equal(context.physicalSessionId, f.context.physicalSessionId)
    const draft = JSON.parse(await adapter.execute({ action: 'preview', documents: f.documents }, context))
    const scopedApp = new Hono(); scopedApp.route(`/projects/${projectId}`, app)
    assert.equal((await scopedApp.request(draft.fullPlanUrl)).status, 401)
    const read = await scopedApp.request(draft.fullPlanUrl, { headers: { 'x-owner': 'yes' } }); assert.equal(read.status, 200)
    assert.deepEqual((await read.json()).plan, draft.plan)
    const pending = adapter.execute({ action: 'review', revision: draft.revision }, context)
    await until(() => !!sessions.yields.get(sessionId))
    const request = sessions.yields.get(sessionId)!
    const body = JSON.stringify({ requestId: request.id, option: request.options[0] })
    assert.equal((await app.request(`/api/sessions/${sessionId}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401)
    assert.throws(() => sessions.yields.answerParent('web:parent', request.id, request.options[0]!), /parent|user/i)
    assert.equal((await app.request(`/api/sessions/${sessionId}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner': 'yes' }, body })).status, 200)
    const reviewed = JSON.parse(await pending); assert.ok(reviewed.plan.contentDecision)
    const records = await sessions.getYieldRecords(sessionId)
    assert.equal(records[0]!.answer?.answeredBy, 'user'); assert.equal(records[0]!.request.ownerOnly, true)
    assert.equal(f.operation.status(), null)
    const throughUi = async (revision: string) => {
      const executing = adapter.execute({ action: 'execute', revision }, context)
      await until(() => !!sessions.yields.get(sessionId))
      const prompt = sessions.yields.get(sessionId)!
      assert.match(prompt.question, /Authorize EXECUTION/)
      const response = await app.request(`/api/sessions/${sessionId}/ask`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner': 'yes' }, body: JSON.stringify({ requestId: prompt.id, option: prompt.options[0] }) })
      assert.equal(response.status, 200)
      return JSON.parse(await executing)
    }
    assert.equal((await throughUi(reviewed.revision)).phase, 'committed')
    const restore = JSON.parse(await adapter.execute({ action: 'recovery_preview', direction: 'restore' }, context))
    assert.equal((await throughUi(restore.revision)).phase, 'committed')
    assert.match(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), /Original seed/)
    assert.equal((await sessions.getYieldRecords(sessionId)).filter(record => record.answer?.answeredBy === 'user').length, 3)
    const apply = await app.request('/api/knowledge/learning-maintenance/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner': 'yes' }, body: JSON.stringify({ operationId: crypto.randomUUID(), manifestRevision: checksum('forged') }) })
    assert.equal(apply.status, 503)
  } finally { await sessions.stop(); store.close?.() }
}))


test('full-list human classification persists Project-local exact policy/audit; missing/new entries and manual downgrades remain protected', async () => withTempWorkspace(async home => {
  const f = await fixture(home), inventory = await f.call({ action: 'inventory' })
  assert.equal(inventory.eligible.length, 5)
  assert.ok(inventory.unsupported.some((item: any) => item.path === 'memory/topics/manual.md'))
  assert.equal(f.protection.status(), null)
  await assert.rejects(f.call({ action: 'preview', documents: f.documents.slice(1) }), /full supported-document/)
  assert.equal(f.protection.status(), null); assert.equal(f.records.length, 0)
  const classified = f.documents.map((item: any) => item.disposition === 'retain' ? { ...item, disposition: 'protected' } : item)
  const draft = await f.call({ action: 'preview', documents: classified })
  const reviewed = await f.respond(f.call({ action: 'review', revision: draft.revision }))
  const policy = new DocumentMaintenanceProtection(home, projectId).status()!
  assert.equal(policy.contentPlanRevision, draft.revision)
  assert.equal(policy.provenance, 'unknown-not-attested-by-human-classification')
  assert.deepEqual(policy.protectedPaths, ['memory/topics/retain.md'])
  assert.equal(policy.classifications.length, 5)
  assert.equal(f.operation.status(), null)
  assert.throws(() => f.executionSources.observeDocument('memory/topics/retain.md'), /known-manual/)
  await assert.rejects(f.call({ action: 'preview', documents: classified.map((item: any) => item.disposition === 'protected' ? { ...item, disposition: 'archive' } : item) }), /known-manual/)
  f.file('memory/topics/new-unreviewed.md', '# New\nUnreviewed source\n')
  await assert.rejects(f.call({ action: 'execute', revision: reviewed.revision }), /inventory changed/)
  assert.equal(f.operation.status(), null); assert.equal(f.gate.status().operation, null)
  assert.equal(new DocumentMaintenanceProtection(home, projectId).revision(), f.protection.revision())
  const foreign = new DocumentMaintenanceProtection(home, 'foreign-project')
  assert.throws(() => foreign.status(), /Foreign/)
  assert.throws(() => f.protection.publish(policy.classifications, policy.originals, policy.inventoryRevision, policy.contentPlanRevision,
    policy.decisionReference, checksum('stale-policy-version')), /changed/)
}))

for (const stage of ['reserved', 'snapshot-written'] as const) for (const direction of ['resume', 'rollback'] as const) {
  test(`${stage}: incomplete capture restart supports independently confirmed ${direction} without repairing corrupt snapshots`, async () => withTempWorkspace(async home => {
    let fail = true
    const f = await fixture(home, point => { if (fail && point === stage) { fail = false; throw new Error('Synthetic partial capture') } })
    const reviewed = await f.reviewed()
    await assert.rejects(f.respond(f.call({ action: 'execute', revision: reviewed.revision })), /partial capture/)
    const restarted = f.make(), invoke = async (args: Record<string, unknown>) => JSON.parse(await restarted.execute(args, f.context))
    const status = await invoke({ action: 'status' }), next = await invoke({ action: 'recovery_preview', direction })
    assert.ok(Object.values(next.plan.preimageAvailability).includes('source-only-missing-snapshot-requires-prepare'))
    assert.deepEqual(f.operation.status(), status.archive, 'read-only recovery planning cannot capture missing snapshots')
    const result = await f.respond(invoke({ action: 'execute', revision: next.revision }))
    assert.equal(result.phase, direction === 'resume' ? 'committed' : 'rolled-back')
  }))
}

test('post-archive restoration restart uses a fresh receipt-bound confirmation, never original archive/content approval', async () => withTempWorkspace(async home => {
  let interrupt = true
  const f = await fixture(home, stage => { if (interrupt && stage === 'restore-before-visibility') { interrupt = false; throw new Error('Synthetic restore interruption') } })
  const reviewed = await f.reviewed(); await f.respond(f.call({ action: 'execute', revision: reviewed.revision }))
  const restore = await f.call({ action: 'recovery_preview', direction: 'restore' })
  await assert.rejects(f.respond(f.call({ action: 'execute', revision: restore.revision })), /restore interruption/)
  const original = readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json'))
  const restarted = f.make(), invoke = async (args: Record<string, unknown>) => JSON.parse(await restarted.execute(args, f.context))
  await assert.rejects(invoke({ action: 'execute', revision: restore.revision }), /Unknown/)
  const recovery = await invoke({ action: 'recovery_preview', direction: 'resume-restore' }), before = f.restoration.status()
  const pending = invoke({ action: 'execute', revision: recovery.revision })
  await until(() => !!f.yields.get(sessionId)); assert.deepEqual(f.restoration.status(), before)
  assert.equal((await f.respond(pending)).phase, 'committed')
  assert.deepEqual(readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json')), original)
  assert.match(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), /Original seed/)
}))


test('gate CAS rejects a writer that completes after execution confirmation but immediately before archive prepare', async () => withTempWorkspace(async home => {
  const f = await fixture(home), reviewed = await f.reviewed(), prepare = f.operation.prepare.bind(f.operation)
  f.operation.prepare = async (...args) => {
    f.gate.writeSync(['memory/topics/retain.md'], () => undefined)
    return prepare(...args)
  }
  await assert.rejects(f.respond(f.call({ action: 'execute', revision: reviewed.revision })), /complete gate revision changed/)
  assert.equal(f.operation.status(), null); assert.equal(f.gate.status().operation, null)
}))

test('policy publication is gate-fenced and an older reviewed classification cannot publish after maintenance reservation', async () => withTempWorkspace(async home => {
  const f = await fixture(home), reviewed = await f.reviewed(), policy = f.protection.status()!, prepare = f.operation.prepare.bind(f.operation)
  f.operation.prepare = async (...args) => {
    const result = await prepare(...args)
    const peerGate = new MaintenanceGate(home)
    assert.throws(() => peerGate.writeSync([], () => { throw new Error('Unreachable stale classification publication') }), /fence active/)
    assert.throws(() => peerGate.writeSync([], () => undefined, reviewed.plan.gateRevision), /complete gate revision changed/)
    const peer = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import {MaintenanceGate} from './src/agent/learning/maintenance-gate.ts';
       try { new MaintenanceGate(process.argv[1]).writeSync([], () => { throw new Error('DID_PUBLISH') }); process.exitCode = 2 }
       catch (error) { if (!/fence active/.test(String(error))) { console.error(error); process.exitCode = 3 } else console.log('FENCED') }`, home], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(peer.status, 0, peer.stderr); assert.match(peer.stdout, /FENCED/)
    assert.deepEqual(f.protection.status(), policy)
    return result
  }
  assert.equal((await f.respond(f.call({ action: 'execute', revision: reviewed.revision }))).phase, 'committed')
}))

test('resume-restore prepare checks current confirmation gate version before same-operation idempotence', async () => withTempWorkspace(async home => {
  let interrupt = true
  const f = await fixture(home, stage => { if (interrupt && stage === 'restore-reserved') { interrupt = false; throw new Error('Synthetic early restore interruption') } })
  const reviewed = await f.reviewed(); await f.respond(f.call({ action: 'execute', revision: reviewed.revision }))
  const restore = await f.call({ action: 'recovery_preview', direction: 'restore' })
  await assert.rejects(f.respond(f.call({ action: 'execute', revision: restore.revision })), /early restore interruption/)
  const next = await f.call({ action: 'recovery_preview', direction: 'resume-restore' }), before = f.restoration.status()!, prepare = f.restoration.prepare.bind(f.restoration)
  f.restoration.prepare = async (...args) => {
    await new MaintenanceGate(home).operation({ id: before.plan.operationId, revision: before.revision }, () => undefined, 'restore', true)
    return prepare(...args)
  }
  await assert.rejects(f.respond(f.call({ action: 'execute', revision: next.revision })), /complete gate revision changed/)
  assert.deepEqual(f.restoration.status(), before)
}))

test('already-receipted corrupt preimages never use the source-only partial-capture fallback', async () => withTempWorkspace(async home => {
  let interrupt = true
  const f = await fixture(home, stage => { if (interrupt && stage === 'snapshot-written') { interrupt = false; throw new Error('Synthetic captured snapshot interruption') } })
  const reviewed = await f.reviewed(); await assert.rejects(f.respond(f.call({ action: 'execute', revision: reviewed.revision })), /captured snapshot interruption/)
  const receipt = f.operation.status()!, captured = Object.values(receipt.preimages)[0]!
  f.file(`state/learning/document-maintenance-v1/snapshots/${captured}.json`, 'CORRUPT SYNTHETIC SNAPSHOT')
  const before = f.gate.status(), prompts = f.records.length
  await assert.rejects(f.call({ action: 'recovery_preview', direction: 'resume' }))
  assert.deepEqual(f.operation.status(), receipt); assert.deepEqual(f.gate.status(), before); assert.equal(f.records.length, prompts)
}))


test('prepare hands off only its own cleanup CAS revision, not a competing later runner state', async () => withTempWorkspace(async home => {
  const f = await fixture(home), reviewed = await f.reviewed(), prepare = f.operation.prepare.bind(f.operation)
  f.operation.prepare = async (...args) => {
    const result = await prepare(...args)
    await new MaintenanceGate(home).operation({ id: result.plan.operationId, revision: result.revision }, () => undefined, 'commit', true)
    return result
  }
  await assert.rejects(f.respond(f.call({ action: 'execute', revision: reviewed.revision })), /complete gate revision changed/)
  assert.equal(f.operation.status()?.phase, 'prepared')
  assert.match(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), /Original seed/)
  assert.deepEqual(f.gate.status().retired, [])
  const next = await f.call({ action: 'recovery_preview', direction: 'resume' })
  assert.equal((await f.respond(f.call({ action: 'execute', revision: next.revision }))).phase, 'committed')
}))
