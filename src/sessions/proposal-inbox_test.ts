import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { topicsPlugin } from './topic-routes.ts'
import type { TopicService } from './topics.ts'

test('retired proposal-inbox management endpoints are not registered', async () => {
  const app = new Hono()
  // No topic operation or admission can occur through the retired endpoints.
  const topics = new Proxy({} as TopicService, { get() { throw new Error('Unexpected topic access') } })
  topicsPlugin(topics, () => true)(app)
  for (const method of ['GET', 'PATCH']) {
    const response = await app.request('/api/proposal-inboxes/issue-triage', {
      method,
      ...(method === 'PATCH' ? { headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, repository: 'owner/repo' }) } : {}),
    })
    assert.equal(response.status, 404)
  }
})
