import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createUtilityProcessSpawn } from './utility-process.js'

for (const role of ['server', 'child']) {
  test(`utility process preserves ${role} arguments, pipes and private environment`, () => {
    let kills = 0
    const forced: number[] = []
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills++; return true },
    })
    const spawn = createUtilityProcessSpawn((entry, args, options) => {
      assert.equal(entry, 'backend.js')
      assert.deepEqual(args, [role, 'start', '--config', 'config.json'])
      assert.deepEqual(options, {
        env: { GATEWAY_PORT: '43123', WINDOWS_USE_LAUNCH_TOKEN: 'synthetic' },
        stdio: 'pipe', serviceName: 'Shadow Backend',
      })
      return child
    }, pid => { forced.push(pid); return true })
    const process = spawn('unused.exe', ['backend.js', role, 'start', '--config', 'config.json'], {
      env: { ELECTRON_RUN_AS_NODE: '1', GATEWAY_PORT: '43123', WINDOWS_USE_LAUNCH_TOKEN: 'synthetic' },
    })
    assert.equal(process.stdout, child.stdout)
    assert.equal(process.stderr, child.stderr)
    const exits: unknown[] = []
    const errors: string[] = []
    process.once('exit', (...args) => exits.push(args))
    process.once('error', error => errors.push(error.message))
    child.emit('error', 'FatalError', 'private-location', 'private-report')
    child.emit('exit', 1)
    assert.deepEqual(errors, ['Backend utility process failed'])
    assert.deepEqual(exits, [[1, null]])
    assert.equal(process.kill('SIGTERM'), true)
    assert.equal(kills, 1)
    assert.equal(process.kill('SIGKILL'), true)
    assert.deepEqual(forced, [12345])
  })
}

test('utility fork failures propagate to the supervisor', () => {
  const spawn = createUtilityProcessSpawn(() => { throw new Error('fork failed') })
  assert.throws(() => spawn('unused', ['backend.js'], {}), /fork failed/)
  assert.throws(() => spawn('unused', [], {}), /entry path/)
})
