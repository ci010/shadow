import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CapabilityBroker, CapabilityError, isPublicCapabilityAddress, resolveCapabilityAddresses,
  assertSupportedJsonSchema, validateJsonSchema,
  type CapabilityInvocationContext, type DeliverInputPayload } from './capabilities.ts'
import type { CapabilityGrant } from './contracts.ts'

const grant: CapabilityGrant = {
  id: 'api', kind: 'http', origin: 'https://api.example.com',
  routes: [{ method: 'GET', path: '/items/*' }, {
    method: 'POST', path: '/items',
    bodySchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false },
  }],
  credential: { secretRef: 'api-key', header: 'Authorization', prefix: 'Bearer ' },
}
const inbox: CapabilityGrant = { id: 'inbox', kind: 'inbox', sessionId: 'target' }
const get = { method: 'GET', path: '/items/a' }
const post = { method: 'POST', path: '/items', body: { title: 'request' }, idempotencyKey: 'case-1' }
function context(overrides: Partial<CapabilityInvocationContext> = {}): CapabilityInvocationContext {
  return { sessionId: 'source', inputId: 'source-input', toolCallId: 'call-1', bindingKey: 'binding-1',
    revision: 'revision-1', signal: new AbortController().signal, assertCurrent() {}, ...overrides }
}
function code(expected: string) {
  return (error: unknown) => error instanceof CapabilityError && error.code === expected
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = join(process.cwd(), '.capability-test-fixtures', randomUUID())
  await mkdir(directory, { recursive: true })
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
    // Each fixture only removes the shared parent when it is empty.
    const { rmdir } = await import('node:fs/promises')
    await rmdir(join(process.cwd(), '.capability-test-fixtures')).catch(() => undefined)
  })
  return directory
}
function broker(directory: string, overrides: Partial<ConstructorParameters<typeof CapabilityBroker>[0]> = {}) {
  return new CapabilityBroker({
    projectId: 'project-1', directory, resolveSecret: async () => 'super-secret',
    deliver: async () => ({ status: 'accepted' }), canDeliver: id => id === 'target',
    request: async () => new Response('{"ok":true}'), ...overrides,
  })
}

test('HTTP grants fix origin, path segment, method and strict input/body schemas', async t => {
  const directory = await fixture(t)
  let calls = 0
  const service = broker(directory, { request: async () => { calls++; return new Response('{}') } })
  for (const path of ['//other.example/items/a', '/items/../a', '/items/%2e%2e', '/items/%252e', '/items/a?x=1',
    '/items/a#x', '/items\\a', '/items/a b', '/items/./a']) {
    await assert.rejects(service.execute(grant, { ...get, path }, context()), code('invalid_path'))
  }
  for (const path of ['/items/a/b', '/items/', '/other/a']) {
    await assert.rejects(service.execute(grant, { ...get, path }, context()), code('route_denied'))
  }
  await assert.rejects(service.execute(grant, { ...get, method: 'DELETE' }, context()), code('route_denied'))
  for (const input of [{ ...get, method: 'HEAD' }, { ...get, headers: { authorization: 'attacker' } },
    { ...get, origin: 'https://attacker.example' }, { ...get, body: null }, { ...post, idempotencyKey: undefined },
    { ...get, query: { bad: 1 } }]) {
    await assert.rejects(service.execute(grant, input, context()), code('invalid_input'))
  }
  for (const body of [{}, { title: '' }, { title: 'ok', extra: 1 }, 'bad']) {
    await assert.rejects(service.execute(grant, { ...post, body }, context()), code('invalid_body'))
  }
  assert.equal(calls, 0)
  await service.execute(grant, get, context())
  assert.equal(calls, 1)
})

