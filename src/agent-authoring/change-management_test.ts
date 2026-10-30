import { requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { channelSessionId } from '../bus/events.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { AgentResourceStore } from './store.ts'
import { AgentAuthoringService } from './service.ts'
import { AgentCredentialStore } from './credentials.ts'
import { CapabilityBroker } from './capabilities.ts'
import { AuthoringChanges } from './changes.ts'
import { PublicationRequests, PublicationBusyError, authoringPublicationPlugin } from './publication-requests.ts'
import { AuthoringProbeRequests, authoringProbesPlugin } from './probe-requests.ts'
import { authoringChangeTool, createAuthoringHandler, type ChangeManagementOptions } from './change-management.ts'
import type { ResourceBundle } from './contracts.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'

const identity = { botInstanceId: 'bot', platform: 'qq' as const, conversationId: 'group:room' }
const sourcePath = 'skills/issues/issues.js'
const promptPath = 'agents/support/AGENT.md'
const bundle: ResourceBundle = {
  version: 1,
  files: {
    [promptPath]: '---\ndescription: Support\nallowedTools: [issue_list]\nallowedModules: ["@shadow/issues"]\n---\nCollect issues.',
    'skills/issues/SKILL.md': '---\nname: issues\ndescription: Issues\ntools:\n  issue_list:\n    source: issues.js\n    description: List issues\n    parameters:\n      type: object\n      properties:\n        method:\n          type: string\n      required: [method]\n      additionalProperties: false\n    imports: ["@shadow/issues"]\n---\nRead issues.',
    [sourcePath]: 'import request from "@shadow/issues"; export async function run(args) { const response = await request({method:args.method,path:"/issues"}); return {count:response.body.length}; }',
  },
  bindings: [{
    ...identity, enabled: true, agent: 'support', skills: ['issues'], readFolders: [], parameters: {},
    grants: [{ id: 'issues', kind: 'http', origin: 'https://api.example.com',
      routes: [{ method: 'GET', path: '/issues' }, { method: 'POST', path: '/issues' }],
      credential: { secretRef: 'issue-token', header: 'Authorization', prefix: 'Bearer ' } }],
  }],
}

async function fixture(workspace: string, publish = true) {
  const directory = join(workspace, 'authoring')
  const resources = new AgentResourceStore({ projectId: 'p', directory })
  if (publish) {
    const staged = await resources.stage({ expectedRevision: resources.draft().revision, bundle })
    await resources.publish(staged.revision)
  }
  const changes = new AuthoringChanges({ projectId: 'p', directory, resources })
  const credentials = new AgentCredentialStore(directory)
  credentials.put('issue-token', 'SYNTHETIC-PRIVATE-TOKEN')
  const calls: string[] = []
  const notified: string[] = []
  let hook: (() => void) | undefined
  let retirementError: Error | undefined
  const broker = new CapabilityBroker({
    projectId: 'p', directory, resolveSecret: async ref => credentials.resolve(ref),
    deliver: async () => { throw new Error('No inbox delivery allowed in tests.') }, canDeliver: () => false,
    request: async (url, init) => {
      calls.push(`${init?.method} ${url}`)
      hook?.()
      return Response.json([{ number: 42 }])
    },
  })
  const service = new AgentAuthoringService({
    projectId: 'p', workspace, store: resources, broker,
    folders: { get: () => undefined, acquireAccess: () => () => {}, requireAvailable: async () => { throw new Error('No folder access') } },
  })
  const canAuthor = (id: string) => ['web:owner', 'web:worker', 'web:outsider'].includes(id)
  const validateLive = async () => {}
  const publications = new PublicationRequests({
    service, retire: async () => { if (retirementError) throw retirementError }, validateLive,
    validateRequest: request => {
      if (!request.change) return
      const change = changes.get(request.change.id)
      changes.authorize(change.id, request.change.sourceSessionId)
      if (change.closed || change.snapshot.revision !== request.revision ||
        change.accessRevision !== request.change.accessRevision ||
        change.base.revision !== request.baseRevision) throw new Error('Change review is stale.')
    },
  })
  let probeChanges = 0
  const probeOptions = {
    changed: () => { probeChanges++ },
    projectId: 'p', directory, changes, service, credentials, canAuthor,
    notify: async (request: { id: string }) => { notified.push(request.id) },
  }
  const probes = new AuthoringProbeRequests(probeOptions)
  const options: ChangeManagementOptions = {
    changes, service, credentials, publications, probes, canAuthor, inventory: () => ({ fixture: true }), validateLive,
    evaluateScenario: async () => { throw new Error('Tests must not invoke a real model.') },
    inference: async () => ({ defaults: { model: 'fixture', temperature: 0, contextWindow: 1000 },
      models: [{ id: 'fixture' }, { id: 'astra', reasoningEfforts: ['low', 'high'] }] }),
  }
  const tool = authoringChangeTool(options)
  const context: ExecutionContext = {
    projectId: 'p', sessionId: 'web:owner', physicalSessionId: 'owner-0',
    channel: 'web', chatId: 'owner', senderId: 'owner', inputSource: 'user', admin: true,
    messageId: 'input', signal: new AbortController().signal, tools: new SessionTools(new Tools(workspace), workspace),
  }
  const worker = { ...context, sessionId: 'web:worker', inputSource: 'session' as const, admin: false }
  const invoke = async (args: Record<string, unknown>, actor = context) => JSON.parse(await tool.execute(args, actor))
  const app = new Hono()
  const authorize = (request: Request) => request.headers.get('authorization') === 'owner-fixture'
  authoringProbesPlugin(probes, authorize)(app)
  authoringPublicationPlugin(publications, authorize)(app)
  return {
    probeChanges: () => probeChanges,
    directory, resources, changes, credentials, calls, notified, probes, publications, options, probeOptions,
    context, worker, invoke, app, setHook: (next: () => void) => { hook = next },
    setRetirementError: (error?: Error) => { retirementError = error },
    stop: () => { probes.stop(); publications.stop() },
  }
}

test('inference discovery, scoped edits and authoritative publication status need no chat receipts', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      f.options.inventory = () => ({
        bots: [{ id: 'bot', platform: 'qq', displayName: 'Support' }],
        conversations: [
          { sessionId: 'covered', address: { ...identity, projectId: 'p' }, inferenceOverrides: { model: 'session-model' } },
          { sessionId: 'uncovered', address: { ...identity, projectId: 'p', conversationId: 'group:unbound' } },
        ],
      })
      const inspect = await f.invoke({ action: 'inspect', input: { botInstanceId: 'bot' } })
      assert.equal(f.changes.list().length, 0)
      assert.deepEqual(inspect.uncoveredConversations.map((item: { sessionId: string }) => item.sessionId), ['uncovered'])
      assert.equal(inspect.conversations[0].effective.model, 'session-model')
      assert.equal(inspect.models[1].reasoningEfforts[0], 'low')
      await assert.rejects(f.invoke({ action: 'inspect' }, f.worker), /direct Project owner/)
      const change = await f.invoke({ action: 'create', input: { title: 'Model only', editors: [{ sessionId: 'web:worker', paths: [promptPath] }] } })
      const updated = await f.invoke({ action: 'configure_inference', changeId: change.id, expectedRevision: change.revision,
        input: { agent: 'support', settings: { model: 'astra', reasoningEffort: 'low' } } }, f.worker)
      assert.equal(updated.affectedBindings.length, 1)
      const actual = f.changes.get(change.id).snapshot.bundle
      assert.deepEqual(actual.bindings, f.resources.snapshot().bundle.bindings)
      const before = parseFrontmatter(bundle.files[promptPath])
      const after = parseFrontmatter(actual.files[promptPath])
      assert.equal(after.body, before.body)
      assert.deepEqual(after.frontmatter, { ...before.frontmatter, model: 'astra', reasoningEffort: 'low' })
      assert.equal((await f.invoke({ action: 'status', changeId: change.id }, f.worker)).status, 'not_published')
      await assert.rejects(f.invoke({ action: 'configure_inference', changeId: change.id, expectedRevision: change.revision,
        input: { agent: 'support', settings: { model: 'stale' } } }), /expectedRevision/)
      await assert.rejects(f.invoke({ action: 'configure_inference', changeId: change.id, expectedRevision: updated.revision,
        input: { agent: 'support', settings: { reasoningEffort: 'invalid' } } }), /Invalid enum/)
      await assert.rejects(f.invoke({ action: 'configure_inference', changeId: change.id, expectedRevision: updated.revision,
        input: { agent: 'unbound', settings: { model: 'astra' } } }), /enabled binding/)
      await assert.rejects(f.invoke({ action: 'propose', changeId: change.id, expectedRevision: updated.revision }, f.worker), /direct Project owner/)
      await f.invoke({ action: 'propose', changeId: change.id, expectedRevision: updated.revision })
      let status = await f.invoke({ action: 'status', changeId: change.id }, f.worker)
      assert.equal(status.active, false)
      assert.equal(status.status, 'awaiting_owner_review')
      const request = f.publications.pending()!
      assert.deepEqual(request.impact, { affectedBindings: [JSON.stringify(['bot', 'qq', 'group:room'])],
        permissionsChanged: false, promptsChanged: false, toolsChanged: false })
      await f.publications.submit(request.id, { revision: request.revision, baseRevision: request.baseRevision })
      status = await f.invoke({ action: 'status', changeId: change.id }, f.worker)
      assert.equal(status.active, true)
      assert.equal(status.status, 'published')
      assert.equal(status.request, null)
      const reset = await f.invoke({ action: 'create', input: { title: 'Remove inference overrides' } })
      const removed = await f.invoke({ action: 'configure_inference', changeId: reset.id, expectedRevision: reset.revision,
        input: { agent: 'support', settings: { model: null, reasoningEffort: null } } })
      assert.deepEqual(removed.settings, {})
      assert.equal((await f.invoke({ action: 'status', changeId: reset.id })).active, false)
    } finally { f.stop() }
  })
})

