import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerService } from './service.ts'
import { ComputerActionSchema, ComputerError } from '../execution/computer/contracts.ts'
import { fixture, FixtureDesktop, frame, owner } from './testing/fixture.ts'

test('desktop access starts only after an exact, current listed window is selected', async t => {
  const desktop = new FixtureDesktop()
  const service = new ComputerService(desktop)
  t.after(() => service.close())
  assert.equal(service.status(owner).grant, null)
  await assert.rejects(service.observe(owner, desktop.target.id, false, new AbortController().signal), /action:connect/)
  await assert.rejects(service.share(owner, desktop.window.id, new AbortController().signal), /Refresh/)
  assert.equal(desktop.calls.length, 0)
  await service.windows(owner, new AbortController().signal)
  await assert.rejects(service.share({ ...owner, sessionId: 'web:foreign' }, desktop.window.id, new AbortController().signal), /Refresh/)
  await service.share(owner, desktop.window.id, new AbortController().signal)
  assert.equal(service.status(owner).grant?.target.id, desktop.target.id)
  assert.deepEqual(desktop.calls.find(call => call.method === 'bind'),
    { method: 'bind', windowId: desktop.window.id })
  const foreign = service.status({ ...owner, projectId: 'project-b' })
  assert.equal(foreign.busy, true)
  assert.equal(foreign.grant, null)
  assert.doesNotMatch(JSON.stringify(foreign), /Synthetic fixture/)
  await assert.rejects(service.windows({ ...owner, projectId: 'project-b' }, new AbortController().signal), /Another conversation/)
})

test('foreground input uses the selected target and requires a focusable, visible, non-protected control', async t => {
  const f = await fixture(t)
  const action = ComputerActionSchema.parse({ kind: 'type_text', elementId: '0', text: 'Synthetic text' })
  assert.deepEqual(f.desktop.calls.find(call => call.method === 'bind'),
    { method: 'bind', windowId: f.desktop.window.id })
  const original = structuredClone(f.desktop.observation.elements[0])
  for (const patch of [{ focusable: false }, { protected: true }, { enabled: false }, { offscreen: true }, { role: 'ControlType.Button' }]) {
    f.desktop.observation.elements[0] = { ...original, ...patch }
    await f.observe()
    await assert.rejects(f.service.act(owner, { ...f.input(), action }, f.signal), /does not support/)
  }
  f.desktop.observation.elements[0] = original
  f.desktop.focusRestored = false
  await f.observe()
  const execution = f.service.act(owner, { ...f.input(), action }, f.signal)
  assert.equal((await execution).focusRestored, false, 'A failed restoration must not be reported as restored')
})

test('pointer actions require the exact screenshot and screenshot-local coordinates', async t => {
  const f = await fixture(t)
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
  assert.doesNotMatch(JSON.stringify(f.service.status(owner)), /base64|iVBOR/)
  await execution
  await assert.rejects(f.service.act(owner, { ...f.input(), action }, f.signal), /screenshot:true/)
})

test('a requested observation frame expires in memory and human takeover revokes ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t)
  f.desktop.observation.screenshot = frame
  await f.service.observe(owner, f.desktop.target.id, true, f.signal)
  t.mock.timers.tick(120_000)
  await assert.rejects(f.service.act(owner, { ...f.input(), action: { kind: 'move', x: 0, y: 0 } }, f.signal), /screenshot:true/)
  await f.observe()
  f.desktop.failure = new ComputerError('user_interrupted', 'Synthetic human takeover')
  const action = f.service.act(owner, { ...f.input(), action: { kind: 'type_text', elementId: '0', text: 'Synthetic' } }, f.signal)
  const rejected = assert.rejects(action, /Synthetic human takeover/)
  await rejected
  assert.equal(f.service.status(owner).grant, null)
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 1)
})

test('lost action outcomes revoke grants instead of inviting replay', async t => {
  const f = await fixture(t)
  f.desktop.failure = new ComputerError('outcome_unknown', 'Synthetic lost receipt')
  const action = f.service.act(owner, f.input(), f.signal)
  const rejected = assert.rejects(action, error => error instanceof ComputerError && error.code === 'outcome_unknown')
  await rejected
  assert.equal(f.service.status(owner).grant, null)
  assert.equal(f.service.status(owner).lastAction?.outcome, 'outcome_unknown')
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 1)
  await assert.rejects(f.service.act(owner, f.input(), f.signal), /action:connect/)
})

