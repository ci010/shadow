import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ServiceDiscoveryStore } from './service-discovery.ts'
import { BotInstanceStore } from './bot-store.ts'
import { serviceGroupsPlugin } from './service-groups.ts'
import { AgentResourceStore } from '../agent-authoring/store.ts'
import { AgentAuthoringService } from '../agent-authoring/service.ts'
import { CapabilityBroker } from '../agent-authoring/capabilities.ts'
import { PublicationBusyError, PublicationRequests, authoringPublicationPlugin } from '../agent-authoring/publication-requests.ts'
import { AuthoringChanges } from '../agent-authoring/changes.ts'
import { ConversationBindingSchema } from '../agent-authoring/contracts.ts'

async function fixture(t: TestContext, validateLive: () => Promise<void> = async () => {}, retire: () => Promise<void> = async () => {}, readiness: () => string | undefined = () => undefined) {
  const root = join(process.cwd(), '.test-data', `service-groups-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  const resources = new AgentResourceStore({ projectId: 'A', directory: join(root, 'resources') })
  const bots = new BotInstanceStore({ projectId: 'A', path: join(root, 'bots.json') })
  const bot = bots.create('qq', 'Bot', { enabled: false })
  const discovery = new ServiceDiscoveryStore('A', join(root, 'discovery.json'))
  discovery.observe({ botInstanceId: bot.id, platform: 'qq', conversationId: 'group:new', name: 'Untrusted name' }, { id: 'm1', sender: 'user', text: 'ordinary message' })
  const broker = new CapabilityBroker({ projectId: 'A', directory: join(root, 'broker'), resolveSecret: async () => undefined, canDeliver: () => false, deliver: async () => { throw new Error('Unexpected delivery') } })
  const service = new AgentAuthoringService({ projectId: 'A', workspace: root, store: resources, broker, folders: { get: () => undefined, requireAvailable: async () => { throw new Error('Unexpected folder access') }, acquireAccess: () => () => {} } })
  const changes = new AuthoringChanges({ projectId: 'A', directory: join(root, 'changes'), resources })
  const reviews = new PublicationRequests({ service, retire, validateLive })
  const app = new Hono()
  const authorize = (request: Request) => request.headers.get('Authorization') === 'Bearer synthetic-owner'
  serviceGroupsPlugin({ bots, discovery, resources, reviews, changes, authorize, readiness })(app)
  authoringPublicationPlugin(reviews, authorize)(app)
  const template = ConversationBindingSchema.parse({ botInstanceId: bot.id, platform: 'qq', conversationId: 'group:existing', agent: 'helper', skills: [], grants: [{ id: 'github', kind: 'http', origin: 'https://api.github.com', routes: [{ method: 'GET', path: '/repos/example/project/issues' }] }] })
  const draft = await resources.stage({ expectedRevision: resources.draft().revision, bundle: { version: 1, files: { 'agents/helper/AGENT.md': `---\nallowedTools: []\ncapabilityProfiles: ${JSON.stringify([{ botInstanceId: bot.id, platform: 'qq', skills: [], grants: template.grants, readFolders: [] }])}\n---\nSynthetic helper.` }, bindings: [template] } })
  await resources.publish(draft.revision)
  t.after(() => { reviews.stop(); rmSync(root, { recursive: true, force: true }) })
  const headers = { Authorization: 'Bearer synthetic-owner', 'Content-Type': 'application/json' }
  const propose = (overrides = {}) => app.request('/api/service-groups/propose', { method: 'POST', headers, body: JSON.stringify({ botInstanceId: bot.id, conversationId: 'group:new', agent: 'helper', revision: resources.snapshot().revision, ...overrides }) })
  return { app, resources, changes, bot, discovery, reviews, headers, propose }
}

test('native group setup is owner-only, uses only reviewed scoped Agent profiles and publishes only the reviewed revision', async t => {
  const f = await fixture(t)
  assert.equal((await f.app.request('/api/service-groups')).status, 401)
  assert.equal((await f.app.request('/api/service-groups/propose', { method: 'POST', body: '{}' })).status, 401)
  const before = f.resources.snapshot().revision
  const metadata = await (await f.app.request('/api/service-groups', { headers: f.headers })).json()
  assert.deepEqual(metadata.agents, ['helper'])
  assert.equal(metadata.groups[0].enabled, false)
  assert.deepEqual(metadata.groups[0].messages, [])
  assert.equal(metadata.groups[0].sessionId, `bot:A:${encodeURIComponent(f.bot.id)}:qq:group%3Anew`)
  const bySession = await (await f.app.request(`/api/service-groups?session=${encodeURIComponent(metadata.groups[0].sessionId)}`, { headers: f.headers })).json()
  assert.equal(bySession.groups[0].messages[0].text, 'ordinary message')
  const detailed = await (await f.app.request(`/api/service-groups?group=${encodeURIComponent(JSON.stringify([f.bot.id, 'group:new']))}`, { headers: f.headers })).json()
  assert.equal(detailed.groups[0].messages[0].text, 'ordinary message')
  const response = await f.propose()
  assert.equal(response.status, 200)
  const { request } = await response.json()
  assert.equal(f.resources.snapshot().revision, before)
  assert.equal(request.sessionId, 'owner:service-groups')
  assert.equal(request.change.sourceSessionId, 'owner:service-groups')
  assert.equal(request.bindings.find((binding: { conversationId: string }) => binding.conversationId === 'group:new').grants[0].id, 'github')
  assert.deepEqual(request.impact.affectedBindings, [JSON.stringify([f.bot.id, 'qq', 'group:new'])])
  const pending = await (await f.app.request('/api/service-groups', { headers: f.headers })).json()
  assert.equal(pending.groups[0].pending, true)
  const path = `/api/agent-resources/publication-requests/${request.id}`
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify({ revision: before, baseRevision: before }) })).status, 409)
  const body = JSON.stringify({ revision: request.revision, baseRevision: request.baseRevision })
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body })).status, 200)
  assert.equal(f.resources.snapshot().revision, request.revision)
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body })).status, 409)
  assert.equal(f.resources.resolve({ projectId: 'foreign', botInstanceId: f.bot.id, platform: 'qq', conversationId: 'group:new' }), undefined)
})

test('rejection never enables a group; stale or foreign targets and unrelated authoring drafts remain isolated', async t => {
  const f = await fixture(t)
  assert.equal((await f.propose({ botInstanceId: 'foreign' })).status, 404)
  assert.equal((await f.propose({ conversationId: 'group:not-observed' })).status, 400)
  assert.equal((await f.propose({ revision: 'stale' })).status, 409)
  assert.equal((await f.propose({ agent: 'not-published' })).status, 400)
  const { request } = await (await f.propose()).json()
  f.reviews.cancel(request.id, { revision: request.revision, baseRevision: request.baseRevision })
  assert.equal(f.resources.snapshot().bundle.bindings.length, 1)
  assert.equal(f.reviews.list().length, 0)
  // The same explicitly selected candidate can be reviewed again without overwriting a draft.
  assert.equal((await f.propose()).status, 200)
  const draft = structuredClone(f.resources.draft())
  draft.bundle.files['agents/helper/AGENT.md'] += '\nUnrelated edit'
  await f.resources.stage({ expectedRevision: draft.revision, bundle: draft.bundle })
  assert.equal((await f.propose()).status, 200)
  assert.equal(f.resources.draft().bundle.files['agents/helper/AGENT.md'], draft.bundle.files['agents/helper/AGENT.md'])
})

test('ordinary group POST rejects all low-level policy and Agent creation inputs', async t => {
  const f = await fixture(t)
  for (const input of [{ skills: [] }, { grants: [] }, { readFolders: ['foreign'] }, { prompt: 'new prompt' }, { parameters: {} }]) {
    const response = await f.propose(input)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'invalid_group_proposal')
  }
  assert.equal(f.reviews.list().length, 0)
})

test('proposal diagnostics preserve actionable codes and never replace an existing review', async t => {
  const f = await fixture(t)
  for (const [input, status, code] of [
    [{ botInstanceId: 'gone' }, 404, 'service_bot_not_found'],
    [{ revision: 'old' }, 409, 'draft_or_publication_changed'],
    [{ agent: 'missing' }, 400, 'agent_not_published'],
    [{ prompt: 'replace' }, 400, 'invalid_group_proposal'],
    [{ agent: 'new', prompt: 'synthetic-stored-credential' }, 400, 'invalid_group_proposal'],
    [{ agent: 'INVALID' }, 400, 'invalid_group_proposal'],
  ] as const) {
    const response = await f.propose(input)
    assert.equal(response.status, status)
    assert.equal((await response.json()).error, code)
  }
  const { request } = await (await f.propose()).json()
  const repeated = await (await f.propose()).json()
  assert.equal(repeated.request.id, request.id)
  assert.equal(f.reviews.list().length, 1)
  const conflict = await f.propose({ grants: [] })
  assert.equal(conflict.status, 400)
  assert.equal((await conflict.json()).error, 'invalid_group_proposal')
  assert.equal(f.reviews.list()[0]!.id, request.id)
})


test('live validation reports a safe category, preserves shared draft and enables nothing', async t => {
  const f = await fixture(t, async () => { throw new Error('Credential reference synthetic-private-name must be provisioned outside the conversation before publication.') })
  const before = f.resources.snapshot().revision
  const response = await f.propose()
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'group_setup_credential_missing', diagnostic: { stage: 'live', action: 'provision_credential_in_project_settings' } })
  assert.equal(f.resources.snapshot().revision, before)
  assert.equal(f.resources.draft().revision, before)
  assert.equal(f.reviews.list().length, 0)
})

test('independent group review publishes only its candidate and preserves unrelated draft bytes and revision', async t => {
  const f = await fixture(t)
  const bundle = structuredClone(f.resources.draft().bundle)
  bundle.files['agents/helper/AGENT.md'] += '\nUnpublished private edit'
  bundle.files['agents/draft-only/AGENT.md'] = '---\nallowedTools: []\n---\nUnpublished Agent'
  bundle.bindings.push(ConversationBindingSchema.parse({ botInstanceId: f.bot.id, platform: 'qq', conversationId: 'draft-only', agent: 'draft-only' }))
  const draft = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle })
  // An unrelated shared-draft review must coexist, not be replaced.
  const unrelated = await f.reviews.propose(undefined, undefined, 'web:chat-admin')
  const { request } = await (await f.propose()).json()
  assert.ok(request.change)
  assert.equal(f.reviews.list().length, 2)
  assert.ok(f.reviews.list().some(review => review.id === unrelated.id))
  assert.deepEqual(f.resources.draft(), draft)
  assert.equal((await (await f.propose()).json()).request.id, request.id)
  await f.reviews.submit(request.id, { revision: request.revision, baseRevision: request.baseRevision })
  assert.deepEqual(f.resources.draft(), draft)
  const published = f.resources.snapshot()
  assert.equal(published.bundle.files['agents/draft-only/AGENT.md'], undefined)
  assert.doesNotMatch(published.bundle.files['agents/helper/AGENT.md']!, /Unpublished/)
  assert.equal(published.bundle.bindings.some(binding => binding.conversationId === 'draft-only'), false)
  assert.equal(published.bundle.bindings.some(binding => binding.conversationId === 'group:new'), true)
})

test('group approval waits for active work without staging or activating the candidate', async t => {
  let busy = true
  const f = await fixture(t, async () => {}, async () => { if (busy) throw new PublicationBusyError('Active work') })
  const draft = f.resources.draft()
  const { request } = await (await f.propose()).json()
  const decision = { revision: request.revision, baseRevision: request.baseRevision }
  assert.equal((await f.reviews.submit(request.id, decision)).status, 'waiting')
  assert.notEqual(f.resources.snapshot().revision, request.revision)
  assert.deepEqual(f.resources.draft(), draft)
  busy = false
  assert.equal((await f.reviews.retryWaiting())[0]?.status, 'published')
  assert.deepEqual(f.resources.draft(), draft)
})

test('concurrent group proposals do not create duplicate reviews or replace another candidate', async t => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t, async () => { entered(); await gate })
  const first = f.propose()
  await started
  assert.equal((await f.propose()).status, 409)
  release()
  assert.equal((await first).status, 200)
  assert.equal(f.reviews.list().length, 1)
  assert.equal((await f.propose()).status, 200)
  assert.equal(f.reviews.list().length, 1)
})

test('first group uses a published Agent profile without low-level input; legacy bindings never become defaults', async t => {
  const f = await fixture(t)
  const snapshot = structuredClone(f.resources.snapshot())
  const file = snapshot.bundle.files['agents/helper/AGENT.md']!
  snapshot.bundle.files['agents/helper/AGENT.md'] = '---\nallowedTools: []\n---\nLegacy helper.'
  let staged = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle: snapshot.bundle })
  await f.resources.publish(staged.revision)
  let response = await f.propose()
  assert.equal(response.status, 422)
  assert.equal((await response.json()).error, 'group_setup_profile_missing')
  assert.equal(f.reviews.list().length, 0)
  let metadata = await (await f.app.request('/api/service-groups', { headers: f.headers })).json()
  assert.equal(metadata.agentSetups[0].problem, 'profile_missing')
  // Explicit creator policy is reviewed as part of the versioned Agent file, not inferred from legacy grants.
  snapshot.bundle.files['agents/helper/AGENT.md'] = file
  snapshot.bundle.bindings = []
  staged = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle: snapshot.bundle })
  await f.resources.publish(staged.revision)
  response = await f.propose()
  assert.equal(response.status, 200)
  const { request } = await response.json()
  assert.equal(request.bindings.length, 1)
  assert.equal(request.bindings[0].grants[0].origin, 'https://api.github.com')
  assert.equal(f.resources.snapshot().bundle.bindings.length, 0)
  metadata = await (await f.app.request('/api/service-groups', { headers: f.headers })).json()
  assert.equal(metadata.agentSetups[0].status, 'ready')
  assert.equal(metadata.agentSetups[0].source.revision, staged.revision)
  assert.deepEqual(metadata.agentSetups[0].summary.targets[0].operations, ['GET /repos/example/project/issues'])
})

test('Agent profiles do not cross Bot scopes and an explicit empty profile does not copy historical grants', async t => {
  const f = await fixture(t)
  const foreign = f.bot.id + '-foreign'
  const bundle = structuredClone(f.resources.snapshot().bundle)
  bundle.files['agents/helper/AGENT.md'] = `---\nallowedTools: []\ncapabilityProfiles: [{botInstanceId: "${foreign}", platform: qq, skills: [], grants: [], readFolders: []}]\n---\nHelper`
  let staged = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle })
  await f.resources.publish(staged.revision)
  assert.equal((await f.propose()).status, 422)
  bundle.files['agents/helper/AGENT.md'] = bundle.files['agents/helper/AGENT.md'].replace(foreign, f.bot.id)
  staged = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle })
  await f.resources.publish(staged.revision)
  const { request } = await (await f.propose()).json()
  assert.deepEqual(request.bindings.find((binding: { conversationId: string }) => binding.conversationId === 'group:new').grants, [])
})


test('missing private connection marks published Agent incomplete and blocks proposal before a Change is created', async t => {
  const f = await fixture(t, async () => {}, async () => {}, () => 'credential_missing')
  const before = f.resources.snapshot()
  const metadata = await (await f.app.request('/api/service-groups', { headers: f.headers })).json()
  assert.equal(metadata.agentSetups[0].status, 'incomplete')
  assert.equal(metadata.agentSetups[0].problem, 'credential_missing')
  const response = await f.propose()
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'group_setup_credential_missing', diagnostic: { stage: 'agent', action: 'open_private_credential_entry' } })
  assert.equal(f.changes.list().length, 0)
  assert.equal(f.reviews.list().length, 0)
  assert.deepEqual(f.resources.snapshot(), before)
})


test('first group for a tool-enabled Agent gets creator-selected skills and scoped HTTP permissions with no group inputs', async t => {
  const f = await fixture(t)
  const profile = { botInstanceId: f.bot.id, platform: 'qq', skills: ['issues'], readFolders: ['approved-docs'], parameters: { repository: 'example/project' }, grants: [{ id: 'github', kind: 'http', origin: 'https://api.github.com', routes: [{ method: 'GET', path: '/repos/example/project/issues' }, { method: 'POST', path: '/repos/example/project/issues', bodySchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }] }] }
  const bundle = { version: 1 as const, bindings: [], files: {
    'agents/helper/AGENT.md': `---\nallowedTools: [issue_list]\nallowedModules: ["@shadow/github"]\ncapabilityProfiles: ${JSON.stringify([profile])}\n---\nSynthetic tool Agent`,
    'skills/issues/SKILL.md': '---\ntools:\n  issue_list:\n    source: issues.js\n    description: Query or create an approved issue\n    parameters: {type: object}\n    imports: ["@shadow/github"]\n---\nSynthetic skill',
    'skills/issues/issues.js': 'export async function run() { return [] }',
  } }
  const staged = await f.resources.stage({ expectedRevision: f.resources.draft().revision, bundle })
  await f.resources.publish(staged.revision)
  const response = await f.propose()
  assert.equal(response.status, 200)
  const { request } = await response.json()
  assert.equal(request.files.length, 0)
  assert.deepEqual(request.bindings[0].skills, profile.skills)
  assert.deepEqual(request.bindings[0].readFolders, profile.readFolders)
  assert.deepEqual(request.bindings[0].parameters, profile.parameters)
  assert.deepEqual(request.bindings[0].grants, profile.grants)
  assert.equal(request.baseRevision, staged.revision)
  assert.equal(f.resources.snapshot().bundle.bindings.length, 0)
  assert.deepEqual(f.resources.draft().bundle, bundle)
})