test('public-unicast classification and checked DNS reject all unsafe answers', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '::1', '::', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:0808:0808::1', '3fff::1']) {
    assert.equal(isPublicCapabilityAddress(address), false, address)
    await assert.rejects(resolveCapabilityAddresses('api.example.com', async () => [{ address, family: address.includes(':') ? 6 : 4 }]), code('unsafe_target'))
  }
  assert.equal(isPublicCapabilityAddress('8.8.8.8'), true)
  assert.equal(isPublicCapabilityAddress('2606:4700:4700::1111'), true)
  const addresses = [{ address: '8.8.8.8', family: 4 }]
  assert.deepEqual(await resolveCapabilityAddresses('public.example', async () => addresses), addresses)
  await assert.rejects(resolveCapabilityAddresses('public.example', async () => [...addresses, { address: '10.0.0.1', family: 4 }]), code('unsafe_target'))
  await assert.rejects(resolveCapabilityAddresses('public.example', async () => []), code('unsafe_target'))
})

test('HTTP origin and credential configuration cannot override transport safety', async t => {
  const service = broker(await fixture(t))
  for (const origin of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/path',
    'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'https://localhost', 'https://host.local',
    'https://2130706433', 'https://api.example.com.']) {
    await assert.rejects(service.execute({ ...grant, origin } as CapabilityGrant, get, context()))
  }
  for (const header of ['Host', 'Cookie', 'Content-Length', 'Proxy-Authorization']) {
    await assert.rejects(service.execute({ ...grant, credential: { secretRef: 'api-key', header, prefix: '' } } as CapabilityGrant, get, context()), code('invalid_grant'))
  }
  await assert.rejects(broker(await fixture(t), { resolveSecret: async () => undefined }).execute(grant, get, context()), code('unknown_secret'))
})

test('body schema constraints are fail-closed including unsupported absent-property constraints', async t => {
  const service = broker(await fixture(t), { request: async () => assert.fail('must not call transport') })
  for (const bodySchema of [
    { type: 'object', properties: { absent: { pattern: '^safe$' } } },
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', required: [4] },
    { type: ['object', 'null'] },
    { $ref: 'https://elsewhere.example/schema' },
    { type: 'string', minLength: -1 },
  ]) {
    const scoped: CapabilityGrant = { id: 'api', kind: 'http', origin: 'https://api.example.com',
      routes: [{ method: 'POST', path: '/items', bodySchema }] }
    await assert.rejects(service.execute(scoped, post, context()), code('invalid_schema'))
  }
})

test('exported schema API shares the broker subset for tool arguments', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Tool arguments', description: 'Annotations are not executable constraints.',
    type: 'object', required: ['name', 'count', 'tags', 'enabled', 'reference'], additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 4, enum: ['test', 'ok'] },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', const: 'safe' } },
      enabled: { type: 'boolean' }, reference: { type: 'null' },
    },
  }
  const input = { name: 'test', count: 2, tags: ['safe'], enabled: true, reference: null }
  assert.doesNotThrow(() => assertSupportedJsonSchema(schema))
  assert.doesNotThrow(() => validateJsonSchema(schema, input))
  for (const invalid of [{ ...input, count: 0 }, { ...input, count: 4 }, { ...input, count: 1.5 },
    { ...input, name: '' }, { ...input, name: 'other' }, { ...input, tags: [] },
    { ...input, tags: ['safe', 'safe', 'safe'] }, { ...input, tags: ['unsafe'] },
    { ...input, enabled: 'true' }, { ...input, reference: 'none' }, { ...input, extra: true }, {}]) {
    assert.throws(() => validateJsonSchema(schema, invalid), code('invalid_body'))
  }
  for (const unsupported of [
    { pattern: '(a+)+$' }, { format: 'email' }, { $ref: '#/definitions/value' },
    { allOf: [] }, { type: ['string', 'null'] }, { additionalProperties: { type: 'string' } },
    { items: [{ type: 'string' }] }, { properties: { absent: { pattern: '(a+)+$' } } },
  ]) {
    assert.throws(() => assertSupportedJsonSchema(unsupported), code('invalid_schema'))
    assert.throws(() => validateJsonSchema(unsupported, {}), code('invalid_schema'))
  }
  assert.throws(() => assertSupportedJsonSchema(null as unknown as Record<string, unknown>), code('invalid_schema'))
  assert.throws(() => assertSupportedJsonSchema({ const: Infinity }), code('invalid_schema'))
  for (const invalid of [undefined, NaN, Infinity, new Date()]) {
    assert.throws(() => validateJsonSchema({}, invalid), code('invalid_input'))
  }
  let nested: Record<string, unknown> = {}
  for (let index = 0; index < 33; index++) nested = { properties: { child: nested } }
  assert.throws(() => assertSupportedJsonSchema(nested), code('invalid_schema'))
})

