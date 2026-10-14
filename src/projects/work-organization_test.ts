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

 test('captured Responses output-limit failure retains a safe organization diagnostic', async () => {
  const { observerExecutionError } = await import('./observer-output.ts')
  const { organizationErrorMessage } = await import('../../app/src/organization-error.ts')
  const app = new Hono()
  let calls = 0
  projectWorkPlugin({ alignment: {} } as SessionManager, () => true, undefined, undefined, async () => {
    calls++
    throw observerExecutionError('Responses request incomplete: max_output_tokens')
  })(app)
  const response = await app.request('/api/work/organize', { method: 'POST', body: '{}' })
  const body = await response.json()
  assert.equal(response.status, 502)
  assert.equal(body.error, 'model_output_limit')
  assert.equal(body.stage, 'organization')
  assert.equal(calls, 1) // No paid retry on incomplete output.
  assert.match(organizationErrorMessage(body.error), /output length limit/)
  assert.equal(observerExecutionError('private provider response').message, 'Work observation did not complete.')
})
