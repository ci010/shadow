import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { AgentResourceStore } from './store.ts'
import { AgentAuthoringService } from './service.ts'
import { CapabilityBroker } from './capabilities.ts'
import { PublicationBusyError, PublicationRequestError, PublicationRequests, authoringPublicationPlugin, publishAgentResources } from './publication-requests.ts'
import { channelSessionId } from '../bus/events.ts'
import { parsePublicationRequest, parsePublicationResult } from './publication-contract.ts'
import type { ResourceBundle, ResourceSnapshot } from './contracts.ts'

function bundle(text = 'First prompt'): ResourceBundle {
  return {
    version: 1,
    files: { 'agents/support/AGENT.md': `---\nallowedTools: []\n---\n${text}` },
    bindings: [{
      botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one', enabled: true,
      agent: 'support', skills: [], readFolders: ['docs'], parameters: { label: text },
      allowFrom: ['owner'], grants: [{ id: 'notify', kind: 'inbox', sessionId: 'web:worker' }],
    }],
  }
}

async function fixture(projectId = 'project-a') {
  const root = join(process.cwd(), '.publication-tests', randomUUID())
  await mkdir(root, { recursive: true })
  const store = new AgentResourceStore({ projectId, directory: root })
  const broker = new CapabilityBroker({
    projectId, directory: join(root, 'broker'),
    resolveSecret: async () => undefined, canDeliver: () => true,
    deliver: async () => { throw new Error('Not used') },
  })
  const service = new AgentAuthoringService({
    projectId, workspace: root, store, broker,
    folders: { get: () => undefined, requireAvailable: async () => { throw new Error('Not used') }, acquireAccess: () => () => {} },
  })
  let retired = 0
  let validate: (snapshot: ResourceSnapshot) => Promise<void> = async () => {}
  let retirement: () => Promise<void> = async () => {}
  const options = {
    service,
    retire: async () => { retired++; await retirement() },
    validateLive: (snapshot: ResourceSnapshot) => validate(snapshot),
  }
  const requests = new PublicationRequests(options)
  const app = new Hono()
  authoringPublicationPlugin(requests, request => request.headers.get('Authorization') === 'Bearer owner')(app)
  return {
    store, requests, service, options, app,
    retired: () => retired,
    validate: (fn: typeof validate) => { validate = fn },
    retirement: (fn: typeof retirement) => { retirement = fn },
    stage: (value = bundle()) => store.stage({ expectedRevision: store.draft().revision, bundle: value }),
    async close() { requests.stop(); await rm(root, { recursive: true, force: true }) },
  }
}

test('proposal is nonblocking, reuses exact review and never publishes implicitly', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const base = f.store.snapshot()
    const beforeProposal = await f.app.request('/api/agent-resources/publication-requests', {
      headers: { Authorization: 'Bearer owner' },
    })
    assert.deepEqual(await beforeProposal.json(), { request: null, requests: [] })
    const request = await f.requests.propose()
    assert.deepEqual(await f.requests.propose(), request)
    assert.deepEqual(parsePublicationRequest(request, 'project-a'), request)
    assert.deepEqual(request.files, [{ path: 'agents/support/AGENT.md', before: null, after: bundle().files['agents/support/AGENT.md'] }])
    assert.deepEqual(request.previousBindings, [])
    assert.deepEqual(request.bindings, bundle().bindings)
    request.files[0].after = 'caller mutation'
    request.bindings[0].grants.length = 0
    assert.notDeepEqual(f.requests.pending(), request)
    assert.equal(f.store.snapshot().revision, base.revision)
    assert.equal(f.retired(), 0)
    const pending = f.requests.pending()!
    assert.deepEqual(parsePublicationResult(f.requests.cancel(pending.id, decision(pending))), {
      requestId: pending.id, revision: pending.revision, status: 'cancelled',
    })
  } finally { await f.close() }
})

const decision = (request: { revision: string; baseRevision: string }) => ({
  revision: request.revision, baseRevision: request.baseRevision,
})