test('native restart invalidates observations and grant, and other projects cannot release ownership', async t => {
  const f = await fixture(t)
  await f.service.stopProject('project-b')
  assert.ok(f.service.status(owner).grant)
  f.desktop.generation++
  assert.equal(f.service.status(owner).grant, null)
  await assert.rejects(f.observe(), /action:connect/)
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

test('protected, disabled, offscreen and unsupported controls cannot execute', async t => {
  const f = await fixture(t)
  for (const patch of [{ protected: true }, { enabled: false }, { offscreen: true }, { actions: [] }]) {
    f.desktop.observation.elements[0] = { ...f.desktop.observation.elements[0], protected: false, enabled: true, offscreen: false, actions: ['set_value'], ...patch }
    await f.observe()
    await assert.rejects(f.service.act(owner, { ...f.input(), action: { kind: 'set_value', elementId: '0', value: 'ordinary' } }, f.signal), /does not support/)
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
    await entered.promise
    if (cause === 'cancel') await f.service.stopAll()
    gate.resolve()
    await rejected
    assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 1)
    assert.equal(f.service.status(owner).grant, null)
    assert.equal(f.service.status(owner).lastAction?.outcome, 'outcome_unknown')
  }
})


test('foreground requests cannot cross targets or owners, extend the lease, or bypass validation', async t => {
  const f = await fixture(t)
  const before = f.service.status(owner)
  const input = { ...f.input(), action: { kind: 'type_text' as const, elementId: '0', text: 'ordinary text' } }
  for (const foreign of [{ ...owner, sessionId: 'web:foreign' }, { ...owner, projectId: 'foreign' }]) {
    await assert.rejects(f.service.act(foreign, input, f.signal))
  }
  await assert.rejects(f.service.act(owner, { ...input, targetId: crypto.randomUUID() }, f.signal))
  const execution = f.service.act(owner, input, f.signal)
  assert.equal(f.desktop.calls.some(call => call.method === 'act'), true)
  assert.equal(f.service.status(owner).grant?.expiresAt, before.grant?.expiresAt)
  await execution
  await f.service.release(owner)
  await assert.rejects(f.service.act(owner, input, f.signal), /action:connect/)
})


test('all five supported UIA actions execute directly without an approval protocol', async t => {
  for (const action of [
    { kind: 'invoke', elementId: '0' }, { kind: 'set_value', elementId: '0', value: 'ordinary value' },
    { kind: 'toggle', elementId: '0' }, { kind: 'select', elementId: '0' },
    { kind: 'scroll', elementId: '0', direction: 'down' },
  ] as const) {
    const f = await fixture(t)
    f.desktop.observation.elements[0].actions = ['invoke', 'set_value', 'toggle', 'select', 'scroll']
    await f.observe()
    const result = await f.service.act(owner, { ...f.input(), action }, f.signal)
    assert.equal(result.outcome, 'executed')
    const dispatched = f.desktop.calls.filter(call => call.method === 'act')
    assert.equal(dispatched.length, 1)
    assert.deepEqual(dispatched[0].action, action)
  }
})

test('connect reuses without lease renewal; selection observes; targetless actions retain exact freshness', async t => {
  const f = await fixture(t)
  const expiry = f.service.status(owner).grant!.expiresAt
  const before = f.desktop.calls.length
  const reused = await f.service.connect(owner, {}, f.signal)
  assert.equal(reused.state, 'observed')
  assert.deepEqual(f.desktop.calls.slice(before).map(c => c.method), ['observe'])
  assert.equal(f.service.status(owner).grant!.expiresAt, expiry)
  await assert.rejects(f.service.act(owner, { observationId: crypto.randomUUID(), action: { kind: 'invoke', elementId: '0' } }, f.signal), /Observe/)
  await f.service.act(owner, { observationId: f.desktop.observation.id, action: { kind: 'invoke', elementId: '0' } }, f.signal)
  await f.service.release(owner)
  const list = await f.service.connect(owner, {}, f.signal)
  assert.equal(list.state, 'needs-selection')
  assert.equal(list.observed, false)
  assert.equal(f.desktop.calls.at(-1)!.method, 'list')
  const selected = await f.service.connect(owner, { windowId: f.desktop.window.id }, f.signal)
  assert.equal(selected.state, 'observed')
  assert.deepEqual(f.desktop.calls.slice(-2).map(c => c.method), ['bind', 'observe'])
  await assert.rejects(f.service.connect({ ...owner, sessionId: 'other' }, {}, f.signal), /Another conversation/)
  await assert.rejects(f.service.connect(owner, { windowId: crypto.randomUUID() }, f.signal), /Release/)
})

test('connect reports observation failure, expiry and invalid generation without auto-selecting', async t => {
  let now = Date.now()
  const f = await fixture(t, { now: () => now })
  f.desktop.failure = new ComputerError('observation_failed', 'Synthetic observation failure')
  const failed = await f.service.connect(owner, {}, f.signal)
  assert.equal(failed.state, 'observation-failed')
  assert.equal(failed.bound, true)
  assert.equal(failed.observed, false)
  f.desktop.failure = undefined
  now += 600_001
  const expired = await f.service.connect(owner, { windowId: f.desktop.window.id }, f.signal)
  assert.equal(expired.state, 'needs-selection')
  assert.equal(expired.reason, 'lease-expired')
  assert.equal(f.service.status(owner).grant, null)
  await f.service.connect(owner, { windowId: f.desktop.window.id }, f.signal)
  f.desktop.generation++
  // A diagnostic status check must not erase the reason or resurrect the lease.
  f.service.status(owner)
  const invalid = await f.service.connect(owner, {}, f.signal)
  assert.equal(invalid.state, 'needs-selection')
  assert.equal(invalid.reason, 'target-invalid')
})

test('connect selection distinguishes bound from observed; a vanished live target returns candidates', async t => {
  const f = await fixture(t)
  await f.service.release(owner)
  await f.service.connect(owner, {}, f.signal)
  const request = f.desktop.request.bind(f.desktop)
  let failObservation = true
  let code = 'observation_failed'
  t.mock.method(f.desktop, 'request', async (input: Parameters<FixtureDesktop['request']>[0], signal: AbortSignal) => {
    if (input.method === 'observe' && failObservation) {
      failObservation = false
      throw new ComputerError(code, 'Synthetic failure')
    }
    return request(input, signal)
  })
  const failed = await f.service.connect(owner, { windowId: f.desktop.window.id }, f.signal)
  assert.equal(failed.state, 'observation-failed')
  assert.equal(failed.bound, true)
  assert.equal(failed.observed, false)
  code = 'window_unavailable'
  failObservation = true
  const invalid = await f.service.connect(owner, {}, f.signal)
  assert.equal(invalid.state, 'needs-selection')
  assert.equal(invalid.bound, false)
  assert.equal(invalid.reason, 'target-invalid')
  assert.equal(invalid.windows?.length, 1)
  assert.equal(f.service.status(owner).grant, null)
})


test('executing foreground input blocks concurrent operations; stop revokes without replay', async t => {
  const f = await fixture(t)
  const gate = Promise.withResolvers<void>()
  const original = f.desktop.request.bind(f.desktop)
  f.desktop.request = async (input, signal) => {
    if (input.method === 'act') await gate.promise
    return original(input, signal)
  }
  const running = f.service.act(owner, f.input(), f.signal)
  const rejected = assert.rejects(running, error => error instanceof ComputerError && error.code === 'outcome_unknown')
  assert.equal(f.service.status(owner).executing, true)
  await assert.rejects(f.service.connect(owner, {}, f.signal), /executing action/)
  await assert.rejects(f.observe(), /executing action/)
  await assert.rejects(f.service.act(owner, f.input(), f.signal), /already executing/)
  await f.service.stopAll()
  gate.resolve()
  await rejected
  assert.equal(f.service.status(owner).grant, null)
  assert.equal(f.service.status(owner).lastAction?.outcome, 'outcome_unknown')
})

test('observation expiry and already cancelled input fail without dispatch', async t => {
  let now = Date.now()
  const f = await fixture(t, { now: () => now })
  now += 120_000
  await assert.rejects(f.service.act(owner, f.input(), f.signal), /Observe the window again/)
  await f.observe()
  await assert.rejects(f.service.act(owner, f.input(), AbortSignal.abort()))
  assert.equal(f.desktop.calls.filter(call => call.method === 'act').length, 0)
})
