import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NodeSidecarSupervisor } from './supervisor.js'
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

for (const role of ['main', 'child'] as const) {
  for (const armed of [false, true]) {
    test(`composed supervisor utility fork: ${role}, profiling=${armed}`, async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { queueMicrotask(() => child.emit('exit', 0)); return true },
      })
      const entryPath = join(process.cwd(), 'synthetic backend', 'index.js')
      let forks = 0
      const supervisor = new NodeSidecarSupervisor({
        environment: { SHADOW_DESKTOP_DEV_IPC: '1', ...(armed ? { SHADOW_STARTUP_PROFILE_DIR: 'synthetic profiles' } : {}) },
        readinessProbe: async () => ({ ready: true }),
        spawn: createUtilityProcessSpawn((entry, argv, options) => {
          forks++
          assert.equal(entry, armed ? fileURLToPath(new URL('./utility-profile-bootstrap.js', import.meta.url)) : entryPath)
          const preload = pathToFileURL(join(process.cwd(), 'synthetic backend', 'runtime', 'startup-profile-preload.js')).href
          if (armed) assert.deepEqual(argv.splice(0, 2), [JSON.stringify([preload]), entryPath])
          assert.deepEqual(argv, [role === 'main' ? 'server' : 'child', 'start', '--config', 'synthetic config.json', ...(role === 'main' ? ['--local-executor'] : [])])
          assert.equal(options.execArgv, undefined)
          // Match Electron's actual env validation, not Node spawn's permissive contract.
          assert.ok(Object.values(options.env ?? {}).every(value => typeof value === 'string'))
          assert.equal(Object.hasOwn(options.env ?? {}, 'SHADOW_DESKTOP_MEDIA_KEY'), role === 'main')
          assert.equal((options.env as NodeJS.ProcessEnv | undefined)?.ELECTRON_RUN_AS_NODE, undefined)
          return child
        }),
      })
      assert.equal((await supervisor.start({ role, executablePath: 'unused', entryPath, configPath: 'synthetic config.json', launchToken: 'synthetic', port: 43123, localExecutor: role === 'main' })).phase, 'ready')
      assert.equal(forks, 1)
      await supervisor.stop()
    })
  }
}

test('utility preload prefix validates values and preserves application flags', () => {
  let forks = 0
  const spawn = createUtilityProcessSpawn((entry, argv, options) => {
    forks++
    assert.equal(entry, fileURLToPath(new URL('./utility-profile-bootstrap.js', import.meta.url)))
    assert.deepEqual(argv, [JSON.stringify(['file:///preload.js']), 'entry.js', '--import', 'application-value'])
    assert.equal(options.execArgv, undefined)
    return Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null, kill: () => true })
  })
  for (const args of [['--import'], ['--import', '--bad'], ['--import', 'file:///preload.js'], ['--unsupported', 'entry.js']]) {
    assert.throws(() => spawn('unused', args, {}), /path is required/)
  }
  spawn('unused', ['--import', 'file:///preload.js', 'entry.js', '--import', 'application-value'], {})
  assert.equal(forks, 1)
})


test('only a dev supervisor callback arms restart; inherited production markers and malformed messages are inert', () => {
  for (const enabled of [false, true]) {
    for (const production of [false, true]) {
      let restarts = 0
      const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null, kill: () => true })
      const spawn = createUtilityProcessSpawn((_entry, _args, options) => {
        assert.equal((options.env as NodeJS.ProcessEnv | undefined)?.SHADOW_DEV_RESTART_TOOL, enabled && !production ? '1' : undefined)
        return child
      }, undefined, enabled ? () => { restarts++ } : undefined)
      spawn('unused', ['backend.js'], { env: {
        SHADOW_DESKTOP_DEV_IPC: '1', SHADOW_DEV_RESTART_TOOL: '1', ...(production ? { NODE_ENV: 'production' } : {}),
      } })
      for (const malformed of [null, [], 'shadow:dev-restart', { type: 'other' }, { type: 'shadow:dev-restart', extra: true }]) child.emit('message', malformed)
      assert.equal(restarts, 0)
      child.emit('message', { type: 'shadow:dev-restart' })
      assert.equal(restarts, enabled && !production ? 1 : 0)
    }
  }
})