test('HTTP uses fixed secret headers, omits cookies, rejects redirects, and redacts echoes', async t => {
  const directory = await fixture(t)
  let calls = 0
  const service = broker(directory, {
    request: async (url, init) => {
      calls++
      assert.equal(String(url), 'https://api.example.com/items/a?q=x+y')
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      assert.equal(new Headers(init?.headers).get('user-agent'), 'Shadow')
      assert.equal(new Headers(init?.headers).get('accept'), 'application/json')
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer super-secret')
      return new Response(JSON.stringify({ secret: 'super-secret', nested: ['Bearer super-secret'], 'super-secret': 'x' }),
        { headers: { 'x-secret': 'super-secret' } })
    },
  })
  const result = await service.execute(grant, { ...get, query: { q: 'x y' }, idempotencyKey: 'read-1' }, context())
  assert.equal(JSON.stringify(result).includes('super-secret'), false)
  assert.equal(JSON.stringify(result).includes('x-secret'), false)
  await service.execute(grant, { ...get, query: { q: 'x y' }, idempotencyKey: 'read-1' }, context())
  assert.equal(calls, 1)
  const files = await readdir(directory)
  assert.equal((await readFile(join(directory, files.find(name => name.endsWith('.json'))!), 'utf8')).includes('super-secret'), false)
  const redirected = new Response('secret')
  Object.defineProperty(redirected, 'redirected', { value: true })
  await assert.rejects(broker(directory, { request: async () => redirected }).execute(grant, get, context()), code('redirect_denied'))
  await assert.rejects(broker(directory, { request: async () => new Response('secret', { status: 302 }) }).execute(grant, get, context()), code('http_status'))
})

test('HTTP error messages stay generic and transport credentials stay private; responses bounded', async t => {
  const directory = await fixture(t)
  const service = broker(directory, { request: async () => new Response('super-secret', { status: 403 }) })
  await assert.rejects(service.execute(grant, get, context()), error => {
    assert.equal(String(error).includes('super-secret'), false)
    return error instanceof CapabilityError && error.status === 403
  })
  await assert.rejects(broker(directory, { request: async () => { throw new Error('super-secret') } }).execute(grant, get, context()), code('network_error'))
  await assert.rejects(broker(directory, { request: async () => new Response('x'.repeat(256 * 1024 + 1)) }).execute(grant, get, context()), code('response_too_large'))
  assert.deepEqual(await broker(directory, { request: async () => new Response('plain') }).execute(grant, get, context()), { status: 200, body: 'plain' })
  const numericEcho = await broker(directory, { resolveSecret: async () => '12345678',
    request: async () => new Response('{"value":12345678}') }).execute(grant, get, context())
  assert.equal(JSON.stringify(numericEcho).includes('12345678'), false)
})

test('HTTP public GETs and JSON writes both include a broker User-Agent', async t => {
  const directory = await fixture(t)
  let calls = 0
  const service = broker(directory, {
    resolveSecret: async () => assert.fail('Public grant must not resolve credentials'),
    request: async (_url, init) => {
      calls++
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('user-agent'), 'Shadow')
      assert.equal(headers.get('authorization'), null)
      assert.equal(headers.get('content-type'), init?.method === 'POST' ? 'application/json' : null)
      return new Response('{}')
    },
  })
  const publicGrant: CapabilityGrant = { id: grant.id, kind: 'http', origin: grant.origin, routes: grant.routes }
  await service.execute(publicGrant, get, context())
  await service.execute(publicGrant, post, context())
  assert.equal(calls, 2)
})