test('status distinguishes waiting, failure and cancellation from successful publication', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: { title: 'Waiting model change' } })
      const next = await f.invoke({ action: 'configure_inference', changeId: change.id, expectedRevision: change.revision,
        input: { agent: 'support', settings: { model: 'astra' } } })
      const proposal = await f.invoke({ action: 'propose', changeId: change.id, expectedRevision: next.revision })
      const decision = { revision: next.revision, baseRevision: change.baseRevision }
      f.setRetirementError(new Error('private internal failure'))
      await assert.rejects(f.publications.submit(proposal.requestId, decision), /private internal failure/)
      let status = await f.invoke({ action: 'status', changeId: change.id })
      assert.equal(status.status, 'error')
      assert.equal(status.active, false)
      assert.doesNotMatch(JSON.stringify(status), /private internal failure/)
      f.setRetirementError(new PublicationBusyError('busy'))
      assert.equal((await f.publications.submit(proposal.requestId, decision)).status, 'waiting')
      status = await f.invoke({ action: 'status', changeId: change.id })
      assert.equal(status.status, 'waiting')
      assert.equal(status.active, false)
      f.publications.cancel(proposal.requestId, decision)
      status = await f.invoke({ action: 'status', changeId: change.id })
      assert.equal(status.status, 'not_published')
      assert.equal(status.active, false)
    } finally { f.stop() }
  })
})

