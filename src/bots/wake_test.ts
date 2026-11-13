import test from 'node:test'
import assert from 'node:assert/strict'
import { withTempWorkspace } from '../testing/workspace.ts'
import { TestCronService as CronService } from '../cron/testing.ts'
import { parseStoredCronJobs } from '../cron/service.ts'
import { BotWakes } from './wake.ts'
import type { BotHostScope } from './host-contract.ts'
import type { SessionInput } from '../sessions/input.ts'

const scope: BotHostScope = { projectId: 'p', botId: 'demo', revision: 'r1', bindingKey: 'binding', sessionId: 'bound-session',
  address: { projectId: 'p', platform: 'qq', botInstanceId: 'bot', conversationId: 'group:one' } }
const signal = () => new AbortController().signal

test('BOT wake uses durable cron inventory, stable tick identity, silent event and existing bound session', async () => {
  await withTempWorkspace(async workspace => {
    const inputs: SessionInput[] = []
    let permitted = true
    const authorize = (value: BotHostScope) => { assert.deepEqual(value, scope); if (!permitted) throw new Error('revoked') }
    const deliver = async (id: string, input: SessionInput) => { assert.equal(id, scope.sessionId); inputs.push(input); return { status: 'accepted' as const, sessionId: id, inputId: input.id } }
    const cron = new CronService(workspace)
    let restarted: CronService | undefined
    try {
      await cron.start()
      const wakes = new BotWakes(cron, deliver, authorize)
      await wakes.execute(scope, { action: 'set', intervalMinutes: 5 }, signal())
      await wakes.execute(scope, { action: 'set', intervalMinutes: 5 }, signal())
      assert.equal(cron.listJobs().length, 1)
      const job = cron.listJobs()[0]!
      await wakes.dispatch(job, signal(), 600000)
      await wakes.dispatch(job, signal(), 600001)
      assert.equal(inputs[0]!.id, inputs[1]!.id)
      assert.deepEqual(inputs[0]!.source, { kind: 'event', eventId: inputs[0]!.id, type: 'bot-wake', source: 'bot-wake', isGroup: true })
      assert.equal(inputs[0]!.kind, 'message')
      assert.equal(inputs[0]!.replyTo!.channelAddress!.conversationId, 'group:one')
      assert.equal((inputs[0] as { policy: string }).policy, 'queue', 'wake runs inference rather than archive-only silent admission')
      await cron.stop()
      restarted = new CronService(workspace)
      await restarted.start()
      const second = new BotWakes(restarted, deliver, authorize)
      assert.equal(restarted.listJobs().length, 1)
      await second.dispatch(restarted.listJobs()[0]!, signal(), 900000)
      assert.notEqual(inputs[2]!.id, inputs[0]!.id)
      permitted = false
      await assert.rejects(second.dispatch(restarted.listJobs()[0]!, signal(), 1200000), /revoked/)
      assert.equal(inputs.length, 3)
      permitted = true
      await restarted.setJobEnabled(job.id, false)
      await second.dispatch(job, signal(), 1200000)
      assert.equal(inputs.length, 3)
      await second.execute(scope, { action: 'stop' }, signal())
      await second.dispatch(job, signal(), 1500000)
      assert.equal(inputs.length, 3)
      assert.equal(restarted.listJobs().length, 0)
    } finally { await cron.stop(); await restarted?.stop() }
  })
})

test('wake rejects arbitrary targets, sub-minute cadence, malformed persistence and cancelled scheduling', async () => {
  await withTempWorkspace(async workspace => {
    const cron = new CronService(workspace)
    try {
      const wakes = new BotWakes(cron, async () => { throw new Error('must not deliver') }, () => {})
      for (const input of [{ action: 'set', intervalMinutes: 0 }, { action: 'set', intervalMinutes: 1, sessionId: 'other' }, { action: 'stop', destination: 'other' }]) await assert.rejects(wakes.execute(scope, input, signal()))
      const controller = new AbortController(); controller.abort()
      await assert.rejects(wakes.execute(scope, { action: 'set', intervalMinutes: 1 }, controller.signal), /abort/i)
      assert.equal(cron.listJobs().length, 0)
      await wakes.execute(scope, { action: 'set', intervalMinutes: 1 }, signal())
      const job = cron.listJobs()[0]!
      await assert.rejects(wakes.dispatch({ ...job, target: { sessionId: 'other' } }, signal()), /target/)
      assert.throws(() => parseStoredCronJobs({ version: 1, ownershipVersion: 2, jobs: [{ ...job, schedule: 'every 1s' }] }), /Invalid/)
    } finally { await cron.stop() }
  })
})
