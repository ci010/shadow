import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { manageChildren, startNode, waitForExit } from './processes.ts'

test('Node subprocess launcher preserves the environment and reports failures', async () => {
  const child = startNode(['-e', 'process.exit(process.env.SHADOW_SCRIPT_TEST === "present" ? 7 : 9)'], {
    env: { SHADOW_SCRIPT_TEST: 'present' },
  })
  assert.equal(await waitForExit(child), 7)
})

test('waiting for an already signal-terminated process reports failure', { timeout: 5_000 }, async () => {
  const child = startNode(['-e', 'setInterval(() => {}, 1000)'])
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  assert.equal(await waitForExit(child), 1)
})

test('coordinated shutdown terminates owned processes and is idempotent', async () => {
  const child = startNode(['-e', 'setInterval(() => {}, 1000)'])
  const lifecycle = manageChildren([child])
  const first = lifecycle.stop()
  assert.equal(lifecycle.stop(), first)
  await first
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})