test('scenario checks return concise assertions while retaining full saved transcripts', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      f.options.evaluateScenario = async () => ({
        status: 'completed', sessionId: 'scenario', modelRounds: 1, llmExecuted: true, syntheticTools: true,
        messages: [{ role: 'user', content: 'LONG-SAVED-TRANSCRIPT'.repeat(1000) }, { role: 'assistant', content: 'Expected answer' }],
      })
      const change = await f.invoke({ action: 'create', input: { title: 'Check summary' } })
      const run = await f.invoke({ action: 'check', changeId: change.id, expectedRevision: change.revision,
        input: { kind: 'scenario', scenario: { input: 'Question', toolResults: {}, responseIncludes: ['Expected'] } } })
      assert.equal(run.status, 'passed')
      assert.equal(run.summary.response, 'Expected answer')
      assert.equal(run.summary.checks[0].passed, true)
      assert.doesNotMatch(JSON.stringify(run), /LONG-SAVED-TRANSCRIPT/)
      const evidence = await f.invoke({ action: 'run', changeId: change.id, input: { runId: run.id } })
      assert.match(evidence.content, /LONG-SAVED-TRANSCRIPT/)
    } finally { f.stop() }
  })
})

test('a delegated author edits and checks one Change then requests exact publication without carrying a dirty draft', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const draft = structuredClone(bundle)
      draft.files[promptPath] += '\nUnrelated draft change.'
      await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle: draft })
      const draftRevision = f.resources.draft().revision
      const change = await f.invoke({ action: 'create', input: {
        title: 'Friendlier intake', editors: [{ sessionId: 'web:worker', paths: [promptPath] }],
      } })
      assert.equal(change.revision, f.resources.snapshot().revision)
      assert.notEqual(change.revision, draftRevision)
      const read = await f.invoke({ action: 'read', changeId: change.id, input: { path: promptPath } }, f.worker)
      assert.equal(read.content, bundle.files[promptPath])
      const edit = await f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision,
        input: { files: { [promptPath]: `${read.content}\nAccept clear reports with optional details.` } } }, f.worker)
      await assert.rejects(f.invoke({ action: 'edit', changeId: change.id, expectedRevision: edit.revision,
        input: { files: { [sourcePath]: 'export async function run() { return 1 }' } } }, f.worker), /scope|author|path|delegat/i)
      const preview = await f.invoke({ action: 'check', changeId: change.id, expectedRevision: edit.revision,
        input: { kind: 'preview' } }, f.worker)
      assert.equal(preview.status, 'completed')
      assert.equal(preview.current, true)
      const full = await f.invoke({ action: 'run', changeId: change.id, input: { runId: preview.id } }, f.worker)
      assert.match(full.content, /Accept clear reports/)
      const checked = await f.invoke({ action: 'check', changeId: change.id, expectedRevision: edit.revision, input: { kind: 'validate' } }, f.worker)
      assert.equal(checked.status, 'passed')
      const proposed = await f.invoke({ action: 'propose', changeId: change.id, expectedRevision: edit.revision }, { ...f.worker, inputSource: 'user', admin: true })
      assert.equal(proposed.status, 'awaiting_owner_review')
      assert.equal(f.resources.draft().revision, draftRevision)
      const request = f.publications.pending()!
      assert.equal(request.change?.id, change.id)
      assert.deepEqual(request.files.map(file => file.path), [promptPath])
      assert.equal(request.checks?.length, 2)
      await f.publications.submit(request.id, { revision: request.revision, baseRevision: request.baseRevision })
      assert.equal(f.resources.snapshot().revision, edit.revision)
      assert.equal(f.resources.draft().revision, draftRevision)
      assert.equal(f.calls.length, 0)
      const reopened = new AuthoringChanges({ projectId: 'p', directory: f.directory, resources: f.resources })
      assert.equal(reopened.run(change.id, preview.id).revision, edit.revision)
    } finally { f.stop() }
  })
})

