import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LocalControlRequestError,
  createAuthenticatedShutdownRequest,
  createSidecarReadinessProbe,
  type LocalControlFetch,
} from './local-control-client.js'

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

test('readiness probe accepts a ready sidecar and sends bearer authentication', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const fetch: LocalControlFetch = async (input, init) => {
    requestedUrl = String(input)
    requestedInit = init
    return jsonResponse({ version: 1, role: 'child', status: 'ready' })
  }
  const probe = createSidecarReadinessProbe({ expectedRole: 'child', fetch })

  assert.deepEqual(await probe('http://127.0.0.1:43123', 'secret-token'), { ready: true })
  assert.equal(requestedUrl, 'http://127.0.0.1:43123/local/v1/readiness')
  assert.equal(new Headers(requestedInit?.headers).get('authorization'), 'Bearer secret-token')
  assert.equal(requestedInit?.method, 'GET')
  assert.ok(requestedInit?.signal instanceof AbortSignal)
})

test('readiness probe retries a valid starting response', async () => {
  const probe = createSidecarReadinessProbe({
    expectedRole: 'main',
    fetch: async () => jsonResponse({ version: 1, role: 'main', status: 'starting' }, 503),
  })

  assert.deepEqual(await probe('http://127.0.0.1:43123', 'launch-token'), { ready: false })
})

test('readiness probe maps authentication failure to a redacted configuration error', async () => {
  const launchToken = 'credential-that-must-not-leak'
  const probe = createSidecarReadinessProbe({
    expectedRole: 'child',
    fetch: async () => new Response(launchToken, { status: 403 }),
  })

  const result = await probe('http://127.0.0.1:43123', launchToken)
  assert.equal(result.failure?.kind, 'configuration-error')
  assert.equal(JSON.stringify(result).includes(launchToken), false)
})

test('readiness probe rejects malformed content type, JSON, and schema', async (context) => {
  const cases: Array<{ name: string; response: () => Response }> = [
    {
      name: 'content type',
      response: () => new Response('{"version":1,"role":"child","status":"ready"}', {
        headers: { 'content-type': 'text/plain' },
      }),
    },
    {
      name: 'JSON',
      response: () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    },
    {
      name: 'schema',
      response: () => jsonResponse({ version: 1, role: 'child', status: 'ready', extra: true }),
    },
  ]

  for (const malformed of cases) {
    await context.test(malformed.name, async () => {
      const probe = createSidecarReadinessProbe({ expectedRole: 'child', fetch: async () => malformed.response() })
      const result = await probe('http://127.0.0.1:43123', 'launch-token')
      assert.equal(result.failure?.kind, 'configuration-error')
    })
  }
})

test('readiness probe rejects a role mismatch as a configuration error', async () => {
  const probe = createSidecarReadinessProbe({
    expectedRole: 'child',
    fetch: async () => jsonResponse({ version: 1, role: 'main', status: 'ready' }),
  })

  const result = await probe('http://127.0.0.1:43123', 'launch-token')
  assert.equal(result.failure?.kind, 'configuration-error')
})

test('readiness probe treats timeout, network, and server failures as retryable', async (context) => {
  await context.test('timeout', async () => {
    let requestedTimeout = 0
    const probe = createSidecarReadinessProbe({
      expectedRole: 'child',
      requestTimeoutMs: 37,
      timeoutSignal: (timeoutMs) => {
        requestedTimeout = timeoutMs
        return AbortSignal.abort(new Error('timed out'))
      },
      fetch: async (_input, init) => {
        assert.equal(init?.signal?.aborted, true)
        throw new Error('timed out')
      },
    })
    assert.deepEqual(await probe('http://127.0.0.1:43123', 'launch-token'), { ready: false })
    assert.equal(requestedTimeout, 37)
  })

  await context.test('network', async () => {
    const probe = createSidecarReadinessProbe({
      expectedRole: 'child',
      fetch: async () => { throw new Error('connection refused') },
    })
    assert.deepEqual(await probe('http://127.0.0.1:43123', 'launch-token'), { ready: false })
  })

  await context.test('server failure', async () => {
    const probe = createSidecarReadinessProbe({
      expectedRole: 'child',
      fetch: async () => new Response(null, { status: 500 }),
    })
    assert.deepEqual(await probe('http://127.0.0.1:43123', 'launch-token'), { ready: false })
  })
})

test('shutdown sends an authenticated POST and accepts only the valid 202 contract', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const shutdown = createAuthenticatedShutdownRequest({
    fetch: async (input, init) => {
      requestedUrl = String(input)
      requestedInit = init
      return jsonResponse({ version: 1, accepted: true }, 202)
    },
  })

  assert.deepEqual(
    await shutdown({ apiBase: 'http://127.0.0.1:43123', launchToken: 'shutdown-token' }),
    { version: 1, accepted: true },
  )
  assert.equal(requestedUrl, 'http://127.0.0.1:43123/local/v1/shutdown')
  assert.equal(requestedInit?.method, 'POST')
  assert.equal(new Headers(requestedInit?.headers).get('authorization'), 'Bearer shutdown-token')
})

test('shutdown rejects invalid status, schema, and authentication without leaking credentials', async (context) => {
  const launchToken = 'private-shutdown-token'
  const cases: Array<{
    name: string
    response: Response
    kind: LocalControlRequestError['kind']
  }> = [
    { name: 'status', response: jsonResponse({ version: 1, accepted: true }, 200), kind: 'contract-error' },
    { name: 'schema', response: jsonResponse({ version: 1, accepted: false }, 202), kind: 'contract-error' },
    { name: 'authentication', response: new Response(launchToken, { status: 401 }), kind: 'configuration-error' },
  ]

  for (const invalid of cases) {
    await context.test(invalid.name, async () => {
      const shutdown = createAuthenticatedShutdownRequest({ fetch: async () => invalid.response })
      await assert.rejects(
        shutdown({ apiBase: 'http://127.0.0.1:43123', launchToken }),
        (error: unknown) => {
          assert.ok(error instanceof LocalControlRequestError)
          assert.equal(error.kind, invalid.kind)
          assert.equal(error.message.includes(launchToken), false)
          return true
        },
      )
    })
  }
})