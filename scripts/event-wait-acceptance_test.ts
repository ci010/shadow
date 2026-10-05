import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import {
  ACTIONS_RUN_ID, SECOND_RUN_ID, ACTIONS_RUN_PATH, SECOND_RUN_PATH, DISPATCH_PATH, LIVE_LOG_PATH,
  actionsFixtureCli, createActionsFixture, eventWaitPrompt,
} from './event-wait-fixture.ts'
import { eventWaitStrategies, eventWaitVerdict } from './event-wait-acceptance.ts'

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Fixture observation timed out')
    await delay(2)
  }
}

test('run dependency, running step URL, deadline and exactly-once processing are enforced by the fixture', async () => {
  const fixture = await createActionsFixture({ stepDelayMs: 5, urlTimeoutMs: 2000 })
  try {
    assert.equal((await fetch(fixture.origin + DISPATCH_PATH, { method: 'POST' })).status, 409)
    assert.equal(fixture.secondRun().status, 'not_started')
    const early = await (await fetch(fixture.origin + LIVE_LOG_PATH)).json()
    assert.doesNotMatch(JSON.stringify(early), /PROCESS_URL=/)
    fixture.complete('success')
    assert.equal((await fetch(fixture.origin + DISPATCH_PATH, { method: 'POST' })).status, 201)
    assert.equal((await fetch(fixture.origin + DISPATCH_PATH, { method: 'POST' })).status, 409)
    await waitFor(() => !!fixture.observation().urlPrintedAt)
    assert.equal(fixture.secondRun().status, 'in_progress')
    assert.equal(fixture.secondRun().steps[2].status, 'in_progress')
    const log = await (await fetch(fixture.origin + LIVE_LOG_PATH)).json() as { logs: string[] }
    const url = log.logs.find(line => line.startsWith('PROCESS_URL='))!.slice('PROCESS_URL='.length)
    const processed = await fetch(url, { method: 'POST' })
    assert.equal(processed.status, 200)
    assert.equal(fixture.secondRun().conclusion, 'success')
    assert.ok(fixture.observation().urlLatencyMs! < 2000)
    assert.equal((await fetch(url, { method: 'POST' })).status, 409)
    assert.deepEqual(fixture.attempts.map(attempt => attempt.accepted), [true, false])
  } finally { await fixture.close() }
})

test('missing URL processing fails the running third step and late processing cannot rescue it', async () => {
  const fixture = await createActionsFixture({ stepDelayMs: 2, urlTimeoutMs: 20 })
  try {
    fixture.complete('success')
    await fetch(fixture.origin + DISPATCH_PATH, { method: 'POST' })
    await waitFor(() => fixture.secondRun().conclusion === 'failure')
    assert.equal(fixture.observation().thirdStepStatus, 'timed_out')
    const log = await (await fetch(fixture.origin + LIVE_LOG_PATH)).json() as { logs: string[] }
    const url = log.logs.find(line => line.startsWith('PROCESS_URL='))!.slice('PROCESS_URL='.length)
    assert.equal((await fetch(url, { method: 'POST' })).status, 409)
    assert.equal(fixture.attempts[0].reason, 'url-timeout')
    assert.equal(fixture.secondRun().conclusion, 'failure')
  } finally { await fixture.close() }
})

test('stream exposes the URL before run completion, while run watch blocks until processing', async () => {
  const fixture = await createActionsFixture({ stepDelayMs: 10, urlTimeoutMs: 2000 })
  try {
    const firstWatch = fetch(fixture.origin + ACTIONS_RUN_PATH + '/watch')
    fixture.complete('success')
    assert.equal((await (await firstWatch).json()).conclusion, 'success')
    await fetch(fixture.origin + DISPATCH_PATH, { method: 'POST' })
    let completed = false
    const secondWatch = fetch(fixture.origin + SECOND_RUN_PATH + '/watch').then(async response => {
      completed = true
      return response.json()
    })
    const stream = await fetch(fixture.origin + LIVE_LOG_PATH + '/stream')
    const reader = stream.body!.getReader()
    let text = ''
    while (!text.includes('PROCESS_URL=')) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      text += new TextDecoder().decode(chunk.value)
    }
    assert.equal(completed, false)
    assert.equal(fixture.observation().thirdStepStatus, 'in_progress')
    const url = text.match(/PROCESS_URL=(\S+)/)![1]
    await fetch(url, { method: 'POST' })
    assert.equal((await secondWatch).conclusion, 'success')
    await reader.cancel()
  } finally { await fixture.close() }
})

test('failed first run cannot launch the second run', async () => {
  const fixture = await createActionsFixture()
  try {
    fixture.complete('failure')
    assert.equal((await fetch(fixture.origin + DISPATCH_PATH, { method: 'POST' })).status, 409)
    assert.equal(fixture.secondRun().status, 'not_started')
    assert.equal(fixture.observation().urlPrintedAt, undefined)
  } finally { await fixture.close() }
})

