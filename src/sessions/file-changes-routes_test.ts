import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { SessionManager } from './session-manager.ts'
import { sessionsApiPlugin } from './routes.ts'

test('file-change route validates bounded pagination and preserves logical session identity', async () => {
  const calls: Array<{ id: string; offset: number; limit: number; signal: AbortSignal }> = []
  const app = new Hono()
  sessionsApiPlugin({
    async getFileChanges(id: string, offset: number, limit: number, signal: AbortSignal) {
      calls.push({ id, offset, limit, signal })
      return id === 'web:missing' ? null : { changes: [], total: 0, offset }
    },
  } as unknown as SessionManager)(app)
  const response = await app.request('/api/sessions/web%3Aordinary/file-changes?offset=30&limit=5')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { changes: [], total: 0, offset: 30 })
  assert.equal(calls[0].id, 'web:ordinary')
  assert.equal(calls[0].offset, 30)
  assert.equal(calls[0].limit, 5)
  assert.ok(calls[0].signal instanceof AbortSignal)
  for (const query of ['offset=-1', 'offset=1.5', 'offset=9007199254740992', 'limit=0', 'limit=31', 'limit=oops']) {
    assert.equal((await app.request(`/api/sessions/web%3Aordinary/file-changes?${query}`)).status, 400)
  }
  assert.equal(calls.length, 1, 'Invalid queries never scan session logs')
  assert.equal((await app.request('/api/sessions/web%3Amissing/file-changes')).status, 404)
  const unavailable = new Hono()
  sessionsApiPlugin(undefined)(unavailable)
  assert.equal((await unavailable.request('/api/sessions/web%3Aordinary/file-changes')).status, 501)
})
