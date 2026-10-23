import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installBackgroundWindow } from './background-window.js'
import { registerRuntimeHostQuitLifecycle } from './sidecar/runtime-host.js'

function fixture() {
  const calls: string[] = []
  const app = Object.assign(new EventEmitter(), {
    quit() {
      let prevented = false
      app.emit('before-quit', { preventDefault: () => { prevented = true } })
      if (!prevented) calls.push('quit')
    },
  })
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    minimized: false,
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    hide() { calls.push('hide') },
    restore() { calls.push('restore') },
    show() { calls.push('show') },
    focus() { calls.push('focus') },
  })
  const dispose = installBackgroundWindow(app, window)
  const close = () => {
    let prevented = false
    window.emit('close', { preventDefault: () => { prevented = true } })
    return prevented
  }
  return { app, window, calls, close, dispose }
}

test('closing Main, Child or setup hides only the window without stopping the app', () => {
  const f = fixture()
  assert.equal(f.close(), true)
  assert.equal(f.close(), true)
  assert.deepEqual(f.calls, ['hide', 'hide'])
  assert.equal(f.window.isDestroyed(), false)
})

test('macOS activation restores the hidden window without starting another runtime', () => {
  const f = fixture()
  f.window.minimized = true
  f.app.emit('activate')
  assert.deepEqual(f.calls, ['restore', 'show', 'focus'])
  f.app.emit('before-quit')
  f.app.emit('activate')
  assert.equal(f.calls.length, 3)
  assert.equal(f.close(), false)
})

test('explicit Quit stops the owned runtime exactly once and is not intercepted as hide', async () => {
  const f = fixture()
  let resolveStopped!: () => void
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
  let stops = 0
  registerRuntimeHostQuitLifecycle(f.app, { stop: async () => { stops++; await stopped } })
  assert.equal(f.close(), true)
  assert.equal(stops, 0)
  f.app.quit()
  f.app.quit()
  assert.equal(stops, 1)
  assert.equal(f.close(), false)
  resolveStopped()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, ['hide', 'quit'])
})

test('destroyed windows and disposed lifecycle release all handlers', () => {
  for (const closed of [false, true]) {
    const f = fixture()
    f.window.destroyed = true
    assert.equal(f.close(), false)
    f.app.emit('activate')
    assert.deepEqual(f.calls, [])
    if (closed) f.window.emit('closed')
    f.dispose()
    f.dispose()
    assert.equal(f.app.listenerCount('activate'), 0)
    assert.equal(f.app.listenerCount('before-quit'), 0)
    assert.equal(f.window.listenerCount('close'), 0)
    assert.equal(f.window.listenerCount('closed'), 0)
  }
})
