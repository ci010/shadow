import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import test from 'node:test'
import { mcpCleanupFailure, mcpFailure } from './errors.ts'

test('authenticated errors retain status, reason and safe causes without credentials or arbitrary error data', () => {
  const secret = 'synthetic-private-value'
  const error = Object.assign(new Error(`HTTP 401: access expired; Authorization: Bearer ${secret}`, {
    cause: new Error(`Refresh rejected at https://user:${secret}@example.invalid/mcp?key=${secret}`),
  }), { code: 401, headers: { Authorization: secret }, data: { private: secret } })
  const failure = mcpFailure(error, {
    phase: 'connect',
    config: { name: 'fixture', transport: 'streamable-http', headers: { Authorization: `Bearer ${secret}` }, url: `https://example.invalid/mcp?key=${secret}` },
  })
  assert.equal(failure.diagnostic.httpStatus, 401)
  assert.equal(failure.diagnostic.category, 'authentication_required')
  assert.equal(failure.diagnostic.needsUserAction, true)
  assert.match(failure.message, /access expired/)
  assert.match(failure.message, /Refresh rejected/)
  assert.doesNotMatch(inspect(failure), /synthetic-private-value|user:|private:|headers:/)
})

test('network causes, OS errors, RPC failures and rate limits have distinct recovery decisions', () => {
  const network = mcpFailure(new TypeError('fetch failed', {
    cause: Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }),
  }), { phase: 'connect' })
  assert.equal(network.diagnostic.systemCode, 'ENOTFOUND')
  assert.equal(network.diagnostic.retryable, true)
  assert.deepEqual(network.diagnostic.causes, ['DNS lookup failed'])
  for (const [error, category] of [
    [Object.assign(new Error('denied'), { code: 'EACCES' }), 'permission_denied'],
    [Object.assign(new Error('missing'), { code: 'ENOENT' }), 'config_not_found'],
    [Object.assign(new Error('server busy'), { status: 429 }), 'rate_limited'],
    [Object.assign(new Error('invalid arguments'), { code: -32602 }), 'invalid_arguments'],
    [Object.assign(new Error('certificate failed'), { code: 'CERT_HAS_EXPIRED' }), 'tls_error'],
  ] as const) {
    assert.equal(mcpFailure(error, { phase: 'read_config' }).diagnostic.category, category)
  }
  const running = mcpFailure(Object.assign(new Error('timed out'), { code: -32001 }), { phase: 'call_tool' })
  assert.equal(running.diagnostic.rpcCode, -32001)
  assert.equal(running.diagnostic.toolExecution, 'unknown')
  assert.equal(running.diagnostic.retryable, false)
  assert.match(running.diagnostic.nextAction, /not necessarily MCP initialization/)
  assert.match(running.diagnostic.nextAction, /short observation calls/)
  assert.doesNotMatch(running.diagnostic.nextAction, /retry the import at most once/)
})

test('cleanup cannot replace the original failure and blocks unsafe reconnects', () => {
  const error = mcpCleanupFailure(
    Object.assign(new Error('initialize failed'), { code: 503 }),
    new Error('child would not close'),
    { phase: 'connect' },
  )
  assert.equal(error.diagnostic.httpStatus, 503)
  assert.equal(error.diagnostic.message, 'initialize failed')
  assert.equal(error.diagnostic.cleanupFailure?.message, 'child would not close')
  assert.equal(error.diagnostic.retryable, false)
  assert.equal(error.diagnostic.needsUserAction, true)
})

test('stdio initialization timeouts distinguish adapter startup from browser readiness', () => {
  const error = mcpFailure(Object.assign(new Error('Request timed out'), { code: -32001 }), {
    phase: 'connect', elapsedMs: 60_005,
    config: { name: 'chrome-devtools', transport: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest'] },
  })
  assert.equal(error.diagnostic.elapsedMs, 60_005)
  assert.equal(error.diagnostic.toolExecution, 'not_started')
  assert.match(error.diagnostic.nextAction, /package download, interactive install/)
  assert.match(error.diagnostic.nextAction, /not proof its adapter initialized/)
})

test('JSON syntax excerpts and stderr are sanitized before error construction', () => {
  const syntax = mcpFailure(new SyntaxError('Unexpected token in {"password":"synthetic-private-value"} at position 42'), { phase: 'validate_config' })
  assert.match(syntax.message, /Invalid JSON/)
  assert.doesNotMatch(inspect(syntax), /synthetic-private-value/)
  const stderr = mcpFailure(new Error('Connection closed'), {
    phase: 'connect',
    config: { name: 'fixture', transport: 'stdio', command: 'node', env: { API_KEY: 'synthetic-private-value' } },
    stderr: 'Missing dependency; API_KEY=synthetic-private-value',
  })

  assert.match(stderr.message, /Missing dependency/)
  assert.doesNotMatch(inspect(stderr), /synthetic-private-value/)
})

test('npm package resolution and engine failures are not retriable MCP connection failures', () => {
  for (const prefix of ['npm error', 'npm ERR!']) {
    for (const code of ['ETARGET', 'E404', 'EBADENGINE', 'E401']) {
      const failure = mcpFailure(Object.assign(new Error('Connection closed'), { code: -32000 }), {
        phase: 'connect', config: { name: 'fixture', transport: 'stdio', command: 'npx' },
        stderr: `${prefix} code ${code}\n${prefix} failed at https://user:secret@example.invalid/pkg?token=secret\n`,
      })
      assert.equal(failure.diagnostic.packageErrorCode, code)
      assert.equal(failure.diagnostic.category, code === 'E401' ? 'authentication_required' : code === 'EBADENGINE' ? 'runtime_incompatible' : 'package_unavailable')
      assert.equal(failure.diagnostic.rpcCode, -32000)
      assert.equal(failure.diagnostic.systemCode, undefined)
      assert.equal(failure.diagnostic.retryable, false)
      assert.equal(failure.diagnostic.needsUserAction, true)
      assert.equal(failure.diagnostic.toolExecution, 'not_started')
      assert.match(failure.diagnostic.nextAction, /before MCP initialized/)
      assert.doesNotMatch(inspect(failure), /secret|user:/)
    }
  }
  for (const context of [
    { phase: 'call_tool' as const, config: { name: 'fixture', transport: 'stdio' as const, command: 'npx' }, stderr: 'npm error code ETARGET' },
    { phase: 'connect' as const, config: { name: 'fixture', transport: 'streamable-http' as const }, stderr: 'npm error code ETARGET' },
    { phase: 'connect' as const, config: { name: 'fixture', transport: 'stdio' as const }, stderr: 'An app mentioned ETARGET but npm is not reporting a failure.' },
  ]) {
    assert.equal(mcpFailure(new Error('Connection closed'), context).diagnostic.packageErrorCode, undefined)
  }
})
