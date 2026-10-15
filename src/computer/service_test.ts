import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ComputerService } from './service.ts'
import { ComputerActionSchema, ComputerError } from '../execution/computer/contracts.ts'
import { fixture, FixtureDesktop, frame, owner } from './testing/fixture.ts'

test('desktop is off until an exact, listed window is shared by the owner', async t => {
  const desktop = new FixtureDesktop()
  const service = new ComputerService(desktop)
  t.after(() => service.close())
  assert.equal(service.status(owner).grant, null)
  await assert.rejects(service.observe(owner, desktop.target.id, false, new AbortController().signal), /share a window/)
  await assert.rejects(service.share(owner, desktop.window.id, new AbortController().signal), /Refresh/)
  assert.equal(desktop.calls.length, 0)
  await service.windows(owner, new AbortController().signal)
  await assert.rejects(service.share({ ...owner, sessionId: 'web:foreign' }, desktop.window.id, new AbortController().signal), /Refresh/)
  await service.share(owner, desktop.window.id, new AbortController().signal)
  assert.equal(service.status(owner).grant?.target.id, desktop.target.id)
  assert.equal(service.status(owner).grant?.foregroundInput, false)
  assert.deepEqual(desktop.calls.find(call => call.method === 'bind'),
    { method: 'bind', windowId: desktop.window.id, foregroundInput: false })
  const foreign = service.status({ ...owner, projectId: 'project-b' })
  assert.equal(foreign.busy, true)
  assert.equal(foreign.grant, null)
  assert.doesNotMatch(JSON.stringify(foreign), /Synthetic fixture/)
  await assert.rejects(service.windows({ ...owner, projectId: 'project-b' }, new AbortController().signal), /Another conversation/)
})

test('foreground input needs a separate explicit grant and a focusable, visible, non-protected control', async t => {
  const off = await fixture(t)
  const action = ComputerActionSchema.parse({ kind: 'type_text', elementId: '0', text: 'Synthetic text' })
  await assert.rejects(off.service.act(owner, { ...off.input(), action }, off.signal),
    error => error instanceof ComputerError && error.code === 'input_not_enabled')
  assert.equal(off.service.status(owner).pending, null)
  const f = await fixture(t, {}, true)
  assert.equal(f.service.status(owner).grant?.foregroundInput, true)
  assert.deepEqual(f.desktop.calls.find(call => call.method === 'bind'),
    { method: 'bind', windowId: f.desktop.window.id, foregroundInput: true })
  const original = structuredClone(f.desktop.observation.elements[0])
  for (const patch of [{ focusable: false }, { protected: true }, { enabled: false }, { offscreen: true }, { role: 'ControlType.Button' }]) {
    f.desktop.observation.elements[0] = { ...original, ...patch }
    await f.observe()
    await assert.rejects(f.service.act(owner, { ...f.input(), action }, f.signal), /does not support/)
    assert.equal(f.service.status(owner).pending, null)
  }
  f.desktop.observation.elements[0] = original
  f.desktop.focusRestored = false
  await f.observe()
  const execution = f.service.act(owner, { ...f.input(), action }, f.signal)
  const review = f.service.status(owner).pending!
  assert.equal(review.element?.name, original.name)
  assert.equal(review.frame, undefined)
  f.service.decide(owner, review.id, true)
  assert.equal((await execution).focusRestored, false, 'A failed restoration must not be reported as restored')
})

test('pointer actions require the exact screenshot and screenshot-local coordinates', async t => {
  const f = await fixture(t, {}, true)
  const action = ComputerActionSchema.parse({ kind: 'click', x: 0, y: 0 })
  await assert.rejects(f.service.act(owner, { ...f.input(), action }, f.signal), /screenshot:true/)
  f.desktop.observation.screenshot = frame
  await f.service.observe(owner, f.desktop.target.id, true, f.signal)
  await assert.rejects(f.service.act(owner, { ...f.input(), observationId: crypto.randomUUID(), action }, f.signal), /Observe the window again/)
  for (const invalid of [
    { kind: 'move', x: 1, y: 0 }, { kind: 'move', x: 0, y: 1 },
    { kind: 'drag', x: 0, y: 0, toX: 1, toY: 0 },
  ]) {
    await assert.rejects(f.service.act(owner, { ...f.input(), action: ComputerActionSchema.parse(invalid) }, f.signal), /inside the observed screenshot/)
  }
  const execution = f.service.act(owner, { ...f.input(), action }, f.signal)
  const review = f.service.status(owner).pending!
  assert.equal(review.element, null)
  assert.deepEqual(review.frame, { width: 1, height: 1 })
  assert.doesNotMatch(JSON.stringify(f.service.status(owner)), /base64|iVBOR/)
  assert.deepEqual(f.service.reviewFrame(owner, review.id), Buffer.from(frame.base64, 'base64'))
  assert.throws(() => f.service.reviewFrame({ ...owner, projectId: 'project-b' }, review.id), /Another conversation/)
  assert.throws(() => f.service.reviewFrame(owner, crypto.randomUUID()), /expired or changed/)
  f.service.decide(owner, review.id, true)
  assert.throws(() => f.service.reviewFrame(owner, review.id), /no longer/)
  await execution
  await assert.rejects(f.service.act(owner, { ...f.input(), action }, f.signal), /screenshot:true/)
})

