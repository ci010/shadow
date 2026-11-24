import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectDataPaths } from '../utils/data-paths.ts'
import { DISPATCH_FAILURE_RECHECK_MS, DISPATCH_RECHECK_MS, dispatchFingerprint, WorkDispatchRoundState } from './work-dispatch-round-state.ts'

const fingerprint = dispatchFingerprint({ work: 1 })
test('unchanged rounds suppress across restart; changed input and bounded recheck wake again', async () => withTempWorkspace(async home => {
  let now = 1_000
  const first = new WorkDispatchRoundState(home, () => now)
  assert.equal(await first.begin(fingerprint), true)
  assert.equal(await first.begin(fingerprint), false)
  await first.finish(fingerprint, true)
  const restarted = new WorkDispatchRoundState(home, () => now)
  assert.equal(await restarted.begin(fingerprint), false)
  now += DISPATCH_RECHECK_MS
  assert.equal(await restarted.begin(fingerprint), true)
  const changed = dispatchFingerprint({ work: 2 })
  assert.equal(await restarted.begin(changed), true)
  await restarted.finish(fingerprint, true) // stale completion cannot replace current state
  assert.equal(await restarted.begin(changed), false)
  assert.equal(await new WorkDispatchRoundState(join(home, 'other'), () => now).begin(changed), true)
}))

test('failure and interrupted rounds back off, concurrent admissions serialize', async () => withTempWorkspace(async home => {
  let now = 1
  const receipts = new WorkDispatchRoundState(home, () => now)
  assert.deepEqual(await Promise.all([receipts.begin(fingerprint), receipts.begin(fingerprint)]), [true, false])
  const restarted = new WorkDispatchRoundState(home, () => now)
  assert.equal(await restarted.begin(fingerprint), false)
  now += DISPATCH_FAILURE_RECHECK_MS
  assert.equal(await restarted.begin(fingerprint), true)
  await restarted.finish(fingerprint, false)
  assert.equal(await restarted.begin(fingerprint), false)
  now += DISPATCH_FAILURE_RECHECK_MS
  assert.equal(await restarted.begin(fingerprint), true)
}))

test('review write-ahead receipts prevent unknown notification replay and survive restart', async () => withTempWorkspace(async home => {
  const input = { key: 'work:4446e47e-1cae-5221-b77f-26df1b396424', version: 1, recipient: 'manager', inputId: 'review:one' }
  const first = new WorkDispatchRoundState(home)
  assert.equal((await first.reserveReview(input)).send, true)
  const restarted = new WorkDispatchRoundState(home)
  assert.deepEqual(await restarted.reserveReview(input), { send: false, receipt: { ...input, status: 'unconfirmed' } })
  await restarted.acceptReview(input.inputId)
  assert.equal((await restarted.reserveReview(input)).receipt.status, 'accepted')
  assert.equal((await restarted.reserveReview({ ...input, version: 2, inputId: 'review:two' })).send, true)
}))

test('malformed or aliased host receipts fail closed instead of enabling repeated rounds', async () => withTempWorkspace(async home => {
  const directory = join(projectDataPaths(home).state, 'work-dispatch')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'round-state.json'), '{broken')
  await assert.rejects(new WorkDispatchRoundState(home).begin(fingerprint))
  const aliasHome = join(home, 'alias-project')
  const aliasState = projectDataPaths(aliasHome).state
  const target = join(home, 'target')
  await mkdir(aliasState, { recursive: true }); await mkdir(target)
  await symlink(target, join(aliasState, 'work-dispatch'), 'junction')
  await assert.rejects(new WorkDispatchRoundState(aliasHome).begin(fingerprint), /aliases/)
}))