test('HTTP diagnostics allowlist remote fields and redact credentials before exposing them to the host', async t => {
  const secret = 'synthetic-key+/"'
  const echoes = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
  const service = broker(await fixture(t), {
    resolveSecret: async () => secret,
    request: async () => Response.json({
      message: `Forbidden: ${echoes.join(' ')}\nContact support.`,
      token: 'PRIVATE-JSON-FIELD',
      errors: [{ message: 'PRIVATE-NESTED-FIELD' }],
    }, {
      status: 403,
      headers: {
        'x-github-request-id': `request-${secret}`,
        'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12345',
        'x-ratelimit-resource': 'core', 'retry-after': '30',
        'x-github-sso': 'required; url=https://example.com/PRIVATE-SSO-URL',
        'set-cookie': 'PRIVATE-COOKIE', authorization: 'PRIVATE-HEADER',
      },
    }),
  })
  await assert.rejects(service.execute(grant, get, context()), error => {
    assert.ok(error instanceof CapabilityError)
    assert.equal(error.code, 'http_status')
    assert.equal(error.status, 403)
    assert.deepEqual(error.diagnostics, {
      source: 'untrusted-http-response',
      message: 'Forbidden: [REDACTED] [REDACTED] [REDACTED] Contact support.',
      headers: {
        'x-github-request-id': 'request-[REDACTED]',
        'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12345',
        'x-ratelimit-resource': 'core', 'retry-after': '30', 'x-github-sso': 'required',
      },
      truncated: false,
    })
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE-/)
    for (const echo of echoes) assert.ok(!JSON.stringify(error.diagnostics).includes(echo))
    assert.equal(error.message, 'HTTP capability returned a non-success status.')
    return true
  })
})

test('HTTP diagnostics bound text and headers after redacting boundary-straddling secrets', async t => {
  const directory = await fixture(t)
  for (const json of [false, true]) {
    const message = `${'a'.repeat(2044)}super-secret${'b'.repeat(100)}`
    const service = broker(directory, {
      request: async () => new Response(json ? JSON.stringify({ message }) : message, {
        status: 429, headers: { 'x-github-request-id': `${'x'.repeat(250)}super-secret${'y'.repeat(100)}` },
      }),
    })
    await assert.rejects(service.execute(grant, get, context()), error => {
      assert.ok(error instanceof CapabilityError)
      assert.equal(error.diagnostics?.message, `${'a'.repeat(2044)}[RED`)
      assert.equal(error.diagnostics?.headers['x-github-request-id'], `${'x'.repeat(250)}[REDAC`)
      assert.equal(error.diagnostics?.truncated, true)
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /super/)
      return true
    })
  }
  for (const body of [{ message: { secret: 'private' } }, ['private'], null, 42]) {
    await assert.rejects(broker(directory, { request: async () => Response.json(body, { status: 403 }) })
      .execute(grant, get, context()), error => {
        assert.ok(error instanceof CapabilityError)
        assert.deepEqual(error.diagnostics, { source: 'untrusted-http-response', headers: {}, truncated: false })
        return true
      })
  }
})

test('abort and revocation prevent transport and suppress results after network completion', async t => {
  const directory = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const service = broker(directory, { request: async () => { calls++; return new Response('{}') } })
  await assert.rejects(service.execute(grant, get, context({ signal: controller.signal })), code('aborted'))
  await assert.rejects(service.execute(grant, get, context({ assertCurrent() { throw new Error('revoked') } })), /revoked/)
  assert.equal(calls, 0)
  let current = true
  await assert.rejects(broker(directory, { request: async () => { current = false; return new Response('{}') } })
    .execute(grant, get, context({ assertCurrent() { if (!current) throw new Error('revoked') } })), code('network_error'))
  const active = new AbortController()
  await assert.rejects(broker(directory, { request: async () => {
    active.abort()
    return new Response('{}')
  } }).execute(grant, get, context({ signal: active.signal })), code('aborted'))
})