test('unaffected live tool contexts survive unrelated publication while changed policies are rejected', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const service = f.options.service
      const id = channelSessionId({ projectId: 'p', ...identity })
      const policy = service.resolve(id)!
      const tools = service.tools(policy, id)
      const context = { ...f.context, sessionId: id, tools }
      const unrelated = structuredClone(bundle)
      unrelated.files['agents/unrelated/AGENT.md'] = '---\nallowedTools: []\n---\nUnrelated role.'
      const next = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle: unrelated })
      await f.resources.publish(next.revision)
      assert.notEqual(f.resources.snapshot().revision, policy.revision)
      assert.equal(JSON.parse(requireToolText(await tools.execute('issue_list', { method: 'GET' }, context))).count, 1)
      unrelated.files[promptPath] += '\nChanged selected policy.'
      const affected = await f.resources.stage({ expectedRevision: next.revision, bundle: unrelated })
      await f.resources.publish(affected.revision)
      assert.match(requireToolText(await tools.execute('issue_list', { method: 'GET' }, context)), /policy changed/)
      assert.equal(f.calls.length, 1)
    } finally { f.stop() }
  })
})

test('authoring scopes reject forwarded owner claims, other projects, stale writes and revoked editors', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      await assert.rejects(f.invoke({ action: 'create', input: { title: 'Forged' } }, { ...f.worker, admin: true }), /direct Project owner/)
      const change = await f.invoke({ action: 'create', input: { title: 'Scoped' } })
      await assert.rejects(f.invoke({ action: 'read', changeId: change.id }, f.worker), /registered change editor/)
      await f.invoke({ action: 'delegate', changeId: change.id, input: { sessionId: f.worker.sessionId, paths: ['skills/issues/'] } })
      await assert.rejects(f.invoke({ action: 'delegate', changeId: change.id, input: { sessionId: 'web:outsider', paths: ['agents/'] } }, f.worker), /direct Project owner/)
      await assert.rejects(f.invoke({ action: 'read', changeId: change.id }, { ...f.worker, projectId: 'other' }), /Project/)
      const edited = await f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision,
        input: { files: { [sourcePath]: `${bundle.files[sourcePath]}\n` } } }, f.worker)
      await assert.rejects(f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision,
        input: { files: { [sourcePath]: bundle.files[sourcePath] } } }, f.worker), /exact expectedRevision/)
      await assert.rejects(f.invoke({ action: 'edit', changeId: change.id, expectedRevision: edited.revision,
        input: { bindings: bundle.bindings } }, f.worker), /owner session/)
      await f.invoke({ action: 'revoke', changeId: change.id, input: { sessionId: f.worker.sessionId } })
      await assert.rejects(f.invoke({ action: 'read', changeId: change.id }, f.worker), /registered change editor/)
    } finally { f.stop() }
  })
})

