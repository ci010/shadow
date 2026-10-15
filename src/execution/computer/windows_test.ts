import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import test, { type TestContext } from 'node:test'
import { WindowsComputerDesktop } from './windows.ts'
import {
  ComputerActionResultSchema, ComputerActionSchema, ComputerError, ComputerObservationSchema, ComputerTargetSchema, ComputerWindowsSchema,
  type ComputerObservation,
} from './contracts.ts'

async function startFixture(t: TestContext, input = false) {
  const source = fileURLToPath(new URL('./testing/window.cs', import.meta.url))
  const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source.replaceAll("'", "''")}')) -ReferencedAssemblies @('System','System.Drawing','System.Windows.Forms'); [ComputerFixture]::${input ? 'RunInput' : 'Run'}()`
  const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', value => { output += value })
  child.stderr.resume()
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, 'close')
      child.kill()
      await closed
    }
  })
  async function wait(pattern: RegExp, from = 0, timeout = 3000) {
    const deadline = Date.now() + timeout
    while (!pattern.test(output.slice(from)) && child.exitCode === null && Date.now() < deadline) await delay(15)
    assert.match(output.slice(from), pattern, 'Only the synthetic Windows fixture must receive input')
  }
  await wait(/READY/, 0, 15_000)
  const pid = child.pid
  assert.ok(pid)
  return { child, pid, wait, get output() { return output } }
}

test('native input guards, coordinates, key pairing and cancellation use a fake desktop without SendInput', {
  skip: process.platform !== 'win32', timeout: 20_000,
}, async () => {
  const source = fileURLToPath(new URL('./windows-input.cs', import.meta.url))
  const fixture = fileURLToPath(new URL('./testing/input.cs', import.meta.url))
  const quote = (path: string) => `'${path.replaceAll("'", "''")}'`
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(source)}) + [Environment]::NewLine + [IO.File]::ReadAllText(${quote(fixture)})) -ReferencedAssemblies @('System','System.Core','System.Web.Extensions'); [Shadow.InputFixture]::Run()`
  const { stdout } = await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15_000 },
  )
  assert.ok(Number(stdout.trim()) >= 40, 'Native fake-input assertions must execute, not only compile')
})

test('private stdio host serializes requests, rejects concurrent input and aborts uncertain effects', async t => {
  const desktop = new WindowsComputerDesktop({
    spawnHost: () => spawn(process.execPath, ['-e', `
      const rl = require('node:readline').createInterface({input:process.stdin});
      rl.on('line', line => { const q=JSON.parse(line); if(q.method === 'act') return;
        setTimeout(() => process.stdout.write(JSON.stringify({id:q.id,result:{ok:true}})+'\\n'), 30); });
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  })
  t.after(() => desktop.interrupt())
  const read = desktop.request({ method: 'list' }, new AbortController().signal)
  await assert.rejects(desktop.request({ method: 'list' }, new AbortController().signal), /in progress/)
  assert.deepEqual(await read, { ok: true })
  const controller = new AbortController()
  const action = desktop.request({
    method: 'act', targetId: crypto.randomUUID(), observationId: crypto.randomUUID(),
    actionId: crypto.randomUUID(), action: { kind: 'invoke', elementId: '0' },
  }, controller.signal)
  const rejected = assert.rejects(action, error => error instanceof ComputerError && error.code === 'outcome_unknown')
  controller.abort()
  await rejected
  await desktop.interrupt()
  assert.ok(desktop.generation > 0)
})

test('malformed native replies terminate the host and never become tool data', async t => {
  const desktop = new WindowsComputerDesktop({
    spawnHost: () => spawn(process.execPath, ['-e', "process.stdin.once('data',()=>process.stdout.write('PRIVATE INVALID RESPONSE\\n'))"], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }),
  })
  t.after(() => desktop.interrupt())
  await assert.rejects(desktop.request({ method: 'list' }, new AbortController().signal), error =>
    error instanceof ComputerError && error.code === 'host_protocol' && !error.message.includes('PRIVATE'))
})

