import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { UserPresence, watchUserWait, resolveUserWaitPolicy, type PresenceReport } from './presence.ts'
import { ToolsSchema } from '../config/schema.ts'

const report = (extra: Partial<PresenceReport> = {}): PresenceReport => ({ clientId: randomUUID(), visible: false,
  focused: false, interactionAgeMs: null, system: { idleSeconds: 300, locked: true }, ...extra })

test('macOS locked + Windows active: any fresh active client wins; users stay isolated', () => {
  const presence = new UserPresence(() => 1000)
  presence.report('alice', report())
  presence.report('bob', report())
  presence.report('alice', report({ system: { idleSeconds: 0, locked: false } }))
  assert.equal(presence.state('alice'), 'active')
  assert.equal(presence.state('bob'), 'away')
  assert.equal(presence.state('nobody'), 'unknown')
})

test('Web without actual input/capability, disconnected and stale clients are unknown, not away', () => {
  let now = 1000
  const presence = new UserPresence(() => now)
  const web = report({ system: null })
  presence.report('alice', web)
  presence.report('alice', report())
  assert.equal(presence.state('alice'), 'unknown')
  presence.report('alice', { ...web, visible: true, focused: true, interactionAgeMs: 0 })
  assert.equal(presence.state('alice'), 'active')
  now += 45_001
  assert.equal(presence.state('alice'), 'unknown')
  presence.report('alice', report())
  assert.equal(presence.state('alice'), 'unknown', 'one fresh away cannot hide another stale client')
})

test('all clients must explicitly support away; heartbeats never become input', () => {
  let now = 0
  const presence = new UserPresence(() => now)
  presence.report('alice', report())
  presence.report('alice', report({ system: { idleSeconds: 300, locked: false } }))
  assert.equal(presence.state('alice'), 'away')
  const web = report({ system: null, visible: true, focused: true, interactionAgeMs: 119_000 })
  presence.report('alice', web)
  assert.equal(presence.state('alice'), 'active')
  now += 2000
  assert.equal(presence.state('alice'), 'unknown')
  presence.report('alice', { ...web, interactionAgeMs: 121_000 })
  assert.equal(presence.state('alice'), 'unknown')
  assert.throws(() => presence.report('alice', { ...web, userId: 'bob' }))
  assert.throws(() => presence.report('alice', { ...web, interactionAgeMs: -1 }))
})

test('backend wait: continuous away grace resets on unknown/activity; fixed deadline and explicit infinite', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  let state: 'away' | 'unknown' | 'active' = 'away'
  let expired = 0
  const stop = watchUserWait({ timeoutMs: 100, awayGraceMs: 20 }, () => state, () => { expired++; stop() })
  t.mock.timers.tick(10)
  state = 'unknown'
  t.mock.timers.tick(10)
  assert.equal(expired, 0)
  state = 'away'
  t.mock.timers.tick(20)
  assert.equal(expired, 0)
  t.mock.timers.tick(20)
  assert.equal(expired, 1)
  const infinite = watchUserWait({ timeoutMs: null, awayGraceMs: 1 }, () => 'away', () => expired++)
  t.mock.timers.tick(10_000)
  assert.equal(expired, 1)
  infinite()
  const unknown = watchUserWait({ timeoutMs: 100, awayGraceMs: 1 }, () => 'unknown', () => { expired++; unknown() })
  t.mock.timers.tick(99)
  assert.equal(expired, 1)
  t.mock.timers.tick(1)
  assert.equal(expired, 2)
})

test('policy precedence preserves existing explicit infinite waits, while absent settings have finite defaults', () => {
  assert.deepEqual(resolveUserWaitPolicy(undefined, undefined), { timeoutMs: 600_000, awayGraceMs: 30_000 })
  assert.equal(resolveUserWaitPolicy(undefined, { timeoutMs: null }).timeoutMs, null)
  assert.equal(resolveUserWaitPolicy({ timeoutMs: null }, { timeoutMs: 100 }).timeoutMs, null)
  assert.equal(resolveUserWaitPolicy({ timeoutMs: 100 }, { timeoutMs: null }).timeoutMs, 100)
  assert.deepEqual(resolveUserWaitPolicy(undefined, undefined, { timeoutMs: 500, awayGraceMs: 20 }), { timeoutMs: 500, awayGraceMs: 20 })
  assert.equal(ToolsSchema.parse({ yield: {} }).yield?.timeoutMs, null)
  assert.equal(ToolsSchema.parse({}).yield, undefined)
  assert.deepEqual(ToolsSchema.parse({ unattended: {} }).unattended, { timeoutMs: 600_000, awayGraceMs: 30_000 })
  for (const value of [0, -1, 0.5, 2_147_483_648]) {
    assert.throws(() => ToolsSchema.parse({ unattended: { timeoutMs: value } }))
    assert.throws(() => ToolsSchema.parse({ unattended: { awayGraceMs: value } }))
  }
})

test('client capacity eviction cannot discard unknown evidence and manufacture all-away', () => {
  const presence = new UserPresence()
  presence.report('alice', report({ system: null }))
  for (let i = 0; i < 128; i++) presence.report('alice', report())
  assert.equal(presence.state('alice'), 'unknown')
  presence.report('alice', report({ system: { idleSeconds: 0, locked: false } }))
  assert.equal(presence.state('alice'), 'active')
})