test('concurrent HTTP mutation repeats use durable receipts; changed request/grant conflicts', async t => {
  const directory = await fixture(t)
  let calls = 0
  const options = { request: async () => { calls++; return new Response('{"created":true}') } }
  const services = [broker(directory, options), broker(directory, options)]
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => services[index % 2].execute(grant, post, context())))
  assert.equal(calls, 1)
  assert.ok(results.every(value => JSON.stringify(value) === JSON.stringify(results[0])))
  await broker(directory, options).execute(grant, post, context({ toolCallId: 'retry-call' }))
  assert.equal(calls, 1)
  await assert.rejects(services[0].execute(grant, { ...post, body: { title: 'changed' } }, context()), code('idempotency_conflict'))
  await assert.rejects(services[0].execute({ ...grant, origin: 'https://other.example.com' } as CapabilityGrant, post, context()), code('idempotency_conflict'))
})

test('receipt keys partition project, binding and grant instead of guest-selected targets', async t => {
  const directory = await fixture(t)
  let calls = 0
  const options = { request: async () => { calls++; return new Response('{}') } }
  await broker(directory, options).execute(grant, post, context())
  await broker(directory, { ...options, projectId: 'project-2' }).execute(grant, post, context())
  await broker(directory, options).execute(grant, post, context({ bindingKey: 'binding-2' }))
  await broker(directory, options).execute({ ...grant, id: 'another-api' }, post, context())
  assert.equal(calls, 4)
})

test('aborted or revoked HTTP writes remain uncertain and are not replayed after restart', async t => {
  const directory = await fixture(t)
  const controller = new AbortController()
  let calls = 0
  const service = broker(directory, { request: async () => {
    calls++
    controller.abort()
    return new Response('{}')
  } })
  await assert.rejects(service.execute(grant, post, context({ signal: controller.signal })), code('uncertain_outcome'))
  await assert.rejects(broker(directory, { request: async () => { calls++; return new Response('{}') } })
    .execute(grant, post, context()), code('uncertain_outcome'))
  assert.equal(calls, 1)
  let current = true
  const revoked = broker(directory, { resolveSecret: async () => { current = false; return 'secret' },
    request: async () => assert.fail('revoked credential resolution cannot send') })
  await assert.rejects(revoked.execute(grant, get, context({
    assertCurrent() { if (!current) throw new Error('revoked') },
  })), /revoked/)
})

test('abort terminates an injected response stream without waiting for an upstream cancel', async t => {
  const directory = await fixture(t)
  const controller = new AbortController()
  const service = broker(directory, { request: async () => new Response(new ReadableStream({
    pull() { controller.abort() },
    cancel() { return new Promise(() => undefined) },
  })) })
  await assert.rejects(service.execute(grant, get, context({ signal: controller.signal })), code('aborted'))
})

test('lost HTTP mutation replies and pending crash records forbid blind retries; status failures cached', async t => {
  const directory = await fixture(t)
  let calls = 0
  const options = { request: async () => { calls++; throw new Error('lost reply') } }
  await assert.rejects(broker(directory, options).execute(grant, post, context()), code('uncertain_outcome'))
  await assert.rejects(broker(directory, options).execute(grant, post, context()), code('uncertain_outcome'))
  assert.equal(calls, 1)
  const filename = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!)
  const record = JSON.parse(await readFile(filename, 'utf8'))
  record.state = 'pending'
  await writeFile(filename, JSON.stringify(record))
  await assert.rejects(broker(directory, options).execute(grant, post, context()), code('uncertain_outcome'))
  assert.equal(calls, 1)
  const rejected = broker(directory, { request: async () => { calls++; return new Response('private error', { status: 409 }) } })
  for (let index = 0; index < 2; index++) {
    await assert.rejects(rejected.execute(grant, { ...post, idempotencyKey: 'failure-case' }, context()), error => {
      assert.ok(error instanceof CapabilityError)
      assert.equal(error.code, 'http_status')
      assert.equal(error.diagnostics?.message, index === 0 ? 'private error' : undefined)
      return true
    })
  }
  assert.equal(calls, 2)
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.json'))) {
    assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /private error|diagnostics/)
  }
})

