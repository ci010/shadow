import assert from 'node:assert/strict'
import childProcess, { ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import { ProcessManager, terminateProcessTree, type ManagedProcessStatus } from './manager.ts'
import { resolveExecShell } from './shells.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

for (const supervised of [false, true]) {
  test(`Windows shell escalation records the actual shell (supervised=${supervised})`, {
    skip: process.platform !== 'win32',
    timeout: 15_000,
  }, async t => {
    if (!await resolveExecShell('sh')) return t.skip('sh is not installed')
    await withTempWorkspace(async root => {
      const manager = new ProcessManager()
      const managed = await manager.spawn(': grep', root, undefined, 'cmd', [], {
        isolated: true,
        ...(supervised ? { supervision: { deadlineAt: Date.now() + 10_000 } } : {}),
      })
      try {
        assert.equal((await managed.exitPromise).success, true)
        assert.equal(managed.shell, 'sh')
        assert.equal(managed.cwd, root)
      } finally {
        await manager.terminate(managed)
        manager.remove(managed.pid)
      }
    })
  })
}

function fixture() {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 2147483647 })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const exited = Promise.withResolvers<ManagedProcessStatus>()
  const close = () => {
    Object.defineProperty(child, 'exitCode', { value: 0 })
    child.stdout!.destroy()
    child.stderr!.destroy()
    exited.resolve({ code: 0, signal: null, success: true })
  }
  return { child, exited, close }
}

function failTermination(error: Error) {
  const descriptor = Object.getOwnPropertyDescriptor(childProcess, 'execFile')
  assert.ok(descriptor)
  Object.defineProperty(childProcess, 'execFile', { ...descriptor, value: (...args: unknown[]) => {
    assert.deepEqual(args[1], ['/PID', '2147483647', '/T', '/F'])
    const callback = args.at(-1)
    assert.equal(typeof callback, 'function')
    if (typeof callback === 'function') callback(error)
  } })
  syncBuiltinESMExports()
  return () => { Object.defineProperty(childProcess, 'execFile', descriptor); syncBuiltinESMExports() }
}

test('Windows termination failure racing with owned exit waits for pipe drainage', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(), warnings: unknown[][] = []
  const error = Object.assign(new Error('Synthetic process already exiting'), { code: 128 })
  const restore = failTermination(error)
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
  try {
    const pending = terminateProcessTree(f.child, f.exited.promise)
    const result = pending.then(value => ({ value }), error => ({ error }))
    await tick()
    f.close()
    assert.deepEqual(await result, { value: { code: 0, signal: null, success: true } })
    assert.equal(warnings.length, 1, 'The termination-command failure is not silently erased')
  } finally { restore(); f.close() }
})

test('Windows termination failure remains a failure while owned output is not closed', { skip: process.platform !== 'win32' }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), failure = new Error('Synthetic permission failure')
  const restore = failTermination(failure)
  try {
    const result = terminateProcessTree(f.child, f.exited.promise).then(value => ({ value }), error => ({ error }))
    await tick()
    Object.defineProperty(f.child, 'exitCode', { value: 0 })
    t.mock.timers.tick(5000)
    const outcome = await result
    assert.ok('error' in outcome)
    assert.match(outcome.error.message, /did not close/)
    assert.equal(outcome.error.cause, failure)
    assert.equal(f.child.stdout!.destroyed, false)
  } finally { restore(); f.close() }
})
