import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import {
  GatewayClientAddressRegistry,
  registerGatewayRoutes,
  resolveAllowedOrigins,
  resolveGatewayHost,
  resolveLaunchCredential,
  validateLaunchCredential,
} from './server.ts'

function createApp(allowedOrigins: string[], launchCredential?: string) {
  const app = new Hono()
  registerGatewayRoutes(app, [
    (gateway) => gateway.get('/api/ping', (c) => c.json({ ok: true })),
    (gateway) => gateway.get('/health', (c) => c.json({ ok: true })),
  ], { allowedOrigins, launchCredential })
  return app
}

function createAppWithExemption() {
  const app = new Hono()
  registerGatewayRoutes(app, [
    (gateway) => {
      gateway.post('/cluster/v1/challenges', (c) => c.json({ ok: true }))
      gateway.get('/cluster/v1/challenges', (c) => c.json({ ok: true }))
      gateway.post('/cluster/v1/challenges/other', (c) => c.json({ ok: true }))
    },
  ], {
    launchCredential: 'expected-credential',
    launchCredentialExemptions: [{
      method: 'POST',
      path: '/cluster/v1/challenges',
    }],
  })
  return app
}

test('gateway host defaults to loopback while explicit hosts take precedence', () => {
  assertEquals(resolveGatewayHost(), '127.0.0.1')
  assertEquals(
    resolveGatewayHost(undefined, '0.0.0.0', 'legacy.example.test'),
    '0.0.0.0',
  )
  assertEquals(
    resolveGatewayHost('192.0.2.10', '0.0.0.0', 'legacy.example.test'),
    '192.0.2.10',
  )
  assertEquals(
    resolveGatewayHost(undefined, undefined, 'legacy.example.test'),
    'legacy.example.test',
  )
})

test('gateway client addresses come from the trusted server boundary', () => {
  const addresses = new GatewayClientAddressRegistry()
  const request = new Request('http://127.0.0.1/cluster/v1/challenges', {
    headers: { 'X-Forwarded-For': '203.0.113.1' },
  })

  assertEquals(addresses.resolve(request), '')
  addresses.capture(request, {
    transport: 'tcp',
    hostname: '192.0.2.10',
  })
  assertEquals(addresses.resolve(request), 'tcp:192.0.2.10')
})

test('gateway origins include explicit and configured Vite origins without wildcard', () => {
  assertEquals(
    resolveAllowedOrigins(
      'https://remote.example.test, *, invalid origin',
      'http://localhost:5273/some-path',
    ),
    ['https://remote.example.test', 'http://localhost:5273'],
  )
})

test('gateway launch credential uses explicit, gateway, then Electron fallback', () => {
  assertEquals(
    resolveLaunchCredential('explicit', 'gateway', 'electron'),
    'explicit',
  )
  assertEquals(
    resolveLaunchCredential(undefined, 'gateway', 'electron'),
    'gateway',
  )
  assertEquals(
    resolveLaunchCredential(undefined, undefined, 'electron'),
    'electron',
  )
  assertEquals(resolveLaunchCredential('', 'gateway', 'electron'), 'gateway')
  assertEquals(resolveLaunchCredential(), undefined)
})

test('gateway launch credential validation accepts only the expected bearer value', async () => {
  assert(
    await validateLaunchCredential(
      'Bearer expected-credential',
      'expected-credential',
    ),
  )
  assertEquals(
    await validateLaunchCredential(undefined, 'expected-credential'),
    false,
  )
  assertEquals(
    await validateLaunchCredential(
      'Bearer wrong-credential',
      'expected-credential',
    ),
    false,
  )
  assertEquals(
    await validateLaunchCredential(
      'expected-credential',
      'expected-credential',
    ),
    false,
  )
})

test('gateway allows same-origin-style requests without CORS headers', async () => {
  const response = await createApp([]).request('/api/ping')

  assertEquals(response.status, 200)
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), null)
})

test('gateway allows the renderer origin matching its own gateway URL', async () => {
  const response = await createApp([]).request(
    'http://127.0.0.1:3123/api/ping',
    { headers: { Origin: 'http://127.0.0.1:3123' } },
  )

  assertEquals(response.status, 200)
  assertEquals(
    response.headers.get('Access-Control-Allow-Origin'),
    'http://127.0.0.1:3123',
  )
})