test('decisions require both exact revisions and cancellation never publishes', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const request = await f.requests.propose()
    for (const wrong of [
      { revision: request.baseRevision, baseRevision: request.baseRevision },
      { revision: request.revision, baseRevision: request.revision },
    ]) {
      await assert.rejects(f.requests.submit(request.id, wrong), /no longer current/)
      assert.throws(() => f.requests.cancel(request.id, wrong), /no longer current/)
    }
    await assert.rejects(f.requests.submit('foreign-project-request', decision(request)), /no longer current/)
    assert.throws(() => f.requests.cancel(request.id, { revision: request.revision } as never))
    assert.equal(f.requests.cancel(request.id, decision(request)).status, 'cancelled')
    await assert.rejects(f.requests.submit(request.id, decision(request)), /no longer current/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
  } finally { await f.close() }
})

test('draft edits, published changes and ABA invalidate existing requests', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const first = await f.requests.propose()
    await f.stage(bundle('Second prompt'))
    await f.stage()
    assert.equal(f.requests.pending(), null)
    await assert.rejects(f.requests.submit(first.id, decision(first)), /no longer current/)
    const second = await f.requests.propose()
    await publishAgentResources(f.options, second.revision, second.baseRevision)
    assert.equal(f.requests.pending(), null)
    await assert.rejects(f.requests.submit(second.id, decision(second)), /no longer current/)
    const third = await f.requests.propose()
    await publishAgentResources(f.options, third.revision, third.baseRevision)
    assert.equal(f.requests.pending(), null)
  } finally { await f.close() }
})

test('review includes exact changed source, deletions and all before/after bindings', async () => {
  const f = await fixture()
  try {
    const old = bundle()
    old.files['agents/removed/AGENT.md'] = '---\nallowedTools: []\n---\nOld'
    await f.stage(old)
    await f.store.publish(f.store.draft().revision)
    const next = bundle('Updated prompt')
    await f.stage(next)
    const request = await f.requests.propose()
    assert.deepEqual(request.previousBindings, old.bindings)
    assert.deepEqual(request.bindings, next.bindings)
    assert.deepEqual(request.files, [
      { path: 'agents/removed/AGENT.md', before: old.files['agents/removed/AGENT.md'], after: null },
      { path: 'agents/support/AGENT.md', before: old.files['agents/support/AGENT.md'], after: next.files['agents/support/AGENT.md'] },
    ])
  } finally { await f.close() }
})

test('double submit is rejected; concurrent writes cannot change the approved publication', async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  try {
    await f.stage()
    const request = await f.requests.propose()
    const entered = Promise.withResolvers<void>()
    f.validate(async snapshot => { assert.equal(snapshot.revision, request.revision); entered.resolve(); await gate.promise })
    const submit = f.requests.submit(request.id, decision(request))
    await entered.promise
    await assert.rejects(f.requests.submit(request.id, decision(request)), /in progress/)
    assert.throws(() => f.requests.cancel(request.id, decision(request)), /in progress/)
    const write = f.stage(bundle('Concurrent edit'))
    gate.resolve()
    assert.equal((await submit).status, 'published')
    await write
    assert.equal(f.store.snapshot().revision, request.revision)
    assert.notEqual(f.store.draft().revision, request.revision)
    assert.equal(f.retired(), 1)
    await assert.rejects(f.requests.submit(request.id, decision(request)), /no longer current/)
  } finally { gate.resolve(); await f.close() }
})

test('edit during retirement or proposal validation rejects stale review', async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  try {
    await f.stage()
    const request = await f.requests.propose()
    f.retirement(() => gate.promise)
    const submit = f.requests.submit(request.id, decision(request))
    await f.stage(bundle('Edited before publish'))
    gate.resolve()
    await assert.rejects(submit, /no longer current/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    const validating = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    f.validate(async () => { entered.resolve(); await validating.promise })
    const proposal = f.requests.propose()
    await entered.promise
    await f.stage()
    validating.resolve()
    await assert.rejects(proposal, /no longer current/)
  } finally { gate.resolve(); await f.close() }
})

