import assert from 'node:assert/strict'
import test from 'node:test'
import { observeDesktopWindow } from './desktop-window.ts'
import type { ShadowDesktopApi } from './desktop-bootstrap.ts'

test('desktop window observer follows maximize/restore and unsubscribes', async () => {
  let listener: ((state: { maximized: boolean }) => void) | undefined
  let resolve!: (state: { maximized: boolean }) => void
  const initial = new Promise<{ maximized: boolean }>((done) => { resolve = done })
  const values: boolean[] = []
  const controls: NonNullable<ShadowDesktopApi['windowControls']> = {
    getState: () => initial, async minimize() {}, async close() {},
    async toggleMaximize() { return { maximized: true } },
    onStateChanged(callback) { listener = callback; return () => { listener = undefined } },
  }
  const stop = observeDesktopWindow(controls, (value) => values.push(value), () => assert.fail('unexpected error'))
  listener?.({ maximized: true })
  resolve({ maximized: false })
  await initial
  await Promise.resolve()
  assert.deepEqual(values, [true], 'A stale initial read must not overwrite a newer maximize event')
  listener?.({ maximized: false })
  assert.deepEqual(values, [true, false])
  stop()
  assert.equal(listener, undefined)
})
