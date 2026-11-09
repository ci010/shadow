import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { workCompletionsSchema, type WorkRecord } from '../initiatives/work-contract.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { projectWorkPlugin, projectWorkOverview } from './work-routes.ts'

test('completion endpoints authorize both verbs, reject forged identity and mark only observed versions without agent calls', async () => {
  await withTempWorkspace(async home => {
    const store = new InitiativeStore(home)
    const record: WorkRecord = {
      key: 'work:11111111-1111-4111-8111-111111111111', subject: { kind: 'work', id: '11111111-1111-4111-8111-111111111111' },
      revision: 1, sequence: 1, definition: { objective: 'A result', acceptance: [], boundaries: [], evidence: [] },
      origin: 'human', changedBy: 'web:owner', changedAt: '2020-01-01T00:00:00.000Z',
      change: 'understanding', reason: 'Fixture', paused: false,
      workflow: { title: 'Result', manager: null, assignee: null, assignmentRevision: 1, status: 'done', dependencies: [], result: { summary: 'Actual result', evidence: [] } },
    }
    try {
      store.saveWork(record, 0, 'fixture', 'created')
      const sessions = { alignment: { store, contextChanged: () => false }, listHistoryStates: async () => [] } as unknown as SessionManager
      const app = new Hono()
      projectWorkPlugin(sessions, request => request.headers.get('authorization') === 'Bearer fixture')(app)
      const url = '/api/work/completions'
      const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' }
      assert.equal((await app.request(url)).status, 401)
      assert.equal((await app.request(url, { method: 'POST', body: '{"items":[]}' })).status, 401)
      const response = await app.request(url, { headers })
      assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store')
      const initial = workCompletionsSchema.parse(await response.json())
      assert(initial.items[0]!.unread)
      assert.equal(store.workCompletions('web:web-user')[0]!.unread, true)
      for (const body of [{ items: [], principal: 'bob' }, { items: [], userId: 'bob' }, { items: [{ key: record.key, completionId: 7 }] }]) {
        assert.equal((await app.request(url, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400)
      }
      const items = initial.items.map(({ key, completionId }) => ({ key, completionId }))
      const marked = await app.request(url, { method: 'POST', headers: { ...headers, 'x-user-id': 'bob' }, body: JSON.stringify({ items }) })
      assert.equal(marked.status, 200)
      assert.equal(workCompletionsSchema.parse(await marked.json()).items[0]!.unread, false)
      assert.equal(store.workCompletions('bob')[0]!.unread, true)
      assert.deepEqual(store.workRecords(), [record])
      assert.equal(store.workHistory(record.key).length, 1)
      assert.deepEqual((await projectWorkOverview(sessions)).items[0]!.result, record.workflow!.result)
      assert.equal((await app.request(url, { method: 'POST', headers, body: '{broken' })).status, 400)
    } finally { store.close() }
  })
})
