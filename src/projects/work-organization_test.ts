import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { projectWorkPlugin } from './work-routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

test('organization diagnostics cover pre-model errors without leaking exception details', async () => {
  const cases = [
    { authorize: () => false, alignment: {}, body: '{}', status: 401, stage: 'authorization', code: 'unauthorized' },
    { authorize: () => { throw new Error('SECRET'); }, alignment: {}, body: '{}', status: 502, stage: 'authorization', code: 'organization_authorization_failed' },
    { authorize: () => true, alignment: undefined, body: '{}', status: 501, stage: 'availability', code: 'work_unavailable' },
    { authorize: () => true, alignment: {}, body: '{SECRET', status: 400, stage: 'validation', code: 'invalid_request' },
    { authorize: () => true, alignment: {}, body: '{}', status: 502, stage: 'organization', code: 'organization_failed' },
  ]
  for (const fixture of cases) {
    const app = new Hono()
    projectWorkPlugin({ alignment: fixture.alignment } as SessionManager, fixture.authorize, undefined, undefined,
      async () => { throw new Error('SECRET provider payload') })(app)
    const response = await app.request('/api/work/organize', { method: 'POST', body: fixture.body })
    assert.equal(response.status, fixture.status)
    const body = await response.json()
    assert.equal(body.error, fixture.code)
    assert.equal(body.stage, fixture.stage)
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/)
    assert.equal(response.headers.get('X-Correlation-ID'), body.correlationId)
    assert(!JSON.stringify(body).includes('SECRET'))
  }
})
