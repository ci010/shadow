import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from './web.ts'
import { UserPresence } from '../sessions/presence.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

test('presence uses authenticated chat principal, rejects arbitrary user identity and unauthorized reports', async () => {
  const presence = new UserPresence()
  let authorized = false
  const web = new WebChannel(new Bus(), { authorize: () => authorized, sessionManager: { presence } as SessionManager })
  const app = new Hono()
  await web.start(app)
  const report = { clientId: randomUUID(), visible: true, focused: true, interactionAgeMs: 0, system: null }
  const send = (body: unknown) => app.request('/api/chat/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await send(report)).status, 401)
    assert.equal(presence.state('web:web-user'), 'unknown')
    authorized = true
    assert.equal((await send({ ...report, userId: 'victim' })).status, 400)
    assert.equal(presence.state('victim'), 'unknown')
    assert.equal((await send(report)).status, 200)
    assert.equal(presence.state('web:web-user'), 'active')
    assert.equal(presence.state('victim'), 'unknown')
  } finally { await web.stop() }
})

test('chat allowFrom applies equally to presence; authentication alone does not bypass channel authorization', async () => {
  const presence = new UserPresence()
  const web = new WebChannel(new Bus(), { authorize: () => true, allowFrom: ['not-the-owner'], sessionManager: { presence } as SessionManager })
  const app = new Hono()
  await web.start(app)
  try {
    assert.equal((await app.request('/api/chat/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: randomUUID(), visible: true, focused: true, interactionAgeMs: 0, system: null }) })).status, 403)
    assert.equal(presence.state('web:web-user'), 'unknown')
  } finally { await web.stop() }
})
