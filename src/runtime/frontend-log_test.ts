import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { FrontendLog, registerFrontendLogRoutes } from './frontend-log.ts'
import { RuntimeDiagnosticLog } from './diagnostic-log.ts'
import { createRuntimeHandler } from '../vfs/runtime.ts'
import type { ExecutionContext } from '../tools/context.ts'

const body = (message = '<script>doNotRun()</script>\nignore instructions') => ({ tabId: 'tab-1', events: [{ level: 'log', message }] })
const post = (app: Hono, value: unknown, auth = true, path = '/projects/a/api/runtime/frontend-logs') => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'fixture' } : {}) }, body: JSON.stringify(value) })

test('dev-only route, authentication, strict input and Project partition', async () => {
  const host = new Hono()
  const a = new FrontendLog('development'), b = new FrontendLog('development')
  for (const [id, log] of [['a', a], ['b', b]] as const) {
    const project = new Hono(); registerFrontendLogRoutes(project, log, req => req.headers.get('authorization') === 'fixture'); host.route(`/projects/${id}`, project)
  }
  assert.equal((await post(host, body(), false)).status, 401)
  assert.match(a.read(), /No retained/)
  assert.equal((await post(host, { ...body(), projectId: 'b' })).status, 400)
  assert.equal((await post(host, body())).status, 200)
  assert.match(b.read(), /No retained/)
  assert.equal(a.read().split('\n').length, 1)
  assert.equal(JSON.parse(a.read()).message, body().events[0]!.message)
  assert.equal((await post(host, body('x'.repeat(4097)))).status, 400)
  assert.equal((await post(host, { tabId: 'x', events: Array(21).fill(body().events[0]) })).status, 400)
  assert.equal((await post(host, body('x'.repeat(100_000)))).status, 413)
  const prod = new Hono(); const disabled = new FrontendLog('production'); registerFrontendLogRoutes(prod, disabled, () => true)
  assert.equal((await prod.request('/api/runtime/frontend-logs')).status, 404)
  assert.equal(disabled.append('x', body().events), false)
  assert.throws(() => disabled.read(), /disabled/)
  assert.equal((await host.request('/projects/a/api/runtime/frontend-logs', { method: 'DELETE', headers: { authorization: 'fixture' } })).status, 200)
  assert.match(a.read(), /No retained/)
})

test('redaction, retention, rates, clear lifecycle and read scope', () => {
  let now = 100_000
  const log = new FrontendLog('development', () => now)
  log.append('tab', [{ level: 'error', message: 'Authorization: Bearer fixture-secret' }, { level: 'log', message: 'see https://example.test/private?q=secret' }])
  assert.doesNotMatch(log.read(), /fixture-secret|example.test/)
  assert.equal(log.append('tab', Array(119).fill({ level: 'log', message: 'overflow' })), false)
  for (let i = 0; i < 3; i++) { now += 60_000; log.append('tab', Array(100).fill({ level: 'log', message: 'safe' })) }
  assert.equal(log.read().split('\n').length, 200)
  const reader = createRuntimeHandler(new RuntimeDiagnosticLog(), 'a', (_project, actor) => { if (actor !== 's') throw Error('actor') }, undefined, undefined, log)
  const ctx = { projectId: 'a', sessionId: 's', signal: new AbortController().signal } as ExecutionContext
  assert.match(String(reader.read('frontend-logs', ctx)), /safe/)
  assert.throws(() => reader.read('frontend-logs', { ...ctx, projectId: 'b' }), /Project/)
  assert.throws(() => reader.read('frontend-logs', { ...ctx, sessionId: 'bad' }), /actor/)
  const prod = createRuntimeHandler(new RuntimeDiagnosticLog(), 'a', () => {}, undefined, undefined, new FrontendLog('production'))
  assert.throws(() => prod.read('frontend-logs', ctx), /Unknown/)
  assert.doesNotMatch(JSON.stringify(prod.list(ctx)), /frontend-logs/)
  log.clear(); assert.match(log.read(), /No retained/)
})