test('live validation and retirement failures retain an explicit retryable review error without publishing', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const request = await f.requests.propose()
    f.validate(async () => { throw new Error('Folder revoked') })
    await assert.rejects(f.requests.submit(request.id, decision(request)), /Folder revoked/)
    const { status, error, ...pending } = f.requests.pending()!
    assert.deepEqual(pending, request)
    assert.equal(status, 'error')
    assert.equal(error?.code, 'publication_failed')
    assert.doesNotMatch(error?.message ?? '', /Folder revoked/)
    f.validate(async () => {})
    f.retirement(async () => { throw new Error('Channel work is active') })
    await assert.rejects(f.requests.submit(request.id, decision(request)), /Channel work is active/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    f.retirement(async () => {})
    assert.equal((await f.requests.submit(request.id, decision(request))).status, 'published')
  } finally { await f.close() }
})

test('shutdown clears review and prevents in-flight publication', async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  try {
    await f.stage()
    const request = await f.requests.propose()
    const entered = Promise.withResolvers<void>()
    f.validate(async () => { entered.resolve(); await gate.promise })
    const submit = f.requests.submit(request.id, decision(request))
    await entered.promise
    f.requests.stop()
    f.requests.stop()
    gate.resolve()
    await assert.rejects(submit, /stopped/)
    assert.equal(f.requests.pending(), null)
    await assert.rejects(f.requests.propose(), /stopped/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
  } finally { gate.resolve(); await f.close() }
})

test('HTTP requires owner authorization and strict decisions; no automatic retry on failures', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const request = await f.requests.propose()
    const path = '/api/agent-resources/publication-requests'
    for (const token of [undefined, 'Bearer stranger']) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await f.app.request(method === 'GET' ? path : `${path}/${request.id}`, {
          method, headers: token ? { Authorization: token } : {},
        })
        assert.equal(response.status, 401)
        assert.equal(response.headers.get('Cache-Control'), 'no-store')
      }
    }
    const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
    const get = await f.app.request(path, { headers })
    assert.deepEqual(await get.json(), { request, requests: [request] })
    for (const body of ['{}', '{', JSON.stringify({ ...decision(request), approval: true }), JSON.stringify({ revision: request.revision })]) {
      const response = await f.app.request(`${path}/${request.id}`, { method: 'POST', headers, body })
      assert.equal(response.status, 400)
    }
    const foreign = await f.app.request(`${path}/foreign-project-request`, { method: 'POST', headers, body: JSON.stringify(decision(request)) })
    assert.equal(foreign.status, 409)
    f.validate(async () => { throw new Error('Private internal detail') })
    const failed = await f.app.request(`${path}/${request.id}`, { method: 'POST', headers, body: JSON.stringify(decision(request)) })
    assert.equal(failed.status, 500)
    assert.equal((await failed.text()).includes('Private internal detail'), false)
    const { status, error, ...pending } = f.requests.pending()!
    assert.deepEqual(pending, request)
    assert.equal(status, 'error')
    assert.equal(error?.code, 'publication_failed')
    assert.doesNotMatch(error?.message ?? '', /Private internal detail/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    f.validate(async () => {})
    const published = await f.app.request(`${path}/${request.id}`, { method: 'POST', headers, body: JSON.stringify(decision(request)) })
    assert.equal(published.status, 200)
    assert.deepEqual(await published.json(), { result: { requestId: request.id, revision: request.revision, status: 'published' } })
    assert.equal((await f.app.request(`${path}/${request.id}`, { method: 'POST', headers, body: JSON.stringify(decision(request)) })).status, 409)
  } finally { await f.close() }
})

