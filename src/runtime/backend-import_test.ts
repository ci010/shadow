import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { runBackendCli, startMainRuntime } from '../index.ts'

test('importing the backend exposes lifecycle APIs without starting it', () => {
  assertEquals(typeof startMainRuntime, 'function')
  assertEquals(typeof runBackendCli, 'function')
})
