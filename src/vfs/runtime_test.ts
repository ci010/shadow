import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeDiagnosticLog } from '../runtime/diagnostic-log.ts'
import { createProjectScope } from '../projects/scope.ts'
import { createRuntimeHandler } from './runtime.ts'
import { VirtualFs } from './virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { requireToolText } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ProviderSetup } from '../providers/setup.ts'
import { ConfigSchema } from '../config/schema.ts'
import { ConfigStore } from '../config/store.ts'

const context = { projectId: 'p', sessionId: 'web:root', signal: new AbortController().signal } as ExecutionContext

test('runtime diagnostics are instance bounded, allowlisted and project isolated', () => {
  const log = new RuntimeDiagnosticLog()
  assert.match(log.read('p'), /No retained/)
  log.providerReadiness('secret-provider\nmalicious', 401, 'invalid_credentials')
  createProjectScope('foreign').run(() => log.providerReadiness('agnes', 403, 'permission_denied'))
  const content = log.read('p')
  assert.match(content, /custom/)
  assert.doesNotMatch(content, /secret|malicious|403/)
  assert.match(log.read('foreign'), /403/)
  for (let i = 0; i < 250; i++) log.providerReadiness('agnes', 200, 'ready')
  assert.equal(log.read('p').split('\n').length, 200)
  assert.match(new RuntimeDiagnosticLog().read('p'), /No retained/)
})

test('runtime VFS discoverability, paging, scope and read-only boundaries', async () => {
  const log = new RuntimeDiagnosticLog()
  log.providerReadiness('agnes', 401, 'invalid_credentials')
  log.providerReadiness('agnes', 403, 'permission_denied')
  const handlers = createRuntimeHandler(log, 'p', (_project, actor) => { if (actor !== 'web:root') throw new Error('Invalid actor') })
  const vfs = new VirtualFs()
  vfs.mount('v:runtime', 'Diagnostics', handlers.read, handlers.list)
  const listed = await new SearchTool('.', undefined, vfs).execute({ space: 'glob:v:runtime', query: '**' }, context)
  assert.match(String(listed), /v:runtime\/logs/)
  const page = requireToolText(await new ReadTool('.', vfs).execute({ path: 'v:runtime/logs', offset: 2, limit: 1 }, context))
  assert.match(page, /403/)
  assert.doesNotMatch(page, /401/)
  assert.throws(() => handlers.read('logs', { ...context, projectId: 'foreign' }), /current Project/)
  assert.throws(() => handlers.list({ ...context, sessionId: 'foreign' }), /Invalid actor/)
  for (const path of ['logs/../../file', '../logs', 'C:/secret', 'logs?path=x']) assert.throws(() => handlers.read(path, context), /Unknown/)
  assert.throws(() => vfs.write('v:runtime/logs', { content: 'x' }, context), /read-only/)
})

test('provider readiness captures Agnes HTTP categories without keys, URLs, headers or bodies', async () => {
  for (const status of [200, 401, 403, 404, 405, 500]) {
    const log = new RuntimeDiagnosticLog()
    const config = ConfigSchema.parse({ agent: { model: 'model-secret@agnes' }, providers: { agnes: { apiKey: 'synthetic-key-secret', baseUrl: 'https://private-host.invalid/private-path-secret' } } })
    const setup = new ProviderSetup({ diagnostics: log, getConfig: () => config, store: {} as ConfigStore, fetch: (async () => new Response('private-body-secret', { status })) as typeof fetch })
    try {
      const result = await setup.status()
      const event = JSON.parse(log.read('p'))
      assert.equal(event.httpStatus, status)
      assert.equal(event.result, result.ready ? 'ready' : result.reason)
      assert.equal(event.method, 'GET')
      assert.equal(event.endpoint, '/models')
      assert.doesNotMatch(log.read('p'), /secret|private|authorization/i)
      await setup.status()
      assert.equal(log.read('p').split('\n').length, 1)
    } finally { await setup.dispose() }
  }
})

test('network errors omit exception messages and do not fabricate HTTP status', async () => {
  const log = new RuntimeDiagnosticLog()
  const config = ConfigSchema.parse({ agent: { model: 'fixture@agnes' }, providers: { agnes: { apiKey: 'synthetic-key' } } })
  const setup = new ProviderSetup({ diagnostics: log, getConfig: () => config, store: {} as ConfigStore, fetch: (async () => { throw new Error('secret-url-and-key') }) as typeof fetch })
  try {
    assert.equal((await setup.status()).reason, 'network_error')
    const event = JSON.parse(log.read('p'))
    assert.equal(event.result, 'network_error')
    assert.equal(event.httpStatus, undefined)
    assert.doesNotMatch(log.read('p'), /secret/)
  } finally { await setup.dispose() }
})