test('virtual authoring writes are revision checked and never overwrite live resources', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: { title: 'Virtual files' } })
      const handler = createAuthoringHandler(f.options)
      const path = `${change.id}/${promptPath}`
      await assert.rejects(async () => handler.write(path, { content: 'bad' }, f.context), /revision/)
      const edited = JSON.parse(await handler.write(`${path}?revision=${change.revision}`,
        { content: 'Receive reports.', match: 'Collect issues.' }, f.context))
      assert.notEqual(edited.revision, change.revision)
      assert.equal(f.resources.snapshot().revision, change.revision)
      await assert.rejects(async () => handler.write(`${path}?revision=${change.revision}`, { content: 'stale' }, f.context), /revision/i)
      await assert.rejects(async () => handler.read(`${change.id}/../secrets`, f.context), /Invalid authoring/)
      const read = JSON.parse(await handler.read(path, f.context))
      assert.match(read.content, /Receive reports/)
    } finally { f.stop() }
  })
})

test('checks save exact-version evidence and distinguish assertions, failures and smoke execution', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: { title: 'Tool tests' } })
      const check = (cases: unknown[]) => f.invoke({
        action: 'check', changeId: change.id, expectedRevision: change.revision,
        input: { kind: 'test', toolName: 'issue_list', cases },
      })
      const passing = await check([{ name: 'one issue', arguments: { method: 'GET' },
        capabilityResults: { issues: { status: 200, body: [{}] } }, assertion: { expected: { count: 1 } } }])
      assert.equal(passing.status, 'passed')
      const smoke = await check([{ name: 'smoke', arguments: { method: 'GET' }, capabilityResults: { issues: { status: 200, body: [] } } }])
      assert.equal(smoke.status, 'completed')
      const failure = await check([{ name: 'wrong count', arguments: { method: 'GET' },
        capabilityResults: { issues: { status: 200, body: [] } }, assertion: { expected: { count: 2 } } }])
      assert.equal(failure.status, 'failed')
      const missing = await check([{ name: 'missing mock', arguments: { method: 'GET' } }])
      assert.equal(missing.status, 'failed')
      assert.equal(f.calls.length, 0)
      await f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision,
        input: { files: { [promptPath]: `${bundle.files[promptPath]}\nNew.` } } })
      const history = await f.invoke({ action: 'runs', changeId: change.id })
      assert(history.runs.every((run: { current: boolean }) => !run.current))
      const partial = await f.invoke({ action: 'run', changeId: change.id, input: { runId: passing.id }, limit: 50 })
      const remainder = await f.invoke({ action: 'run', changeId: change.id, input: { runId: passing.id }, offset: 50 })
      assert.equal(JSON.parse(partial.content + remainder.content).cases[0].evaluation.passed, true)
    } finally { f.stop() }
  })
})