test('Windows UIA observes, captures and changes only a synthetic fixture; stale and protected targets fail closed', {
  skip: process.platform !== 'win32', timeout: 60_000,
}, async t => {
  const desktop = new WindowsComputerDesktop({ timeoutMs: 20_000 })
  t.after(() => desktop.interrupt())
  try { await desktop.request({ method: 'list', processId: process.pid }, AbortSignal.timeout(25_000)) }
  catch (error) {
    if (error instanceof ComputerError && error.code === 'unavailable') { t.skip('An unlocked interactive Windows desktop is required.'); return }
    throw error
  }
  const fixture = await startFixture(t)
  const child = fixture.child
  const signal = AbortSignal.timeout(40_000)
  const listing = ComputerWindowsSchema.parse(await desktop.request({ method: 'list', processId: fixture.pid }, signal))
  assert.equal(listing.windows.length, 1)
  const target = ComputerTargetSchema.parse(await desktop.request({ method: 'bind', windowId: listing.windows[0].id }, signal))
  const observe = async (screenshot = false) => ComputerObservationSchema.parse(await desktop.request({ method: 'observe', targetId: target.id, screenshot }, signal))
  let observation = await observe(true)
  assert.ok(observation.screenshot?.base64)
  assert.equal(Buffer.from(observation.screenshot.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.doesNotMatch(JSON.stringify(observation.elements), /SYNTHETIC-PRIVATE-VALUE/)
  const password = observation.elements.find(element => element.protected)
  assert.ok(password)
  assert.deepEqual(password.actions, [])
  const input = observation.elements.find(element => element.name === 'Fixture input')
  assert.ok(input && input.actions.includes('set_value') && input.focusable)
  await assert.rejects(desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'type_text', elementId: input.id, text: 'must not type without permission' },
  }, signal), error => error instanceof ComputerError && error.code === 'foreground_not_allowed')
  observation = await observe()
  let result = ComputerActionResultSchema.parse(await desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'set_value', elementId: input.id, value: 'Synthetic approved value' },
  }, signal).catch(error => { throw new Error('Replacing the short fixture field failed', { cause: error }) }))
  assert.equal(result.verified, true)
  assert.equal(result.observation.elements.find(element => element.name === 'Fixture input')?.value, 'Synthetic approved value')
  observation = await observe()
  const checkbox = observation.elements.find(element => element.name === 'Fixture toggle')
  assert.ok(checkbox && checkbox.actions.includes('toggle'))
  result = ComputerActionResultSchema.parse(await desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'toggle', elementId: checkbox.id },
  }, signal).catch(error => { throw new Error('Toggling the fixture checkbox failed', { cause: error }) }))
  assert.equal(result.verified, true)
  observation = await observe()
  const option = observation.elements.find(element => element.name === 'Fixture choice 1')
  assert.ok(option && option.actions.includes('select'))
  result = ComputerActionResultSchema.parse(await desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'select', elementId: option.id },
  }, signal).catch(error => { throw new Error('Selecting the fixture list item failed', { cause: error }) }))
  assert.equal(result.verified, true)
  observation = await observe()
  const list = observation.elements.find(element => element.name === 'Fixture list')
  assert.ok(list && list.actions.includes('scroll'))
  result = ComputerActionResultSchema.parse(await desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'scroll', elementId: list.id, direction: 'down' },
  }, signal).catch(error => { throw new Error('Scrolling the fixture list failed', { cause: error }) }))
  assert.equal(result.verified, true)
  observation = await observe()
  child.stdin.write('change\n')
  await fixture.wait(/CHANGED/)
  await assert.rejects(desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'set_value', elementId: input.id, value: 'must not overwrite' },
  }, signal), error => error instanceof ComputerError && error.code === 'stale_observation')
  observation = await observe()
  assert.equal(observation.elements.find(element => element.name === 'Fixture input')?.value, 'Changed outside automation')
  result = ComputerActionResultSchema.parse(await desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'set_value', elementId: input.id, value: 'x'.repeat(2100) + 'before' },
  }, signal).catch(error => { throw new Error('Writing the long fixture value failed', { cause: error }) }))
  observation = result.observation
  assert.equal(observation.elements.find(element => element.name === 'Fixture input')?.value, 'x'.repeat(2000))
  assert.equal(observation.truncated, true)
  assert.equal(observation.elements.find(element => element.name === 'Fixture input')?.actions.includes('set_value'), false)
  child.stdin.write('change-long\n')
  await fixture.wait(/LONG_CHANGED/)
  observation = await observe()
  await assert.rejects(desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'set_value', elementId: input.id, value: 'must not overwrite changed suffix' },
  }, signal), error => error instanceof ComputerError && error.code === 'unsupported_action')
  observation = await observe()
  const protectedElement = observation.elements.find(element => element.protected)!
  await assert.rejects(desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'set_value', elementId: protectedElement.id, value: 'never' },
  }, signal), error => error instanceof ComputerError && error.code === 'protected_target')
  observation = await observe()
  const button = observation.elements.find(element => element.name === 'Fixture button')
  assert.ok(button && button.actions.includes('invoke'))
  result = ComputerActionResultSchema.parse(await desktop.request({
    method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(),
    action: { kind: 'invoke', elementId: button.id },
  }, signal).catch(error => { throw new Error('Invoking the fixture button failed', { cause: error }) }))
  assert.equal(result.verified, false, 'Invoke success must not assert business task completion')
  const invokedDeadline = Date.now() + 2000
  while (!result.observation.elements.some(element => element.name === 'Invoked once') && Date.now() < invokedDeadline) {
    await delay(30)
    result.observation = await observe()
  }
  assert.ok(result.observation.elements.some(element => element.name === 'Invoked once'))
  child.stdin.write('many-fields\n')
  await fixture.wait(/MANY_FIELDS/)
  observation = await observe()
  assert.equal(observation.truncated, true)
  assert.ok(observation.elements.length <= 200)
  assert.ok(JSON.stringify(observation).length < 36_000, 'The serialized tree budget must bound dense text fields')
})

