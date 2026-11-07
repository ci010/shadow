import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { BootstrapCommandError, createBootstrapRunner } from './bootstrap-command.ts'

function launcher(scenario: (child: any) => void, closes = true) {
  let options: any, kills = 0, unrefs = 0
  const launch = ((_file: string, _args: string[], opts: any) => {
    options = opts
    const child: any = new EventEmitter()
    child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = opts.stdio[0] === 'pipe' ? new PassThrough() : null
    child.kill = () => { kills++; if (closes) queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true }
    child.unref = () => { unrefs++ }
    queueMicrotask(() => scenario(child))
    return child
  }) as unknown as typeof spawn
  return { launch, options: () => options, kills: () => kills, unrefs: () => unrefs }
}
const command = { file: 'wsl.exe', args: ['probe'], timeoutMs: 1000 }
const signal = () => new AbortController().signal

test('no-input probes use ignored stdin and preserve nonzero exit diagnostics and bounded output', async () => {
  const fake = launcher(child => { child.stdout.write(Buffer.alloc(100000, 65)); child.stderr.write('diagnostic detail'); child.emit('close', 7, null) })
  const receipt = await createBootstrapRunner({ launch: fake.launch })(command, signal())
  assert.equal(fake.options().stdio[0], 'ignore')
  assert.equal(receipt.code, 7); assert.equal(receipt.stdout.length, 65536)
  assert.equal(receipt.stderr.toString(), 'diagnostic detail')
  assert.equal(receipt.diagnostic?.reason, 'exit'); assert.equal(receipt.diagnostic?.launcherExited, true)
  assert.equal(fake.kills(), 0)
})

test('timeout and cancellation remain distinct, retain private output and wait for launcher close', async () => {
  for (const reason of ['timeout', 'cancelled']) {
    const controller = new AbortController()
    const fake = launcher(child => { child.stderr.write('PRIVATE_NATIVE_DETAIL'); if (reason === 'cancelled') controller.abort() })
    const run = createBootstrapRunner({ launch: fake.launch, killGraceMs: 100 })
    await assert.rejects(run({ ...command, timeoutMs: 15 }, controller.signal), (error: unknown) => {
      assert.ok(error instanceof BootstrapCommandError)
      assert.equal(error.diagnostic.reason, reason); assert.equal(error.diagnostic.launcherExited, true)
      assert.equal(error.diagnostic.timeoutMs, 15); assert.equal(error.diagnostic.signal, 'SIGTERM')
      assert.equal(error.stderr.toString(), 'PRIVATE_NATIVE_DETAIL')
      assert.doesNotMatch(error.message, /PRIVATE_NATIVE_DETAIL/)
      return true
    })
    assert.equal(fake.kills(), 1)
  }
})

test('spawn failure, stdin failure and signal exit are not disguised as timeouts', async () => {
  for (const reason of ['spawn_error', 'stdin_error', 'signal']) {
    const fake = launcher(child => {
      if (reason === 'spawn_error') { child.pid = undefined; child.emit('error', Object.assign(new Error('private command/path'), { code: 'ENOENT' })) }
      if (reason === 'stdin_error') child.stdin.emit('error', Object.assign(new Error('private stdin error'), { code: 'EPIPE' }))
      if (reason === 'signal') child.emit('close', null, 'SIGKILL')
    })
    await assert.rejects(createBootstrapRunner({ launch: fake.launch })({ ...command, input: 'fixed recipe' }, signal()), (error: unknown) => {
      assert.ok(error instanceof BootstrapCommandError); assert.equal(error.diagnostic.reason, reason)
      assert.equal(error.diagnostic.launcherExited, true)
      if (reason !== 'signal') assert.equal(error.diagnostic.osCode, reason === 'spawn_error' ? 'ENOENT' : 'EPIPE')
      assert.doesNotMatch(error.message, /private command|private stdin/)
      return true
    })
    assert.equal(fake.options().stdio[0], 'pipe')
  }
})

test('unconfirmed launcher termination is bounded and explicitly prevents a cleanup success claim', async () => {
  const fake = launcher(() => {}, false)
  await assert.rejects(createBootstrapRunner({ launch: fake.launch, killGraceMs: 15 })({ ...command, timeoutMs: 15 }, signal()), (error: unknown) => {
    assert.ok(error instanceof BootstrapCommandError); assert.equal(error.diagnostic.reason, 'timeout')
    assert.equal(error.diagnostic.launcherExited, false); assert.equal(error.diagnostic.launcherPid, 12345)
    return true
  })
  assert.equal(fake.unrefs(), 1)
})

test('pre-aborted calls never launch; synchronous launch errors carry safe spawn diagnostics', async () => {
  const run = createBootstrapRunner({ launch: (() => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOENT' }) }) as unknown as typeof spawn })
  assert.throws(() => run(command, AbortSignal.abort()), /abort/i)
  await assert.rejects(run(command, signal()), (error: unknown) => {
    assert.ok(error instanceof BootstrapCommandError); assert.equal(error.diagnostic.reason, 'spawn_error')
    assert.equal(error.diagnostic.launcherExited, true); assert.doesNotMatch(error.message, /PRIVATE_PATH/)
    return true
  })
})