test('a new connection probe requires a one-use owner HTTP approval, saves evidence and wakes its author', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace, false)
    try {
      const initialPublished = f.resources.snapshot().revision
      let change = await f.invoke({ action: 'create', input: { title: 'First integration' } })
      change = await f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision,
        input: { files: bundle.files, bindings: bundle.bindings } })
      const pending = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      assert.equal(f.calls.length, 0)
      const request = f.probes.list()[0]
      assert.deepEqual(request.grants[0].routes, [{ method: 'GET', path: '/issues' }])
      assert.equal(JSON.stringify(request).includes('SYNTHETIC-PRIVATE-TOKEN'), false)
      const url = `/api/agent-resources/probe-requests/${pending.requestId}`
      const decision = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: change.revision }) }
      assert.equal((await f.app.request(url, decision)).status, 401)
      assert.equal(f.calls.length, 0)
      const result = await f.app.request(url, { ...decision, headers: { ...decision.headers, authorization: 'owner-fixture' } })
      assert.equal(result.status, 200)
      const receipt = await result.json()
      assert.equal(receipt.result.status, 'completed')
      assert.deepEqual(f.calls, ['GET https://api.example.com/issues'])
      assert.equal(f.changes.run(change.id, receipt.result.runId).kind, 'probe')
      assert.deepEqual(f.notified, [pending.requestId])
      assert.equal(f.resources.snapshot().revision, initialPublished)
      assert.equal(f.resources.draft().revision, initialPublished)
      assert.equal((await f.app.request(url, { ...decision, headers: { ...decision.headers, authorization: 'owner-fixture' } })).status, 409)
      assert.equal(f.calls.length, 1)
    } finally { f.stop() }
  })
})

test('probe reviews survive restart, expire, and reject changed source without executing any transport', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: { title: 'Controlled probe' } })
      const pending = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      f.probes.stop()
      const restored = new AuthoringProbeRequests({ ...f.probeOptions, now: () => Date.now() + 11 * 60_000 })
      assert.equal(restored.list()[0].id, pending.requestId)
      await assert.rejects(restored.submit(pending.requestId, { revision: change.revision }), /expired/)
      restored.stop()
      const again = new AuthoringProbeRequests(f.probeOptions)
      const changed = f.changes.edit(change.id, { expectedRevision: change.revision,
        files: { [sourcePath]: `${bundle.files[sourcePath]}\n` } })
      assert.notEqual(changed.snapshot.revision, change.revision)
      await assert.rejects(again.submit(pending.requestId, { revision: change.revision }), /edited|source|changed/i)
      assert.equal(f.calls.length, 0)
      again.stop()
    } finally { f.stop() }
  })
})

