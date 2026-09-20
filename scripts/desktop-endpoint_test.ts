import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import { forwardDesktopEndpoint } from './desktop-endpoint.ts'

test('desktop discovery forwards only scoped loopback endpoints, never launch credentials', () => {
  const electron = new EventEmitter()
  const messages: unknown[] = []
  const vite = { connected: true, send: (message: unknown) => messages.push(message) }
  forwardDesktopEndpoint(electron as ChildProcess, vite as unknown as ChildProcess)
  for (const message of [
    { type: 'other', apiBase: 'http://127.0.0.1:1' },
    { type: 'shadow:runtime-ready', apiBase: 'http://example.com' },
    { type: 'shadow:runtime-ready', apiBase: 'http://127.0.0.1:123', launchToken: 'secret' },
    { type: 'shadow:runtime-ready', apiBase: 'http://127.0.0.1:123/#secret' },
  ]) electron.emit('message', message)
  assert.deepEqual(messages, [])
  electron.emit('message', { type: 'shadow:runtime-ready', apiBase: 'http://127.0.0.1:43199' })
  electron.emit('message', { type: 'shadow:runtime-ready', apiBase: 'http://[::1]:19800' })
  electron.emit('exit')
  electron.emit('message', { type: 'shadow:runtime-ready', apiBase: 'http://127.0.0.1:1' })
  assert.deepEqual(messages, [
    { type: 'shadow:runtime-ready', apiBase: 'http://127.0.0.1:43199' },
    { type: 'shadow:runtime-ready', apiBase: 'http://[::1]:19800' },
    { type: 'shadow:runtime-stopped' },
  ])
})