test('Windows foreground fixture receives bounded keyboard/mouse input and releases a cancelled drag', {
  skip: process.platform !== 'win32' || process.env.SHADOW_COMPUTER_FOREGROUND_TEST !== '1',
  timeout: 90_000,
}, async t => {
  const desktop = new WindowsComputerDesktop({ timeoutMs: 20_000 })
  t.after(() => desktop.interrupt())
  const fixture = await startFixture(t, true)
  const signal = AbortSignal.timeout(75_000)
  const listing = ComputerWindowsSchema.parse(await desktop.request({ method: 'list', processId: fixture.pid }, signal))
  assert.equal(listing.windows.length, 1)
  const target = ComputerTargetSchema.parse(await desktop.request({ method: 'bind', windowId: listing.windows[0].id, foregroundInput: true }, signal))
  const observe = async (screenshot = false) => ComputerObservationSchema.parse(await desktop.request({ method: 'observe', targetId: target.id, screenshot }, signal))
  const act = async (observation: ComputerObservation, action: unknown) => {
    const parsed = ComputerActionSchema.parse(action)
    try {
      return ComputerActionResultSchema.parse(await desktop.request({
        method: 'act', targetId: target.id, observationId: observation.id, actionId: crypto.randomUUID(), action: parsed,
      }, signal))
    } catch (error) {
      if (error instanceof ComputerError) error.message = `Synthetic ${parsed.kind}: ${error.message}`
      throw error
    }
  }
  let observation = await observe()
  const input = observation.elements.find(element => element.name === 'Fixture input')!
  assert.ok(input?.focusable)
  await act(observation, { kind: 'set_value', elementId: input.id, value: '' })
  observation = await observe()
  const typed = await act(observation, { kind: 'type_text', elementId: input.id, text: 'Synthetic \u4e2d\ud83d\ude00' })
  assert.equal(typed.verified, false)
  assert.ok('focusRestored' in typed)
  observation = await observe()
  assert.equal(observation.elements.find(element => element.id === input.id)?.value, 'Synthetic \u4e2d\ud83d\ude00')
  let start = fixture.output.length
  await act(observation, { kind: 'press_key', elementId: input.id, key: 'END', modifiers: ['CTRL'] })
  await fixture.wait(/KEY End/, start)
  const point = (observed: ComputerObservation, name: string, fraction = .5) => {
    const element = observed.elements.find(element => element.name === name)
    assert.ok(element && observed.screenshot)
    return {
      x: Math.floor((element.bounds.x + element.bounds.width * fraction - observed.bounds.x) * observed.screenshot.width / observed.bounds.width),
      y: Math.floor((element.bounds.y + element.bounds.height * .5 - observed.bounds.y) * observed.screenshot.height / observed.bounds.height),
    }
  }
  for (const [button, expected] of [['left', 'Left'], ['right', 'Right'], ['middle', 'Middle']] as const) {
    observation = await observe(true)
    start = fixture.output.length
    await act(observation, { kind: 'click', ...point(observation, 'Fixture pointer surface'), button, count: button === 'left' ? 2 : 1 })
    await fixture.wait(new RegExp(`POINTER_DOWN ${expected}`), start)
    await fixture.wait(new RegExp(`POINTER_UP ${expected}`), start)
    assert.equal((fixture.output.slice(start).match(new RegExp(`POINTER_DOWN ${expected}`, 'g')) ?? []).length, button === 'left' ? 2 : 1)
  }
  observation = await observe(true)
  start = fixture.output.length
  await act(observation, { kind: 'move', ...point(observation, 'Fixture pointer surface', .25) })
  await fixture.wait(/POINTER_MOVED/, start)
  observation = await observe(true)
  const from = point(observation, 'Fixture pointer surface', .25)
  const to = point(observation, 'Fixture pointer surface', .75)
  start = fixture.output.length
  await act(observation, { kind: 'drag', ...from, toX: to.x, toY: to.y, durationMs: 300, modifiers: ['SHIFT'] })
  await fixture.wait(/POINTER_DOWN Left/, start)
  await fixture.wait(/POINTER_UP Left/, start)
  observation = await observe(true)
  start = fixture.output.length
  await act(observation, { kind: 'wheel', ...point(observation, 'Fixture pointer surface'), steps: 2 })
  await fixture.wait(/POINTER_WHEEL -240/, start)
  observation = await observe(true)
  await assert.rejects(act(observation, { kind: 'click', ...point(observation, '[Protected field]') }),
    error => error instanceof ComputerError && error.code === 'protected_target')
  observation = await observe(true)
  await assert.rejects(act(observation, { kind: 'move', x: 0, y: 0 }),
    error => error instanceof ComputerError && error.code === 'input_outside_window')
  observation = await observe(true)
  start = fixture.output.length
  const dragging = act(observation, { kind: 'drag', ...from, toX: to.x, toY: to.y, durationMs: 800, modifiers: ['SHIFT'] })
  const rejected = assert.rejects(dragging, error => error instanceof ComputerError && error.code === 'outcome_unknown')
  await fixture.wait(/POINTER_DOWN Left/, start)
  await desktop.interrupt()
  await rejected
  await fixture.wait(/POINTER_UP Left/, start)
  fixture.child.stdin.write('held-input\n')
  await fixture.wait(/INPUT_RELEASED/, start)
})