test('probe approval cannot survive revoke and regrant across service restart', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: {
        title: 'Scoped probe', editors: [{ sessionId: 'web:worker', paths: [promptPath] }],
      } })
      const pending = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { address: identity, toolName: 'issue_list', arguments: { method: 'GET' } } }, f.worker)
      f.changes.revoke(change.id, 'web:worker')
      f.changes.delegate(change.id, { sessionId: 'web:worker', paths: [promptPath] })
      await f.probes.stop()
      const restored = new AuthoringProbeRequests(f.probeOptions)
      try {
        await assert.rejects(restored.submit(pending.requestId, { revision: change.revision }), /scope changed/)
        assert.equal(f.calls.length, 0)
        const fresh = restored.request({ changeId: change.id, revision: change.revision, sourceSessionId: 'web:worker',
          address: { projectId: 'p', ...identity }, toolName: 'issue_list', args: { method: 'GET' } })
        assert.notEqual(fresh.id, pending.requestId)
        assert.equal((await restored.submit(fresh.id, { revision: change.revision })).status, 'completed')
        assert.equal(f.calls.length, 1)
      } finally { await restored.stop() }
    } finally { f.stop() }
  })
})

test('approved probes still deny writes and stop on source change during an in-flight GET', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: { title: 'No side effects' } })
      const write = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'POST' } } })
      const denied = await f.probes.submit(write.requestId, { revision: change.revision })
      assert.equal(denied.status, 'failed')
      assert.equal(f.calls.length, 0)
      const pending = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      f.setHook(() => {
        f.changes.edit(change.id, { expectedRevision: change.revision, files: { [promptPath]: `${bundle.files[promptPath]}\nChanged during run.` } })
      })
      const failed = await f.probes.submit(pending.requestId, { revision: change.revision })
      assert.equal(failed.status, 'failed')
      assert.equal(f.calls.length, 1)
      assert.equal(f.changes.run(change.id, failed.runId!).status, 'failed')
    } finally { f.stop() }
  })
})

test('probe approval limits calls even when guest catches the denial, and cancellation notifies without transport', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      let change = await f.invoke({ action: 'create', input: { title: 'Bounded probe' } })
      change = await f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision, input: {
        files: { [sourcePath]: 'import request from "@shadow/issues"; export async function run() { for (let i=0;i<9;i++) { try { await request({method:"GET",path:"/issues"}) } catch {} } return {ok:true}; }' },
      } })
      const pending = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      const result = await f.probes.submit(pending.requestId, { revision: change.revision })
      assert.equal(result.status, 'failed')
      assert.equal(f.calls.length, 8)
      assert.match(JSON.stringify(f.changes.run(change.id, result.runId!).result), /call_budget_exceeded/)
      const cancelled = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      assert.equal((await f.probes.cancel(cancelled.requestId, { revision: change.revision })).status, 'cancelled')
      assert.equal(f.calls.length, 8)
      assert.deepEqual(f.notified, [pending.requestId, cancelled.requestId])
      await assert.rejects(f.probes.submit(cancelled.requestId, { revision: change.revision }), /no longer pending/)
    } finally { f.stop() }
  })
})

test('saved check evidence redacts known credentials and old reviews cannot survive delegation revocation', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      let change = await f.invoke({ action: 'create', input: { title: 'Safe evidence',
        editors: [{ sessionId: f.worker.sessionId, paths: ['skills/issues/'] }],
      } })
      change = await f.invoke({ action: 'edit', changeId: change.id, expectedRevision: change.revision,
        input: { files: { [sourcePath]: 'export async function run(args) { return args; }' } } })
      const run = await f.invoke({ action: 'check', changeId: change.id, expectedRevision: change.revision, input: {
        kind: 'test', toolName: 'issue_list',
        cases: [{ name: 'echo fixture', arguments: { method: 'SYNTHETIC-PRIVATE-TOKEN' } }],
      } })
      assert.equal(run.status, 'completed')
      assert.equal(JSON.stringify(f.changes.run(change.id, run.id)).includes('SYNTHETIC-PRIVATE-TOKEN'), false)
      await assert.rejects(f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'SYNTHETIC-PRIVATE-TOKEN' } } }), /stored credentials/)
      const pending = await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } }, f.worker)
      await f.invoke({ action: 'revoke', changeId: change.id, input: { sessionId: f.worker.sessionId } })
      await f.invoke({ action: 'delegate', changeId: change.id, input: { sessionId: f.worker.sessionId, paths: ['skills/issues/'] } })
      await assert.rejects(f.probes.submit(pending.requestId, { revision: change.revision }), /no longer pending/)
      assert.equal(f.calls.length, 0)
      await f.invoke({ action: 'close', changeId: change.id, expectedRevision: change.revision })
      const history = await f.invoke({ action: 'run', changeId: change.id, input: { runId: run.id } })
      assert.equal(history.id, run.id)
      await assert.rejects(f.invoke({ action: 'check', changeId: change.id, expectedRevision: change.revision,
        input: { kind: 'validate' } }), /closed/)
    } finally { f.stop() }
  })
})