test('gateway echoes an explicitly allowed origin', async () => {
  const response = await createApp(['https://remote.example.test']).request(
    '/api/ping',
    { headers: { Origin: 'https://remote.example.test' } },
  )

  assertEquals(response.status, 200)
  assertEquals(
    response.headers.get('Access-Control-Allow-Origin'),
    'https://remote.example.test',
  )
  assertEquals(response.headers.get('Vary'), 'Origin')
})

test('gateway handles allowed preflight without wildcard', async () => {
  const response = await createApp(['http://localhost:5273']).request(
    '/api/ping',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5273',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    },
  )

  assertEquals(response.status, 204)
  assertEquals(
    response.headers.get('Access-Control-Allow-Origin'),
    'http://localhost:5273',
  )
  assert(!response.headers.get('Access-Control-Allow-Origin')?.includes('*'))
  assert(
    response.headers.get('Access-Control-Allow-Methods')?.includes('POST'),
  )
  assertEquals(
    response.headers.get('Access-Control-Allow-Headers'),
    'Content-Type, Authorization',
  )
})

test('gateway preflight permits the credential header without validating it', async () => {
  const response = await createApp(
    ['http://localhost:5273'],
    'expected-credential',
  ).request('/api/ping', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5273',
      Authorization: 'Bearer wrong-credential',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization, Content-Type',
    },
  })

  assertEquals(response.status, 204)
  assertEquals(
    response.headers.get('Access-Control-Allow-Headers'),
    'Content-Type, Authorization',
  )
})

test('gateway requires a configured credential on every non-preflight route', async () => {
  const credential = 'expected-credential'
  const app = createApp([], credential)
  const missing = await app.request('/api/ping')
  const wrong = await app.request('/api/ping', {
    headers: { Authorization: 'Bearer wrong-credential' },
  })
  const valid = await app.request('/api/ping', {
    headers: { Authorization: `Bearer ${credential}` },
  })
  const health = await app.request('/health')

  assertEquals(missing.status, 401)
  assertEquals(wrong.status, 401)
  assertEquals(valid.status, 200)
  assertEquals(health.status, 401)
  assertEquals(await missing.json(), { error: 'unauthorized' })
  const wrongBody = await wrong.text()
  assert(!wrongBody.includes(credential))
  assert(!wrongBody.includes('wrong-credential'))
})

test('gateway launch credential exemptions match exact method and pathname', async () => {
  const app = createAppWithExemption()
  const exempt = await app.request('/cluster/v1/challenges?attempt=1', {
    method: 'POST',
  })
  const wrongMethod = await app.request('/cluster/v1/challenges')
  const adjacentPath = await app.request('/cluster/v1/challenges/other', {
    method: 'POST',
  })

  assertEquals(exempt.status, 200)
  assertEquals(wrongMethod.status, 401)
  assertEquals(adjacentPath.status, 401)
})

test('gateway permits Electron opaque-origin CORS only with launch authentication', async () => {
  const credential = 'expected-credential'
  const authenticated = createApp([], credential)
  const preflight = await authenticated.request('/api/ping', {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization',
    },
  })
  const request = await authenticated.request('/api/ping', {
    headers: {
      Origin: 'null',
      Authorization: `Bearer ${credential}`,
    },
  })
  const unauthenticated = await createApp([]).request('/api/ping', {
    headers: { Origin: 'null' },
  })

  assertEquals(preflight.status, 204)
  assertEquals(preflight.headers.get('Access-Control-Allow-Origin'), 'null')
  assertEquals(request.status, 200)
  assertEquals(request.headers.get('Access-Control-Allow-Origin'), 'null')
  assertEquals(unauthenticated.status, 403)
})

test('gateway rejects unapproved origins and preflight headers', async () => {
  const app = createApp(['http://localhost:5273'])
  const unapprovedRequest = await app.request('/api/ping', {
    headers: { Origin: 'https://unapproved.example.test' },
  })
  const unapproved = await app.request('/api/ping', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://unapproved.example.test',
      'Access-Control-Request-Method': 'POST',
    },
  })
  const unapprovedHeader = await app.request('/api/ping', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5273',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'X-Unapproved',
    },
  })

  assertEquals(unapprovedRequest.status, 403)
  assertEquals(
    unapprovedRequest.headers.get('Access-Control-Allow-Origin'),
    null,
  )
  assertEquals(unapproved.status, 403)
  assertEquals(unapproved.headers.get('Access-Control-Allow-Origin'), null)
  assertEquals(unapprovedHeader.status, 403)
  assertEquals(
    unapprovedHeader.headers.get('Access-Control-Allow-Origin'),
    null,
  )
})
