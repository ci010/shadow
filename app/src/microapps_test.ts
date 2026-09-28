import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeAppIdentity, validAppLaunch } from './microapps.ts'
test('only isolated loopback app URLs with one-use tickets reach the embedded page', () => {
  const ticket = 'a'.repeat(43)
  const url = `http://127.0.0.1:54321/#shadow_ticket=${ticket}`
  assert.equal(validAppLaunch({ url }), url)
  for (const value of ['https://external.test/', 'javascript:alert(1)', 'file:///C:/secret',
    `http://127.0.0.1:54321/api/#shadow_ticket=${ticket}`, `http://user:pass@127.0.0.1:54321/#shadow_ticket=${ticket}`,
    'http://127.0.0.1:54321/']) assert.throws(() => validAppLaunch({ url: value }))
})
test('desktop launch hands off only validated Project/app identifiers, not API origins or tickets', () => {
  const appId = '11111111-1111-4111-8111-111111111111'
  assert.deepEqual(nativeAppIdentity('http://127.0.0.1:43123/projects/p/', appId), { projectId: 'p', appId })
  for (const base of ['http://127.0.0.1:43123/', 'http://127.0.0.1:43123/projects/p/api', 'http://127.0.0.1:43123/projects/p%2Fq']) {
    assert.throws(() => nativeAppIdentity(base, appId), /Project-scoped/)
  }
})