test('the actual fixture CLI supports launch, streaming mid-run URL and processing', async () => {
  await withTempWorkspace(async workspace => {
    const fixture = await createActionsFixture({ stepDelayMs: 40, urlTimeoutMs: 3000 })
    const path = join(workspace, 'actions-fixture.mjs')
    await writeFile(path, actionsFixtureCli(fixture.origin))
    const execute = (...args: string[]) => promisify(execFile)(process.execPath, [path, ...args], { timeout: 3000 })
    let child: ReturnType<typeof spawn> | undefined
    try {
      assert.equal(JSON.parse((await execute('view', String(ACTIONS_RUN_ID))).stdout).status, 'in_progress')
      fixture.complete('success')
      assert.equal(JSON.parse((await execute('launch', 'second')).stdout).id, SECOND_RUN_ID)
      child = spawn(process.execPath, [path, 'logs-watch', String(SECOND_RUN_ID)], { stdio: ['ignore', 'pipe', 'pipe'] })
      const exit = once(child, 'exit')
      let text = ''
      child.stdout!.on('data', chunk => { text += chunk.toString() })
      await waitFor(() => text.includes('PROCESS_URL='))
      assert.equal(fixture.secondRun().status, 'in_progress')
      const url = text.match(/PROCESS_URL=(\S+)/)![1]
      assert.equal(JSON.parse((await execute('process', url)).stdout).accepted, true)
      assert.equal((await exit)[0], 0)
      assert.equal(fixture.secondRun().conclusion, 'success')
    } finally {
      if (child && child.exitCode === null) {
        const exit = once(child, 'exit')
        child.kill()
        await exit
      }
      await fixture.close()
    }
  })
})

test('verdict checks the two-run dependency and URL deadline rather than assistant success claims', () => {
  const facts = [{ status: 'completed' as const, content: 'Done' }]
  const observation = { firstCompletedAt: new Date().toISOString(), thirdStepStatus: 'completed', urlLatencyMs: 100 }
  assert.equal(eventWaitVerdict('success', [{ accepted: true }], [{ accepted: true }],
    facts, observation, 60_000, true).passed, true)
  const missed = eventWaitVerdict('success', [{ accepted: true }], [], facts,
    { ...observation, thirdStepStatus: 'timed_out', urlLatencyMs: null }, 60_000, true)
  assert.deepEqual(missed.violations, ['url-not-processed-once', 'third-step-not-completed', 'url-deadline-missed'])
  assert.equal(eventWaitVerdict('success', [{ accepted: false }, { accepted: true }], [{ accepted: true }],
    facts, observation, 60_000, true).passed, false)
  assert.equal(eventWaitVerdict('success', [{ accepted: true }], [{ accepted: true }], facts,
    { ...observation, urlLatencyMs: 60_000 }, 60_000, true).passed, false)
  assert.equal(eventWaitVerdict('failure', [], [], [{ status: 'completed', content: 'First run failed' }],
    { ...observation, thirdStepStatus: 'pending', urlLatencyMs: null }, 60_000, true).passed, true)
})

test('mechanism classification uses executed tools and actual foreground duration/background receipts', () => {
  const at = '2026-10-03T00:00:00.000Z'
  const finishedAt = '2026-10-03T00:01:00.000Z'
  assert.deepEqual(eventWaitStrategies([
    { at, name: 'invoke_tool', args: { name: 'event_source', args: { action: 'create' } }, result: 'Created event source custom:test' },
    { at, name: 'event_subscribe', args: { action: 'subscribe' }, result: 'Subscribed web:test' },
    { at, finishedAt, name: 'exec', args: { command: 'watch' } },
  ], [{ kind: 'process' }]), ['polling-event-source', 'event-subscribe', 'foreground-exec', 'foreground-exec-wait', 'background-exec'])
  assert.deepEqual(eventWaitStrategies([{ at, name: 'exec', args: { script: 'I will subscribe later' } }], []), [])
  assert.deepEqual(eventWaitStrategies([{ at, name: 'event_subscribe', args: { action: 'subscribe' }, result: 'Error: denied' }], []), [])
  assert.deepEqual(eventWaitStrategies([
    { at, finishedAt, name: 'invoke_tool', args: { name: 'github_actions', args: { action: 'watch', run_id: 1 } }, result: '{"conclusion":"success"}' },
    { at, finishedAt, name: 'github_actions', args: { action: 'watch_signal' }, result: '{"signal":{}}' },
  ], []), ['github-actions-run-watch', 'github-actions-signal-watch'])
  assert.deepEqual(eventWaitStrategies([{ at, name: 'invoke_tool', args: { name: 'event_source', args: null } }], []), ['invalid-invocation-arguments'])
  assert.deepEqual(eventWaitStrategies([{ at, finishedAt: at, name: 'exec', args: {},
    result: 'Execution ID: bg:1234' }], [{ kind: 'process' }]), ['background-exec'])
  assert.doesNotMatch(eventWaitPrompt('http://127.0.0.1:1234'), /event_subscribe|event_source|blocking|background/)
})
