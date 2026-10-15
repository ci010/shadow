import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { registerComputerRoutes } from './routes.ts'
import { fixture, frame, owner } from './testing/fixture.ts'
import { ComputerError } from '../execution/computer/contracts.ts'

test('computer owner routes validate scope, strict decisions, body bounds and exact request IDs', async t => {
  const f = await fixture(t)
  const app = new Hono()
  registerComputerRoutes(app, {
    service: f.service, projectId: owner.projectId,
    authorize: request => request.headers.get('x-fixture-owner') === 'yes',
    assertSession: id => { if (id !== owner.sessionId) throw new ComputerError('invalid_session', 'Wrong fixture session', 403) },
  })

  const url = `/api/computer/${encodeURIComponent(owner.sessionId)}`
  const request = (path: string, body?: unknown, authorized = true) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { 'x-fixture-owner': 'yes' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.equal((await request(url, undefined, false)).status, 401)
  assert.equal((await request(`${url}/share`, { windowId: f.desktop.window.id }, false)).status, 401)
  assert.equal((await request('/api/computer/web%3Aforeign')).status, 403)
  const status = await request(url)
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.equal((await status.json()).grant.target.id, f.desktop.target.id)
  const execution = f.service.act(owner, f.input(), f.signal)
  const id = f.service.status(owner).pending!.id
  assert.equal((await request(`${url}/decisions/${id}`, { approved: true, action: { kind: 'invoke' } })).status, 400)
  assert.equal((await request(`${url}/decisions/${id}`, { approved: 'true' })).status, 400)
  assert.equal((await request(`${url}/decisions/${id}`, { approved: true, extra: 'x'.repeat(5000) })).status, 413)
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
  assert.equal((await request(`${url}/decisions/${id}`, { approved: true })).status, 200)
  await execution
  assert.equal((await request(`${url}/decisions/${id}`, { approved: true })).status, 409)
  assert.equal((await request('/api/computer/stop', {})).status, 200)
  assert.equal(f.service.status(owner).grant, null)
})

test('foreground opt-in is strict and review PNGs are scoped, transient and never publicly cacheable', async t => {
  const f = await fixture(t)
  await f.service.stopAll()
  const app = new Hono()
  registerComputerRoutes(app, {
    service: f.service, projectId: owner.projectId,
    authorize: request => request.headers.get('x-fixture-owner') === 'yes',
    assertSession: id => { if (id !== owner.sessionId) throw new ComputerError('invalid_session', 'Wrong fixture session', 403) },
  })
  const url = `/api/computer/${encodeURIComponent(owner.sessionId)}`
  const request = (path: string, body?: unknown, authorized = true) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { 'x-fixture-owner': 'yes' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  await request(`${url}/windows`, {})
  assert.equal((await request(`${url}/share`, { windowId: f.desktop.window.id, foregroundInput: 'yes' })).status, 400)
  assert.equal((await request(`${url}/share`, { windowId: f.desktop.window.id, foregroundInput: true })).status, 200)
  assert.equal(f.service.status(owner).grant?.foregroundInput, true)
  f.desktop.observation.screenshot = frame
  await f.service.observe(owner, f.desktop.target.id, true, f.signal)
  const execution = f.service.act(owner, { ...f.input(), action: { kind: 'move', x: 0, y: 0 } }, f.signal)
  const id = f.service.status(owner).pending!.id
  const path = `${url}/decisions/${id}/frame`
  assert.equal((await request(path, undefined, false)).status, 401)
  assert.equal((await request(`/api/computer/web%3Aforeign/decisions/${id}/frame`)).status, 403)
  assert.equal((await request(`${url}/decisions/${crypto.randomUUID()}/frame`)).status, 404)
  const response = await request(path)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(frame.base64, 'base64'))
  await request(`${url}/decisions/${id}`, { approved: false })
  await execution
  assert.equal((await request(path)).status, 404)
})