test('general logs reuse the UI telemetry collector with current-runtime and project isolation', async () => {
  const { OtelStore } = await import('../otel/store.ts')
  const { initializeNodeTelemetry } = await import('../otel/runtime.ts')
  const { activeSpan } = await import('../otel/tracing.ts')
  const store = new OtelStore(':memory:')
  const other = new OtelStore(':memory:')
  const host = new OtelStore(':memory:')
  const ingest = (message: string) => store.ingestLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), severityNumber: 9, body: { stringValue: message },
  }] }] }] })
  ingest('historic-generation-private')
  const startId = store.getLatestLogId()
  const scope = createProjectScope('p')
  const foreign = createProjectScope('foreign')
  const original = console.error
  const telemetry = initializeNodeTelemetry(store, { scope })
  const otherTelemetry = initializeNodeTelemetry(other, { scope: foreign })
  const hostTelemetry = initializeNodeTelemetry(host)
  const diagnostics = new RuntimeDiagnosticLog()
  const handlers = createRuntimeHandler(diagnostics, 'p', () => {}, () => store.queryLogs({ afterId: startId, limit: 200 }))
  try {
    scope.run(() => activeSpan('diagnostic-general-test', () => {
      console.info('[scheduler] General runtime task started')
      console.error('[scheduler] General runtime failed', new Error('synthetic failure context'))
    }))
    foreign.run(() => console.warn('foreign-project-private'))
    console.info('unscoped-host-private')
    const exported = String(handlers.read('logs', context))
    const rows = exported.split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].level, 'info')
    assert.equal(rows[1].level, 'error')
    assert.equal(rows[1].source, 'shadow-console')
    assert.match(rows[1].message, /Error: synthetic failure context/)
    assert.match(rows[1].message, /at /)
    assert.match(rows[1].traceId, /^[a-f0-9]{32}$/)
    assert.doesNotMatch(exported, /historic-generation-private|foreign-project-private|unscoped-host-private/)
    // General rows use the original UI store, not a parallel logger/ring.
    assert.equal(store.queryLogs().length, 3)
    for (let i = 0; i < 240; i++) ingest(`bounded-${i}`)
    const bounded = String(handlers.read('logs', context))
    assert.equal(bounded.split('\n').length, 200)
    assert.doesNotMatch(bounded, /bounded-0"/)
    assert.match(bounded, /bounded-239/)
    const controller = new AbortController()
    controller.abort()
    assert.throws(() => handlers.read('logs', { ...context, signal: controller.signal }))
  } finally {
    await telemetry.shutdown()
    await otherTelemetry.shutdown()
    await hostTelemetry.shutdown()
    store.close(); other.close(); host.close()
  }
  assert.equal(console.error, original)
})

test('general log export omits secrets, HTTP bodies/headers, arbitrary attributes and foreign claims', async () => {
  const { projectRuntimeRows, redactRuntimeText } = await import('../runtime/diagnostic-log.ts')
  const privateValues = [
    'apiKey: "synthetic-private-key"', 'API_KEY=synthetic-private-key', '--api-key synthetic-private-key',
    'Authorization: Bearer synthetic-private-key', 'Proxy-Authorization: Basic synthetic-private-key',
    'password=synthetic-private-key', 'client_secret: synthetic-private-key', 'accessToken: synthetic-private-key',
    'GITHUB_TOKEN=synthetic-private-key', 'serviceToken: synthetic-private-key',
    "curl --data-raw 'synthetic-private-key'", "curl -H 'X-Custom: synthetic-private-key'",
    'Cookie: synthetic-private-key', 'Set-Cookie: synthetic-private-key',
    'headers: { innocuous: "synthetic-private-key" }',
    'requestBody: { text: "synthetic-private-key" }', 'response_body: synthetic-private-key',
    'body: { data: "synthetic-private-key" }', 'payload: "synthetic-private-key"',
    'messages: [{ content: "synthetic-private-key" }]',
    'Error: invalid credentials\nAuthorization: synthetic-private-key\nrequest_body: other-private-data',
    'Failed https://user:synthetic-private-key@private.invalid/path?api_key=synthetic-private-key#fragment',
    'Failed https://user:synthetic-private-key@private.invalid/path?innocent=synthetic-private-key',
  ]
  for (const message of privateValues) assert.doesNotMatch(redactRuntimeText(message), /synthetic-private-key|other-private-data|private\.invalid/, message)
  const row = { id: 1, time: Date.now(), severity: 17, body: JSON.stringify({ stringValue: 'ordinary failure' }),
    scope: JSON.stringify({ name: 'worker' }), attributes: 'arbitrary-private-attributes',
    resource: JSON.stringify({ attributes: [{ key: 'project.id', value: { stringValue: 'p' } }, { key: 'secret', value: { stringValue: 'arbitrary-private-resource' } }] }),
  }
  assert.doesNotMatch(JSON.stringify(projectRuntimeRows([row], 'p')), /arbitrary-private/)
  assert.equal(projectRuntimeRows([row], 'foreign').length, 0)
  const structured = projectRuntimeRows([{ ...row, body: JSON.stringify({ kvlistValue: { values: [{ key: 'data', value: { stringValue: 'private-body' } }] } }) }], 'p')
  assert.doesNotMatch(JSON.stringify(structured), /private-body/)
  assert.match(String(structured[0].message), /REDACTED/)
  assert.equal(redactRuntimeText('x'.repeat(10000)).length, 4096)
  assert.deepEqual(projectRuntimeRows([{ ...row, id: 'private-id' }, { ...row, time: Infinity }, null], 'p'), [])
})
