import test from 'node:test'
import assert from 'node:assert/strict'
import { lifecycleErrorDetail } from './lifecycle-diagnostic.ts'

test('lifecycle diagnostics retain stack, error code and bounded causes without SDK objects', () => {
  const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  const error = Object.assign(new Error('startup failed', { cause }), { request: { body: 'private SDK body' } })
  const detail = lifecycleErrorDetail(error, {})
  assert.match(detail, /startup failed/)
  assert.match(detail, /lifecycle-diagnostic_test/)
  assert.match(detail, /Caused by:.*socket closed/)
  assert.match(detail, /ECONNRESET/)
  assert.doesNotMatch(detail, /private SDK body/)
})

test('lifecycle diagnostics remove configured secrets, URLs and credential-bearing text', () => {
  const detail = lifecycleErrorDetail(new Error('failed synthetic-private-value https://example.com/private?q=hidden'), { token: 'synthetic-private-value' })
  assert.doesNotMatch(detail, /synthetic-private-value|example\.com|hidden/)
  assert.doesNotMatch(lifecycleErrorDetail(new Error('Authorization: Bearer abc'), {}), /Bearer abc/)
  assert.equal(lifecycleErrorDetail({ token: 'never serialize' }, {}), '[non-Error thrown; value omitted]')
})