test('creator configures reusable capabilities once in an unbound Agent Change; only exact owner review publishes the profile', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace, false)
    try {
      const created = await f.invoke({ action: 'create', input: { title: 'Prepare reusable support Agent' } })
      const id = created.id
      const edited = await f.invoke({ action: 'edit', changeId: id, expectedRevision: created.revision, input: { files: bundle.files } })
      // Tool accepts only the profile contract, never conversation identity or an implicit old binding.
      const { conversationId: _conversation, agent: _agent, enabled: _enabled, ...profile } = bundle.bindings[0]
      const configured = await f.invoke({ action: 'configure_capabilities', changeId: id, expectedRevision: edited.revision, input: { agent: 'support', profiles: [profile] } })
      assert.equal(f.resources.snapshot().bundle.files[promptPath], undefined)
      assert.deepEqual(f.changes.get(id).snapshot.bundle.bindings, [])
      assert.deepEqual(parseFrontmatter(f.changes.get(id).snapshot.bundle.files[promptPath]).frontmatter.capabilityProfiles, [profile])
      const checked = await f.invoke({ action: 'check', changeId: id, expectedRevision: configured.revision, input: { kind: 'validate' } })
      assert.equal(checked.status, 'passed')
      const proposed = await f.invoke({ action: 'propose', changeId: id, expectedRevision: configured.revision, input: {} })
      const request = f.publications.list().find(request => request.id === proposed.requestId)!
      assert.ok(request)
      assert.equal(f.resources.snapshot().bundle.files[promptPath], undefined)
      await f.publications.submit(request.id, { revision: request.revision, baseRevision: request.baseRevision })
      assert.equal(f.resources.snapshot().revision, request.revision)
      assert.deepEqual(f.resources.snapshot().bundle.bindings, [])
    } finally { f.probes.stop(); f.publications.stop() }
  })
})

test('probe create, expiry and invalidation notify once and reads are inert', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const change = await f.invoke({ action: 'create', input: { title: 'Probe notifications' } })
      await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      assert.equal(f.probeChanges(), 1)
      f.probes.list(); f.probes.list(); f.probes.invalidateChange('absent')
      assert.equal(f.probeChanges(), 1)
      f.probes.invalidateChange(change.id)
      assert.equal(f.probeChanges(), 2)
      f.probes.invalidateChange(change.id)
      assert.equal(f.probeChanges(), 2)
      await f.invoke({ action: 'request_probe', changeId: change.id, expectedRevision: change.revision,
        input: { toolName: 'issue_list', arguments: { method: 'GET' } } })
      assert.equal(f.probeChanges(), 3)
      await f.probes.stop()
      let changes = 0
      const restored = new AuthoringProbeRequests({ ...f.probeOptions,
        now: () => Date.now() + 11 * 60_000, changed: () => { changes++ } })
      try {
        t.mock.timers.tick(1000)
        assert.equal(changes, 1)
        assert.ok(restored.list().every(request => request.status === 'cancelled'))
        assert.equal((restored as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
        t.mock.timers.tick(1000)
        restored.list(); restored.invalidateChange(change.id)
        assert.equal(changes, 1)
      } finally { await restored.stop() }
    } finally { f.stop() }
  })
})
