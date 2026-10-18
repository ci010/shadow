import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionManager } from './session-manager.ts'
import { SessionProfileService } from './profile.ts'
import { createStatsHandler } from '../vfs/stats.ts'
import type { TopicService } from './topics.ts'
import type { AutomationProfileService } from '../cron/profile.ts'
import type { ExecutionContext } from '../tools/context.ts'

function fixture() {
  const states = [{ sessionId: 'web:root', projectId: 'p', segmentIndex: 1 }, { sessionId: 'child', projectId: 'p', segmentIndex: 0, parentSessionId: 'web:root' }, { sessionId: 'foreign', projectId: 'q', segmentIndex: 0, parentSessionId: 'web:root' }]
  let reads = 0
  const manager = Object.create(SessionManager.prototype) as SessionManager
  Object.assign(manager, { sessionStates: Object.fromEntries(states.map(state => [state.sessionId, state])), listSessions: () => states, getSessionState: (id: string) => states.find(state => state.sessionId === id), deps: { projectId: 'p', store: { async *readSessionLog(id: string) {
    reads++
    const owner = id.startsWith('web_root') ? 'web:root' : id.startsWith('child') ? 'child' : 'foreign'
    yield { type: 'model_usage', sessionId: owner, id: 'dedup', timestamp: '2026-10-10T12:00:00Z', usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }
    yield { role: 'tool', tool_call_id: 'result', timestamp: '2026-10-10T12:00:00Z' }
  } } } })
  return { manager, reads: () => reads }
}

test('logical segments and exact descendants are alternatives, not additive; Project is isolated', async () => {
  const f = fixture()
  const profile = await new SessionProfileService(f.manager, 'p', () => Date.parse('2026-10-11T00:00:00Z')).query('web:root')
  assert.equal(profile?.rolling24h.own.providerCalls, 1)
  assert.equal(profile?.rolling24h.inclusive.providerCalls, 2)
  assert.equal(profile?.total.inclusive.totalTokens, 12)
  assert.equal(profile?.total.inclusive.toolCalls, 2)
  assert.equal(await new SessionProfileService(f.manager, 'p').query('foreign'), undefined)
})

test('stats discovery is cheap, aggregate-only, encoded and Project-authorized', async () => {
  const f = fixture(), service = new SessionProfileService(f.manager, 'p')
  const topics = { assertActor(projectId: string) { if (projectId !== 'p') throw new Error('Project denied') } } as unknown as TopicService
  const handlers = createStatsHandler(f.manager, () => topics, service, { query: async () => undefined, featureIds: () => [] } as unknown as AutomationProfileService)
  const context = { projectId: 'p', sessionId: 'web:root', signal: new AbortController().signal } as ExecutionContext
  const entries = await handlers.list(context)
  assert.ok(entries.some(entry => entry.name === 'sessions/web%3Aroot'))
  assert.equal(f.reads(), 0)
  assert.ok(!JSON.stringify(entries).includes('foreign'))
  await assert.rejects(async () => handlers.read('project', { ...context, projectId: 'q' }), /Project/)
  await assert.rejects(async () => handlers.read('sessions/%2e%2e', context), /Invalid/)
  await assert.rejects(async () => handlers.read('sessions/%2Fsecret', context), /Invalid/)
  const content = await handlers.read('sessions/web%3Aroot', context)
  assert.equal(JSON.parse(content).sessionId, 'web:root')
  assert.ok(!content.includes('configuration'))
})

test('session profile HTTP uses context authorization, escaped IDs and Project isolation', async () => {
  const { Hono } = await import('hono')
  const { sessionsApiPlugin } = await import('./routes.ts')
  const f = fixture()
  Object.defineProperty(f.manager, 'projectId', { value: 'p' })
  const denied = new Hono()
  sessionsApiPlugin(f.manager, { authorizeContext: () => false })(denied)
  assert.equal((await denied.request('/api/sessions/web%3Aroot/profile')).status, 401)
  const allowed = new Hono()
  sessionsApiPlugin(f.manager, { authorizeContext: () => true })(allowed)
  const response = await allowed.request('/api/sessions/web%3Aroot/profile')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sessionId, 'web:root')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await allowed.request('/api/sessions/foreign/profile')).status, 404)
})

test('existing read/search virtual APIs discover and page stats without a new tool', async () => {
  const { VirtualFs } = await import('../vfs/virtual-fs.ts')
  const { ReadTool } = await import('../tools/read.ts')
  const { SearchTool } = await import('../tools/search.ts')
  const { requireToolText } = await import('../tools/tool.ts')
  const f = fixture(), service = new SessionProfileService(f.manager, 'p')
  const handlers = createStatsHandler(f.manager, () => ({ assertActor() {} }) as unknown as TopicService, service, { featureIds: () => [], query: async () => undefined } as unknown as AutomationProfileService)
  const vfs = new VirtualFs()
  vfs.mount('v:stats', 'Usage statistics', handlers.read, handlers.list)
  const context = { projectId: 'p', sessionId: 'web:root', signal: new AbortController().signal } as ExecutionContext
  const listed = await new SearchTool('.', undefined, vfs).execute({ handler: 'glob', path: 'v:stats', query: '**' }, context)
  assert.match(String(listed), /v:stats\/sessions\/web%3Aroot/)
  assert.equal(f.reads(), 0)
  const page = requireToolText(await new ReadTool('.', vfs).execute({ path: 'v:stats/sessions/web%3Aroot', offset: 2, limit: 1 }, context))
  assert.match(page, /sessionId/)
  assert.match(page, /truncated/)
})
