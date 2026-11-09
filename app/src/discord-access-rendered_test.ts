import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { IntegrationOverviewSchema, integrationToolNames } from '../../src/channels/integration-contract.ts'
import { mountBotUi, settleBotUi } from './bot-ui-test-helpers.ts'

// The retired authoring/review wizard is no longer a product entrypoint. Exercise
// its read-only replacement with compiled Vue rendering; no browser is launched.
function overview(projectId = 'p') {
  const agentId = randomUUID(), domainId = randomUUID(), resourceId = randomUUID(), now = new Date().toISOString()
  return IntegrationOverviewSchema.parse({
    projectId, version: 1, revision: 4, deploymentIssues: [],
    agents: [{ id: agentId, name: 'customer-support', displayName: 'Customer support', markdown: 'Answer from approved help articles.', execution: 'restricted', tools: ['read', 'search'], readDomains: [domainId], skills: [], version: 'a'.repeat(64), publishedAt: now }],
    bindings: [{ id: randomUUID(), botInstanceId: 'discord-bot', botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '201' }, enabled: true, agentId, trigger: 'mention', participants: { everyone: false, userIds: ['123'], roleIds: [] }, tools: ['read'], readDomains: [domainId], inheritThreads: false, manage: false, grants: [] }],
    drafts: [], audit: [],
    domains: [{ id: domainId, name: 'Public help articles', kind: 'shared', revision: 1, revoked: false, createdAt: now }],
    resources: [{ id: resourceId, domainId, kind: 'note', title: 'Getting started', version: 'b'.repeat(64), contentHash: 'c'.repeat(64), current: true, revoked: false, createdAt: now, sources: [], publication: { id: randomUUID(), actor: 'shadow-owner', at: now } }],
    tools: integrationToolNames, templates: [], legacy: [], sessions: [], learning: [],
  })
}
const props = { apiBase: 'http://localhost/projects/p', projectId: 'p', botId: 'discord-bot' }

test('read-only service access retains exact assignments, Agent text and explicit published knowledge without mutation controls', async t => {
  const data = overview(), methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    return Response.json(String(url).includes('/resources/') ? { resource: data.resources[0], content: 'Approved public copy; not private source notes.' } : data)
  })
  const view = mountBotUi(t, 'BotServiceStatus.vue', props)
  await settleBotUi()
  assert.match(view.text(), /Read-only deployed access/)
  assert.match(view.text(), /Customer support.*Answer from approved help articles/)
  assert.match(view.text(), /"everyone": false/)
  assert.match(view.text(), /"grants": \[\]/)
  assert.match(view.text(), /Getting started/)
  assert.equal(view.nodes().some(node => ['input', 'form', 'select', 'textarea'].includes(node.tag)), false)
  assert.doesNotMatch(view.text(), /Approve and apply|Publish Agent|Review new domain/)
  await view.click('Read published copy')
  assert.match(view.text(), /Approved public copy/)
  assert.ok(methods.every(method => method === 'GET'))
})

test('read-only access rejects foreign Projects, clears content on scope change and supports retry', async t => {
  let data = overview(), fail = true
  t.mock.method(globalThis, 'fetch', async () => fail ? new Response('untrusted-server-detail', { status: 500 }) : Response.json(data))
  const view = mountBotUi(t, 'BotServiceStatus.vue', props)
  await settleBotUi(); assert.match(view.text(), /Could not load saved service access/); assert.doesNotMatch(view.text(), /untrusted-server-detail/)
  fail = false; await view.click('Refresh status'); assert.match(view.text(), /Customer support/)
  view.state.projectId = 'other'; view.state.apiBase = 'http://localhost/projects/other'; await settleBotUi()
  assert.doesNotMatch(view.text(), /Customer support|Getting started/)
  assert.match(view.text(), /Could not load saved service access/)
  data = overview('other'); data.bindings = []; data.agents = []; data.resources = []
  await view.click('Refresh status'); assert.match(view.text(), /No channels or DMs are assigned/)
})

test('settings keeps read-only entry optional and old review deep links never approve or restore the retired wizard', async t => {
  const methods: string[] = [], bot = { id: 'discord-bot', projectId: 'p', platform: 'discord', displayName: 'Discord connection', label: 'Discord', purpose: 'service', enabled: true, configured: true, state: 'connected', config: {}, secrets: { token: true } }
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    if (String(url).endsWith('/api/channels')) return Response.json({ channels: [bot] })
    if (String(url).endsWith('/api/bot-package')) return Response.json({ pending: [], deployments: [] })
    return Response.json(overview())
  })
  const view = mountBotUi(t, 'ChannelsView.vue', { ...props, active: true, available: true, section: 'connections', requestedReviewId: randomUUID(), reviewBotId: bot.id })
  await settleBotUi()
  assert.match(view.text(), /retired Discord configuration workflow. No change has been approved or published/)
  assert.doesNotMatch(view.text(), /Approve and apply|Channels & people|Review new domain/)
  await view.select(0, 'discord'); await view.select(1, `connection:${bot.id}`)
  assert.match(view.text(), /Saved service access/)
  assert.doesNotMatch(view.text(), /Customer support/)
  const details = view.nodes().find(node => node.tag === 'details' && node.props.onToggle)
  assert(details); details.props.onToggle({ target: { open: true } }); await settleBotUi()
  assert.match(view.text(), /Customer support/)
  assert.ok(methods.every(method => method === 'GET'))
})


test('parent subscription UI shows one rule, not each persisted thread context', async t => {
  const data = overview(), binding = data.bindings[0]!, paths: string[] = []
  binding.inheritThreads = true
  data.sessions = ['301', '302'].map(conversationId => ({ version: 1, sessionId: `bot:p:discord-bot:discord:${conversationId}`, bindingId: binding.id, revision: 'a'.repeat(64), agentId: binding.agentId, agentVersion: 'a'.repeat(64), epoch: randomUUID(), domainId: randomUUID(), startSegment: 0, startedAt: new Date().toISOString(), botInstanceId: binding.botInstanceId, botUserId: '900', conversationId, sources: [], location: { id: conversationId, name: `Hidden post ${conversationId}`, type: 11, guildId: '100', guildName: 'Server', parentId: '201', parentName: 'Parent forum', recipientId: null } }))
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method ?? 'GET', 'GET'); paths.push(new URL(String(input)).pathname)
    return Response.json(data)
  })
  const view = mountBotUi(t, 'BotServiceStatus.vue', props)
  await settleBotUi()
  assert.equal((view.text().match(/Parent channel rule/g) ?? []).length, 1)
  assert.match(view.text(), /Each thread keeps its own context/)
  assert.match(view.text(), /Child threads are not listed as separate configurations/)
  assert.doesNotMatch(view.text(), /Hidden post 301|Hidden post 302/)
  assert.equal(data.sessions.length, 2, 'Configuration presentation does not delete persisted histories')
  assert.deepEqual(paths, ['/projects/p/api/integrations/discord'])
})
