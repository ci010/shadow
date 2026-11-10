import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { EventEmitter } from 'node:events'
import { requestDiagnostic } from './request-diagnostic.ts'
import { diagnosticEndpoint, diagnosticId } from '../runtime/api-request-diagnostic.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'

test('endpoint labels and correlation IDs reject private or arbitrary input', () => {
  assert.equal(diagnosticEndpoint('/projects/private/api/sessions/private/details'), 'sessions/:id/details')
  assert.equal(diagnosticEndpoint('/api/sessions/private/prompt'), undefined)
  assert.equal(diagnosticId('private-secret'), undefined)
})

test('transport observes completion/early-close without reading streams, binds Project and cleans listeners', async () => {
  for (const completion of ['finish', 'close']) {
    const scope = createProjectScope('fixture')
    const rows: string[] = []
    let time = 0
    const app = new Hono()
    app.use('*', (_c, next) => scope.run(next))
    app.use('*', requestDiagnostic(message => {
      assert.equal(getProjectScope()?.projectId, 'fixture')
      rows.push(message)
    }, () => time))
    app.get('/api/sessions/graph', c => c.json({ private: 'never-record' }))
    const outgoing = Object.assign(new EventEmitter(), { headersSent: true, statusCode: 200, writableFinished: completion === 'finish' })
    const response = await app.request('/api/sessions/graph?secret=never-record', {}, { outgoing })
    assert.ok(diagnosticId(response.headers.get('X-Shadow-Request-Id')))
    time = 16000
    outgoing.emit(completion)
    outgoing.emit('close')
    assert.equal(rows.length, 1)
    assert.match(rows[0]!, completion === 'finish' ? /"completion":"finish"/ : /"completion":"early-close"/)
    assert.match(rows[0]!, /"elapsedMs":16000/)
    assert.doesNotMatch(rows[0]!, /never-record|secret|private/)
    assert.equal(outgoing.listenerCount('finish') + outgoing.listenerCount('close'), 0)
    scope.close()
  }
})


test('fast native HTTP200 completion survives runtime log redaction and exposes ID to an allowed renderer', async () => {
  const { serveGateway, registerGatewayRoutes } = await import('./server.ts')
  const rows: string[] = []
  const app = new Hono()
  registerGatewayRoutes(app, [gateway => {
    gateway.use('*', requestDiagnostic(message => rows.push(message)))
    gateway.get('/api/sessions/missing/details', c => c.json({ value: 'private' }))
  }], { launchCredential: 'fixture', allowedOrigins: ['http://renderer.test'] })
  const server = serveGateway(app, { port: 0, host: '127.0.0.1' })
  try {
    await server.ready
    const response = await fetch(`http://127.0.0.1:${server.addr.port}/api/sessions/missing/details`, { headers: { authorization: 'Bearer fixture', origin: 'http://renderer.test' } })
    await response.text()
    const id = diagnosticId(response.headers.get('X-Shadow-Request-Id'))
    assert.ok(id)
    assert.match(response.headers.get('Access-Control-Expose-Headers')!, /X-Shadow-Request-Id/)
    assert.equal(rows.length, 1)
    assert.match(rows[0]!, new RegExp(id))
    assert.match(rows[0]!, /"completion":"finish"/)
    assert.match(rows[0]!, /"status":200/)
    assert.doesNotMatch(rows[0]!, /private|missing|fixture/)
    const { RuntimeDiagnosticLog, redactRuntimeText } = await import('../runtime/diagnostic-log.ts')
    const { createRuntimeHandler } = await import('../vfs/runtime.ts')
    assert.equal(redactRuntimeText(rows[0]!), rows[0])
    const reader = createRuntimeHandler(new RuntimeDiagnosticLog(), 'a', () => {}, () => [{
      id: 1, time: Date.now(), severity: 13, body: JSON.stringify({ stringValue: rows[0] }),
      resource: JSON.stringify({ attributes: [{ key: 'project.id', value: { stringValue: 'a' } }] }),
    }])
    const retained = await reader.read('logs', { projectId: 'a', sessionId: 'fixture', signal: new AbortController().signal } as any)
    assert.equal(JSON.parse(String(retained)).message, rows[0])
    assert.match(String(retained), new RegExp(id))
  } finally { await server.shutdown() }
})


test('fast success remains observable and transport warning volume is bounded per Project middleware', async () => {
  const rows: string[] = []
  let time = 0
  const app = new Hono()
  app.use('*', requestDiagnostic(message => rows.push(message), () => time))
  app.get('/api/sessions/graph', c => c.json({}))
  app.get('/api/sessions/missing/details', c => c.json({}, 404))
  const complete = async (path: string) => {
    const outgoing = Object.assign(new EventEmitter(), { headersSent: true, statusCode: path.endsWith('graph') ? 200 : 404, writableFinished: true })
    await app.request(path, {}, { outgoing })
    outgoing.emit('finish')
  }
  await complete('/api/sessions/graph')
  assert.equal(rows.length, 1)
  assert.match(rows[0]!, /"status":200/)
  assert.match(rows[0]!, /"completion":"finish"/)
  assert.match(rows[0]!, /"elapsedMs":0/)
  for (let i = 0; i < 125; i++) await complete('/api/sessions/missing/details')
  assert.equal(rows.length, 120)
  time = 60000
  await complete('/api/sessions/missing/details')
  assert.equal(rows.length, 121)
})
