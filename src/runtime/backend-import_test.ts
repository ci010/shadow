import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectRuntime, runBackendCli, runRootProcessEntry, startMainRuntime } from '../index.ts'
import { runBackendCli as runtimeBackendCli, runRootProcessEntry as runtimeProcessEntry } from './main/cli.ts'
import { startMainRuntime as runtimeStart } from './main/start.ts'
import { createProjectRuntime as runtimeFactory } from './main/project-runtime.ts'

test('importing the backend exposes lifecycle APIs without starting it', () => {
  assertEquals(typeof startMainRuntime, 'function')
  assertEquals(typeof runBackendCli, 'function')
  assertEquals(startMainRuntime, runtimeStart)
  assertEquals(createProjectRuntime, runtimeFactory)
  assertEquals(runBackendCli, runtimeBackendCli)
  assertEquals(runRootProcessEntry, runtimeProcessEntry)
})