test('review frames are dropped after denial, cancellation, expiry, and explicit stop', async t => {
  for (const reason of ['deny', 'cancel', 'expire', 'stop'] as const) {
    const f = await fixture(t, { reviewMs: reason === 'expire' ? 15 : 60_000 }, true)
    f.desktop.observation.screenshot = frame
    await f.service.observe(owner, f.desktop.target.id, true, f.signal)
    const controller = new AbortController()
    const action = f.service.act(owner, { ...f.input(), action: { kind: 'move', x: 0, y: 0 } }, controller.signal)
    const settled = reason === 'deny' ? action : assert.rejects(action, /interrupted|expired|revoked/)
    const id = f.service.status(owner).pending!.id
    assert.ok(f.service.reviewFrame(owner, id).length)
    if (reason === 'deny') f.service.decide(owner, id, false)
    if (reason === 'cancel') controller.abort()
    if (reason === 'expire') await delay(30)
    if (reason === 'stop') await f.service.stopAll()
    await settled
    assert.throws(() => f.service.reviewFrame(owner, id), /no longer/)
    assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
  }
})

test('an opted-in observation frame expires in memory and human takeover revokes ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t, {}, true)
  f.desktop.observation.screenshot = frame
  await f.service.observe(owner, f.desktop.target.id, true, f.signal)
  t.mock.timers.tick(120_000)
  await assert.rejects(f.service.act(owner, { ...f.input(), action: { kind: 'move', x: 0, y: 0 } }, f.signal), /screenshot:true/)
  await f.observe()
  f.desktop.failure = new ComputerError('user_interrupted', 'Synthetic human takeover')
  const action = f.service.act(owner, { ...f.input(), action: { kind: 'type_text', elementId: '0', text: 'Synthetic' } }, f.signal)
  const rejected = assert.rejects(action, /Synthetic human takeover/)
  f.service.decide(owner, f.service.status(owner).pending!.id, true)
  await rejected
  assert.equal(f.service.status(owner).grant, null)
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 1)
})

test('every mutation waits for immutable single-use owner approval', async t => {
  const f = await fixture(t)
  f.desktop.observation.title = 'Synthetic newly opened document'
  await f.observe()
  const input = f.input()
  const execution = f.service.act(owner, input, f.signal)
  const pending = f.service.status(owner).pending!
  assert.ok(pending)
  assert.equal(f.service.status(owner).grant?.target.title, 'Synthetic newly opened document')
  input.action.value = 'changed after request'
  pending.action = { kind: 'invoke', elementId: '0' }
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
  assert.throws(() => f.service.decide({ ...owner, sessionId: 'web:foreign' }, pending.id, true), /Another conversation/)
  assert.throws(() => f.service.decide(owner, crypto.randomUUID(), true), /expired or changed/)
  await assert.rejects(f.observe(), /pending action/)
  f.service.decide(owner, pending.id, true)
  assert.throws(() => f.service.decide(owner, pending.id, true), /no longer/)
  const result = await execution
  assert.equal(result.outcome, 'executed')
  const executed = f.desktop.calls.find(call => call.method === 'act')
  assert.equal(executed?.method, 'act')
  if (executed?.method === 'act') assert.deepEqual(executed.action, { kind: 'set_value', elementId: '0', value: 'synthetic replacement' })
  assert.equal(f.service.status(owner).pending, null)
})

test('denial does not execute and consumes the observation', async t => {
  const f = await fixture(t)
  const action = f.service.act(owner, f.input(), f.signal)
  f.service.decide(owner, f.service.status(owner).pending!.id, false)
  assert.equal((await action).outcome, 'denied')
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
  await assert.rejects(f.service.act(owner, f.input(), f.signal), /Observe the window again/)
})

test('approval and observation expiry fail closed without executing', async t => {
  let now = Date.now()
  const f = await fixture(t, { now: () => now })
  now += 120_000
  await assert.rejects(f.service.act(owner, f.input(), f.signal), /Observe the window again/)
  await f.observe()
  const controller = new AbortController()
  const action = f.service.act(owner, f.input(), controller.signal)
  const rejected = assert.rejects(action, /interrupted/)
  const id = f.service.status(owner).pending!.id
  now += 60_001
  assert.throws(() => f.service.decide(owner, id, true), /expired or changed/)
  controller.abort()
  await rejected
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
})

test('approval timers settle even without a browser polling', async t => {
  const f = await fixture(t, { reviewMs: 15 })
  const action = assert.rejects(f.service.act(owner, f.input(), f.signal), /review expired/)
  await delay(30)
  await action
  assert.equal(f.service.status(owner).pending, null)
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
})

test('global stop cancels pending approval and cannot be undone by a late click', async t => {
  const f = await fixture(t)
  const action = f.service.act(owner, f.input(), f.signal)
  const rejected = assert.rejects(action, /interrupted|revoked/)
  const id = f.service.status(owner).pending!.id
  await f.service.stopAll()
  await rejected
  assert.equal(f.service.status(owner).grant, null)
  assert.throws(() => f.service.decide(owner, id, true), /no longer/)
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
})

