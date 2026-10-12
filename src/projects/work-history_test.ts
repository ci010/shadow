import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { projectWorkPlugin } from './work-routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

test('lazy decision history is authorized, bounded across physical segments, and exposes partial reads', async () => {
  const read: string[] = []
  const sessions = {
    getSessionState: (id: string) => id === 'fixture' ? { sessionId: id, segmentIndex: 22 } : null,
    getYieldRecords: async (_id: string, physicalId: string) => {
      read.push(physicalId)
      if (read.length === 2) throw new Error('synthetic unreadable segment')
      return []
    },
  } as unknown as SessionManager
  const denied = new Hono()
  projectWorkPlugin(sessions, () => false)(denied)
  assert.equal((await denied.request('/api/work-history?sessionId=fixture')).status, 401)
  assert.equal(read.length, 0)
  const app = new Hono()
  projectWorkPlugin(sessions, () => true)(app)
  assert.equal((await app.request('/api/work-history?sessionId=missing')).status, 404)
  const response = await app.request('/api/work-history?sessionId=fixture')
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(read.length, 20)
  assert.equal(new Set(read).size, 20)
  assert.equal(result.errors.length, 1)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.records, [])
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