test('browser contract rejects foreign project, malformed hashes/date/paths and unexpected fields', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const request = await f.requests.propose()
    assert.throws(() => parsePublicationRequest(request, 'foreign'))
    for (const changed of [
      { projectId: 'foreign' }, { revision: 'sha256:bad' }, { baseRevision: '' },
      { sessionId: 'web:worker' }, { createdAt: '2026-02-30T00:00:00.000Z' },
      { secret: 'unexpected' }, { files: [{ path: '../secret', before: null, after: 'x' }] },
      { files: [request.files[0], request.files[0]] },
      { files: [{ ...request.files[0], after: null }] },
      { bindings: [{ botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one', agent: 'support' }] },
    ]) assert.throws(() => parsePublicationRequest({ ...request, ...changed }, 'project-a'))
    assert.throws(() => parsePublicationResult({ requestId: request.id, revision: request.revision, status: 'approved' }))
  } finally { await f.close() }
})

test('identical revisions in different Projects do not share approval authority', async () => {
  const a = await fixture()
  const b = await fixture('project-b')
  try {
    await a.stage()
    await b.stage()
    const first = await a.requests.propose()
    const second = await b.requests.propose()
    assert.equal(first.revision, second.revision)
    const response = await b.app.request(`/api/agent-resources/publication-requests/${first.id}`, {
      method: 'POST', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(decision(first)),
    })
    assert.equal(response.status, 409)
    assert.deepEqual(b.requests.pending(), second)
    assert.equal(b.store.snapshot().revision, second.baseRevision)
    const cancelled = await b.app.request(`/api/agent-resources/publication-requests/${second.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(decision(second)),
    })
    assert.equal(cancelled.status, 200)
    assert.deepEqual(await cancelled.json(), { result: { requestId: second.id, revision: second.revision, status: 'cancelled' } })
    assert.deepEqual(a.requests.pending(), first)
  } finally { await a.close(); await b.close() }
})

function proposal(store: AgentResourceStore, id = 'change-one', text = 'Candidate') {
  const snapshot = store.candidate(bundle(text))
  return {
    snapshot, change: { id, title: `Review ${id}`, sourceSessionId: 'web:topic-one' },
    checks: [{ id: 'validation', kind: 'validation', status: 'passed' as const, revision: snapshot.revision }],
  }
}

test('independent candidates survive restart, preserve the dirty draft, and persist cancellation', async () => {
  const f = await fixture()
  let restarted: PublicationRequests | undefined
  try {
    const dirty = await f.stage(bundle('Unfinished global draft'))
    const candidate = proposal(f.store)
    const request = await f.requests.propose(candidate)
    f.requests.stop()
    const reopenedStore = new AgentResourceStore({ projectId: 'project-a', directory: f.store.storageDirectory })
    assert.equal(reopenedStore.snapshot().revision, request.baseRevision)
    const options = { ...f.options, service: new AgentAuthoringService({ ...f.service.options, store: reopenedStore }) }
    restarted = new PublicationRequests(options)
    assert.deepEqual(restarted.list(), [request])
    assert.deepEqual(await restarted.retryWaiting(), [])
    assert.equal(f.retired(), 0)
    assert.equal((await restarted.submit(request.id, decision(request))).status, 'published')
    assert.deepEqual(reopenedStore.snapshot(), candidate.snapshot)
    assert.deepEqual(reopenedStore.draft(), dirty)
    const cancelled = await restarted.propose(proposal(reopenedStore, 'cancelled', 'Do not publish'))
    restarted.cancel(cancelled.id, decision(cancelled))
    restarted.stop()
    restarted = new PublicationRequests(options)
    assert.deepEqual(restarted.list(), [])
  } finally { restarted?.stop(); await f.close() }
})

test('different changes coexist, same version reuses review, edits replace only that change', async () => {
  const f = await fixture()
  try {
    await f.stage()
    const legacy = await f.requests.propose()
    const one = proposal(f.store)
    const first = await f.requests.propose(one)
    const second = await f.requests.propose(proposal(f.store, 'change-two', 'Second candidate'))
    assert.deepEqual(await f.requests.propose(one), first)
    const replacement = await f.requests.propose(proposal(f.store, 'change-one', 'Edited candidate'))
    assert.deepEqual(f.requests.list().map(item => item.id), [legacy.id, second.id, replacement.id])
    await f.stage(bundle('Draft only edited'))
    assert.deepEqual(f.requests.list().map(item => item.id), [second.id, replacement.id])
    await assert.rejects(f.requests.submit(first.id, decision(first)), /no longer current/)
    f.requests.invalidateChange('change-two')
    assert.deepEqual(f.requests.list(), [replacement])
    await f.requests.submit(replacement.id, decision(replacement))
    assert.deepEqual(f.requests.list(), [])
    await assert.rejects(f.requests.submit(second.id, decision(second)), /no longer current/)
  } finally { await f.close() }
})

test('candidate inputs are pinned before live validation and stale/current checks retain their revisions', async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  try {
    const input = proposal(f.store)
    const original = structuredClone(input.snapshot)
    input.checks.push({ id: 'old', kind: 'validation', status: 'passed', revision: f.store.snapshot().revision })
    const entered = Promise.withResolvers<void>()
    f.validate(async () => { entered.resolve(); await gate.promise })
    const proposed = f.requests.propose(input)
    await entered.promise
    input.snapshot = structuredClone(input.snapshot)
    input.snapshot.bundle.files['agents/support/AGENT.md'] = 'Caller mutation'
    input.change.title = 'Caller mutation'
    gate.resolve()
    const request = await proposed
    assert.equal(request.revision, original.revision)
    assert.equal(request.change?.title, 'Review change-one')
    assert.deepEqual(request.checks?.map(check => check.revision === request.revision), [true, false])
    await f.requests.submit(request.id, decision(request))
    assert.deepEqual(f.store.snapshot(), original)
  } finally { gate.resolve(); await f.close() }
})

test('source validation rejects edited or revoked Changes across restart without swallowing unexpected errors', async () => {
  const f = await fixture()
  f.requests.stop()
  let sourceCurrent = true
  let unexpected = false
  const options = { ...f.options, validateRequest: () => {
    if (unexpected) throw new Error('Source store unavailable')
    if (!sourceCurrent) throw new PublicationRequestError('stale_request', 409, 'Source Change was edited or revoked.')
  } }
  let requests = new PublicationRequests(options)
  try {
    const request = await requests.propose(proposal(f.store))
    requests.stop()
    sourceCurrent = false
    requests = new PublicationRequests(options)
    assert.deepEqual(requests.list(), [])
    await assert.rejects(requests.submit(request.id, decision(request)), /no longer current/)
    sourceCurrent = true
    const next = await requests.propose(proposal(f.store))
    unexpected = true
    assert.throws(() => requests.list(), /Source store unavailable/)
    await assert.rejects(requests.submit(next.id, decision(next)), /Source store unavailable/)
    unexpected = false
    assert.equal(requests.pending()?.id, next.id)
    f.validate(async () => { sourceCurrent = false })
    await assert.rejects(requests.submit(next.id, decision(next)), /edited or revoked/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
  } finally { requests.stop(); await f.close() }
})

test('persisted access revision prevents approval after revoke and identical regrant', async () => {
  const f = await fixture()
  f.requests.stop()
  let accessRevision = 0
  const options = { ...f.options, validateRequest: (request: ReturnType<typeof parsePublicationRequest>) => {
    if (request.change?.accessRevision !== accessRevision) {
      throw new PublicationRequestError('stale_request', 409, 'Change authorization changed.')
    }
  } }
  let requests = new PublicationRequests(options)
  try {
    const input = proposal(f.store)
    const request = await requests.propose({ ...input, change: { ...input.change, accessRevision } })
    requests.stop()
    accessRevision = 2
    requests = new PublicationRequests(options)
    assert.deepEqual(requests.list(), [])
    await assert.rejects(requests.submit(request.id, decision(request)), /no longer current/)
    const replacement = await requests.propose({ ...input, change: { ...input.change, accessRevision } })
    assert.notEqual(replacement.id, request.id)
    assert.equal(replacement.revision, request.revision)
    assert.equal(replacement.change?.accessRevision, 2)
  } finally { requests.stop(); await f.close() }
})

test('persisted candidate/source hashes and exact review content reject modification', async () => {
  const f = await fixture()
  try {
    const request = await f.requests.propose(proposal(f.store))
    f.requests.stop()
    const file = join(f.store.storageDirectory, 'publication-requests.json')
    const text = await readFile(file, 'utf8')
    const document = JSON.parse(text)
    document.value[0].snapshot.bundle.files['agents/support/AGENT.md'] += '\nModified'
    await writeFile(file, JSON.stringify(document))
    assert.throws(() => new PublicationRequests(f.options), /reviewed revision/)
    const misleading = JSON.parse(text)
    misleading.value[0].request.files[0].after += '\nMisleading review'
    await writeFile(file, JSON.stringify(misleading))
    assert.throws(() => new PublicationRequests(f.options), /review does not match/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
  } finally { await f.close() }
})

test('a stale publication store cannot resurrect cancellation or approve after external storage changes', async () => {
  const f = await fixture()
  let stale: PublicationRequests | undefined
  try {
    const request = await f.requests.propose(proposal(f.store))
    stale = new PublicationRequests(f.options)
    f.requests.cancel(request.id, decision(request))
    await assert.rejects(stale.submit(request.id, decision(request)), /changed externally/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    const reopened = new PublicationRequests(f.options)
    assert.deepEqual(reopened.list(), [])
    reopened.stop()
  } finally { stale?.stop(); await f.close() }
})

test('invalidating a Change during retirement blocks the exact pending commit', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    const request = await f.requests.propose(proposal(f.store))
    f.retirement(async () => { entered.resolve(); await release.promise })
    const submitted = f.requests.submit(request.id, decision(request))
    await entered.promise
    f.requests.invalidateChange(request.change!.id)
    release.resolve()
    await assert.rejects(submitted, /no longer current/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    assert.deepEqual(f.requests.list(), [])
  } finally { release.resolve(); await f.close() }
})

test('durable cancellation by another instance during live validation blocks commit', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let other: PublicationRequests | undefined
  try {
    const request = await f.requests.propose(proposal(f.store))
    f.validate(async () => { entered.resolve(); await release.promise })
    const submitted = f.requests.submit(request.id, decision(request))
    await entered.promise
    other = new PublicationRequests(f.options)
    other.cancel(request.id, decision(request))
    release.resolve()
    await assert.rejects(submitted, /changed externally/)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    assert.deepEqual(other.list(), [])
  } finally { release.resolve(); other?.stop(); await f.close() }
})

test('changed published base removes all candidate approvals, including on restart', async () => {
  const f = await fixture()
  let requests: PublicationRequests | undefined
  try {
    const first = await f.requests.propose(proposal(f.store))
    await f.requests.propose(proposal(f.store, 'other', 'Other'))
    f.requests.stop()
    await f.stage(bundle('Published separately'))
    await f.store.publish(f.store.draft().revision)
    requests = new PublicationRequests(f.options)
    assert.deepEqual(requests.list(), [])
    await assert.rejects(requests.submit(first.id, decision(first)), /no longer current/)
  } finally { requests?.stop(); await f.close() }
})

test('impact and retirement select only changed bound resources, not every project conversation', async () => {
  const f = await fixture()
  f.requests.stop()
  const contexts = ['one', 'two', 'unbound'].map(group => channelSessionId({
    projectId: 'project-a', botInstanceId: 'bot', platform: 'qq', conversationId: `group:${group}`,
  }))
  let retired: string[] = []
  const options = { ...f.options, retire: async (matches: (id: string) => boolean) => { retired = contexts.filter(matches) } }
  const requests = new PublicationRequests(options)
  try {
    const base = bundle()
    base.files['agents/other/AGENT.md'] = '---\nallowedTools: []\n---\nOther'
    base.bindings.push({ ...structuredClone(base.bindings[0]), conversationId: 'group:two', agent: 'other' })
    await f.stage(base)
    await f.store.publish(f.store.draft().revision)
    const next = structuredClone(base)
    next.files['agents/support/AGENT.md'] += '\nPrompt only'
    const input = { ...proposal(f.store), snapshot: f.store.candidate(next), checks: [] }
    const request = await requests.propose(input)
    assert.deepEqual(request.impact, {
      affectedBindings: ['["bot","qq","group:one"]'], permissionsChanged: false, toolsChanged: false, promptsChanged: true,
    })
    await requests.submit(request.id, decision(request))
    assert.deepEqual(retired, [contexts[0]])
    next.files['agents/other/AGENT.md'] += '\nLegacy prompt update'
    const legacy = await f.stage(next)
    await publishAgentResources(options, legacy.revision, f.store.snapshot().revision)
    assert.deepEqual(retired, [contexts[1]])
  } finally { requests.stop(); await f.close() }
})

test('typed busy retirement persists explicit approval; restart never publishes until an explicit retry', async () => {
  const f = await fixture()
  let restarted: PublicationRequests | undefined
  try {
    const request = await f.requests.propose(proposal(f.store))
    f.retirement(async () => { throw new PublicationBusyError('Known active conversation') })
    assert.equal((await f.requests.submit(request.id, decision(request))).status, 'waiting')
    assert.equal(f.requests.pending()?.status, 'waiting')
    f.requests.stop()
    f.retirement(async () => {})
    restarted = new PublicationRequests(f.options)
    assert.equal(f.store.snapshot().revision, request.baseRevision)
    assert.equal(restarted.pending()?.status, 'waiting')
    assert.deepEqual(await restarted.retryWaiting(), [{ requestId: request.id, revision: request.revision, status: 'published' }])
    assert.equal(f.store.snapshot().revision, request.revision)
  } finally { restarted?.stop(); await f.close() }
})

test('waiting permanent errors become structured and never spin; cancellation and stop prevent retries', async () => {
  const f = await fixture()
  try {
    const request = await f.requests.propose(proposal(f.store))
    f.retirement(async () => { throw new PublicationBusyError('Busy') })
    await f.requests.submit(request.id, decision(request))
    f.validate(async () => { throw new Error('Private validation failure') })
    await assert.rejects(f.requests.retryWaiting(), /Private validation failure/)
    assert.equal(f.requests.pending()?.status, 'error')
    assert.equal(f.requests.pending()?.error?.code, 'publication_failed')
    assert.equal(JSON.stringify(f.requests.pending()).includes('Private validation failure'), false)
    assert.deepEqual(await f.requests.retryWaiting(), [])
    f.requests.cancel(request.id, decision(request))
    assert.deepEqual(await f.requests.retryWaiting(), [])
    f.requests.stop()
    await assert.rejects(f.requests.retryWaiting(), /stopped/)
  } finally { await f.close() }
})

test('new review metadata is validated, TypeScript source paths parse, and legacy requests still parse', async () => {
  const f = await fixture()
  try {
    const request = await f.requests.propose(proposal(f.store))
    const legacy = { ...request }
    delete legacy.change
    delete legacy.checks
    delete legacy.impact
    assert.deepEqual(parsePublicationRequest(legacy, 'project-a'), legacy)
    assert.equal(parsePublicationRequest({ ...request, files: [
      { path: 'skills/custom/tool.ts', before: null, after: 'export async function run() {}' },
    ] }, 'project-a').files[0].path, 'skills/custom/tool.ts')
    for (const change of [
      { ...request.change, title: '' }, { ...request.change, sourceSessionId: '\nunsafe' },
      { ...request.change, accessRevision: -1 }, { ...request.change, accessRevision: 0.5 },
    ]) assert.throws(() => parsePublicationRequest({ ...request, change }, 'project-a'))
    assert.equal(parsePublicationRequest({
      ...request, change: { ...request.change, accessRevision: 3 },
    }, 'project-a').change?.accessRevision, 3)
    for (const checks of [
      [{ id: 'check', kind: 'validation', status: 'approved', revision: request.revision }],
      [{ id: 'check', kind: 'validation', status: 'passed', revision: 'bad' }],
      [request.checks![0], request.checks![0]],
    ]) assert.throws(() => parsePublicationRequest({ ...request, checks }, 'project-a'))
    assert.throws(() => parsePublicationRequest({ ...request, impact: { ...request.impact, toolsChanged: 'yes' } }, 'project-a'))
  } finally { await f.close() }
})