test('lost action outcomes revoke grants instead of inviting replay', async t => {
  const f = await fixture(t)
  f.desktop.failure = new ComputerError('outcome_unknown', 'Synthetic lost receipt')
  const action = f.service.act(owner, f.input(), f.signal)
  const rejected = assert.rejects(action, error => error instanceof ComputerError && error.code === 'outcome_unknown')
  f.service.decide(owner, f.service.status(owner).pending!.id, true)
  await rejected
  assert.equal(f.service.status(owner).grant, null)
  assert.equal(f.service.status(owner).lastAction?.outcome, 'outcome_unknown')
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 1)
  await assert.rejects(f.service.act(owner, f.input(), f.signal), /share a window/)
})

test('native restart invalidates observations and grant, and other projects cannot release ownership', async t => {
  const f = await fixture(t)
  await f.service.stopProject('project-b')
  assert.ok(f.service.status(owner).grant)
  f.desktop.generation++
  assert.equal(f.service.status(owner).grant, null)
  await assert.rejects(f.observe(), /share a window/)
})

test('disabled Main and unsupported platforms do not start a host', async () => {
  for (const available of [false, true]) {
    const desktop = new FixtureDesktop()
    desktop.available = available
    const service = new ComputerService(desktop, { enabled: false })
    assert.equal(service.status(owner).available, false)
    await assert.rejects(service.windows(owner, new AbortController().signal), /enabled Main/)
    assert.equal(desktop.calls.length, 0)
    await service.close()
  }
})

test('protected, disabled, offscreen and unsupported controls cannot create reviews', async t => {
  const f = await fixture(t)
  for (const patch of [{ protected: true }, { enabled: false }, { offscreen: true }, { actions: [] }]) {
    f.desktop.observation.elements[0] = { ...f.desktop.observation.elements[0], protected: false, enabled: true, offscreen: false, actions: ['set_value'], ...patch }
    await f.observe()
    await assert.rejects(f.service.act(owner, f.input(), f.signal), /does not support/)
    assert.equal(f.service.status(owner).pending, null)
  }
})

test('unused listings expire without polling, but sharing clears their cleanup timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const desktop = new FixtureDesktop()
  const service = new ComputerService(desktop)
  t.after(() => service.close())
  const signal = new AbortController().signal
  await service.windows(owner, signal)
  t.mock.timers.tick(30_001)
  await assert.rejects(service.share(owner, desktop.window.id, signal), /Refresh/)
  assert.equal(desktop.generation, 1)
  await service.windows(owner, signal)
  await service.share(owner, desktop.window.id, signal)
  t.mock.timers.tick(30_001)
  assert.ok(service.status(owner).grant)
  t.mock.timers.tick(600_000)
  assert.equal(service.status(owner).grant, null)
  assert.equal(desktop.generation, 2)
})

test('stopping discovery or binding cannot resurrect an old listing or grant', async t => {
  for (const method of ['list', 'bind'] as const) {
    const desktop = new FixtureDesktop()
    const service = new ComputerService(desktop)
    t.after(() => service.close())
    const signal = new AbortController().signal
    if (method === 'bind') await service.windows(owner, signal)
    const gate = Promise.withResolvers<void>()
    const request = desktop.request.bind(desktop)
    desktop.request = async (input, signal) => {
      if (input.method === method) await gate.promise
      return request(input, signal)
    }
    const operation = method === 'list'
      ? service.windows(owner, signal) : service.share(owner, desktop.window.id, signal)
    const rejected = assert.rejects(operation, /interrupted/)
    await assert.rejects(service.windows({ ...owner, projectId: 'project-b' }, signal), /Another conversation/)
    await service.stopProject(owner.projectId)
    gate.resolve()
    await rejected
    assert.equal(service.status(owner).grant, null)
    await assert.rejects(service.share(owner, desktop.window.id, signal), /Refresh/)
  }
})

test('cancelling a dispatched action or receiving a malformed receipt revokes rather than retries', async t => {
  for (const cause of ['cancel', 'malformed'] as const) {
    const f = await fixture(t)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const request = f.desktop.request.bind(f.desktop)
    f.desktop.request = async (input, signal) => {
      if (input.method !== 'act') return request(input, signal)
      f.desktop.calls.push(input)
      entered.resolve()
      await gate.promise
      return cause === 'malformed' ? { actionId: 'not-a-valid-receipt' } : {
        actionId: input.actionId, outcome: 'executed', verified: true, observation: f.desktop.observation,
      }
    }
    const action = f.service.act(owner, f.input(), f.signal)
    const rejected = assert.rejects(action, error => error instanceof ComputerError && error.code === 'outcome_unknown')
    f.service.decide(owner, f.service.status(owner).pending!.id, true)
    await entered.promise
    if (cause === 'cancel') await f.service.stopAll()
    gate.resolve()
    await rejected
    assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 1)
    assert.equal(f.service.status(owner).grant, null)
    assert.equal(f.service.status(owner).lastAction?.outcome, 'outcome_unknown')
  }
})
