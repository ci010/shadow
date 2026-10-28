import assert from 'node:assert/strict'
import { test } from 'node:test'
import { httpFailure, providerRequestId } from './http-failure.ts'
import { ProviderHttpError, providerFailureKind, providerFailureKinds, TokenLimitExceededError } from './provider.ts'
import { CopilotAuthError } from './copilot.ts'
import { parseSessionRecovery } from '../sessions/session-store.ts'

test('credentials and access rejection have different recovery categories, including wrapped errors', () => {
  for (const [error, kind] of [
    [new ProviderHttpError(401, 'private'), 'authentication'],
    [new ProviderHttpError(403, 'private'), 'authorization'],
    [new CopilotAuthError('missing'), 'credentials-missing'],
    [new CopilotAuthError('expired', 'copilot_access'), 'credentials-expired'],
    [new CopilotAuthError('scope_missing'), 'authorization'],
    [new CopilotAuthError('denied', 'copilot_access', 403), 'authorization'],
    [new CopilotAuthError('denied', 'copilot_token', 401), 'authentication'],
    [new CopilotAuthError('denied'), 'authorization'],
  ] as const) {
    assert.equal(providerFailureKind(error), kind)
    assert.equal(providerFailureKind(new Error('wrapper', { cause: error })), kind)
  }
  for (const kind of providerFailureKinds) {
    assert.equal(parseSessionRecovery({ id: 'old-or-new', reason: 'failed', providerFailure: kind })?.providerFailure, kind)
  }
  assert.deepEqual(parseSessionRecovery({ id: 'legacy', reason: 'failed' }), { id: 'legacy', reason: 'failed' })
})

test('HTTP diagnostics retain only allowlisted codes/status and safe correlation identifiers', async t => {
  const logs: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args) })
  const error = await httpFailure(new Response(JSON.stringify({ error: {
    code: 'permission_error', message: 'Authorization: Bearer secret; cookie=private; https://proxy/private; user prompt',
  } }), { status: 403, headers: { 'x-request-id': 'req_abcdef0123456789', authorization: 'secret' } }), 'anthropic', 'claude')
  assert(error instanceof ProviderHttpError)
  assert.equal(error.code, 'permission_error')
  assert.equal(providerFailureKind(error), 'authorization')
  assert.equal(error.rejectedRequest, true)
  assert.deepEqual(JSON.parse(logs[0][1] as string), {
    provider: 'anthropic', model: 'claude', status: 403, code: 'permission_error', requestId: 'req_abcdef0123456789',
  })
  assert.doesNotMatch(JSON.stringify(logs) + error.message, /secret|cookie|proxy|prompt|Bearer/)
  const unknown = await httpFailure(new Response('{"error":{"code":"sk-private-token"}}', { status: 401 }), 'https://proxy/private', 'sk-private')
  assert(unknown instanceof ProviderHttpError)
  assert.equal(unknown.code, undefined)
  assert.doesNotMatch(JSON.stringify(logs), /sk-private|https:/)
  assert.equal(providerRequestId(new Headers({ 'x-request-id': 'Bearer secret' })), undefined)
})

test('bounded/invalid/unreadable bodies preserve status and retry metadata; context errors stay recoverable', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const body of ['<html>private upstream</html>', 'x'.repeat(20_000)]) {
    const error = await httpFailure(new Response(body, { status: 429, headers: { 'retry-after': '5' } }), 'test', 'model')
    assert(error instanceof ProviderHttpError)
    assert.equal(error.status, 429)
    assert.equal(error.retryAfter, '5')
  }
  const unreadable = new ReadableStream({ start(controller) { controller.error(new Error('private')) } })
  const error = await httpFailure(new Response(unreadable, { status: 503 }), 'test', 'model')
  assert(error instanceof ProviderHttpError)
  assert.equal(error.status, 503)
  assert(await httpFailure(new Response('{"error":{"code":"context_length_exceeded"}}', { status: 400 }), 'test', 'model') instanceof TokenLimitExceededError)
})