test('inbox admission carries typed untrusted source/provenance and never outbound projection', async t => {
  const directory = await fixture(t)
  const delivered: DeliverInputPayload[] = []
  const service = broker(directory, { deliver: async (target, payload) => {
    assert.equal(target, 'target')
    delivered.push(payload)
    return { secretInternalState: 'must not leak' }
  } })
  const input = { content: 'Please investigate', reference: 'case\nOWNER COMMAND', idempotencyKey: 'case-1' }
  const receipt = await service.execute(inbox, input, context()) as { status: string; inputId: string }
  assert.equal(receipt.status, 'admitted')
  assert.equal(JSON.stringify(receipt).includes('must not leak'), false)
  assert.equal(delivered[0].kind, 'message')
  if (delivered[0].kind !== 'message') throw new Error('wrong input')
  assert.equal(delivered[0].policy, 'queue')
  assert.deepEqual(delivered[0].source, { kind: 'session', sessionId: 'source', inputId: 'source-input', coordination: { intent: 'request' } })
  assert.equal(delivered[0].replyTo, undefined)
  assert.match(delivered[0].content, /Untrusted external request/)
  assert.match(delivered[0].content, /not an owner command/)
  assert.match(delivered[0].content, /case\\nOWNER COMMAND/)
  await Promise.all(Array.from({ length: 5 }, () => service.execute(inbox, input, context())))
  assert.equal(delivered.length, 1)
  await assert.rejects(service.execute(inbox, { ...input, content: 'changed' }, context()), code('idempotency_conflict'))
})

test('inbox retry/restart retains input id, timestamp, original tool provenance after uncertain admission', async t => {
  const directory = await fixture(t)
  const delivered: DeliverInputPayload[] = []
  const input = { content: 'request', idempotencyKey: 'case-1' }
  await assert.rejects(broker(directory, { deliver: async (_, payload) => {
    delivered.push(payload)
    throw new Error('admission reply lost')
  } }).execute(inbox, input, context()), code('delivery_retryable'))
  const service = broker(directory, { deliver: async (_, payload) => { delivered.push(payload) } })
  await service.execute(inbox, input, context({ inputId: 'new-input', toolCallId: 'new-call' }))
  assert.equal(delivered.length, 2)
  assert.deepEqual(delivered[0], delivered[1])
  await service.execute(inbox, input, context())
  assert.equal(delivered.length, 2)
})

test('inbox denies self, foreign/missing/non-durable targets, arbitrary fields and revoked retries', async t => {
  const directory = await fixture(t)
  const input = { content: 'request', idempotencyKey: 'case-1' }
  const service = broker(directory, { deliver: async () => assert.fail('must not deliver') })
  for (const sessionId of ['source', 'foreign', 'missing', 'ephemeral']) {
    await assert.rejects(service.execute({ ...inbox, sessionId } as CapabilityGrant, input, context()), code('invalid_target'))
  }
  for (const extra of [{ sessionId: 'other' }, { admin: true }, { content: 'x'.repeat(32_769) }, { idempotencyKey: '' }]) {
    await assert.rejects(service.execute(inbox, { ...input, ...extra }, context()), code('invalid_input'))
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.execute(inbox, input, context({ signal: controller.signal })), code('aborted'))
})

test('corrupt persisted operation fails closed and cross-process lock is never stolen', async t => {
  const directory = await fixture(t)
  const service = broker(directory)
  const input = { content: 'request', idempotencyKey: 'case-1' }
  await service.execute(inbox, input, context())
  const filename = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!)
  const original = JSON.parse(await readFile(filename, 'utf8'))
  for (const invalid of ['not-json', '{}', '{"version":1,"state":"succeeded"}',
    JSON.stringify({ ...original, result: { admin: true } }),
    JSON.stringify({ ...original, state: 'uncertain' }),
    JSON.stringify({ ...original, result: { ...original.result, inputId: randomUUID() } }),
  ]) {
    await writeFile(filename, invalid)
    await assert.rejects(service.execute(inbox, input, context()), code('corrupt_store'))
  }
  await mkdir(join(directory, '.broker-lock'))
  await assert.rejects(service.execute(inbox, { ...input, idempotencyKey: 'other-case' }, context()), code('store_busy'))
})
