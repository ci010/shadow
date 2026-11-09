import test from 'node:test'
import assert from 'node:assert/strict'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotWatermark } from './watermark.ts'
import type { BotHostScope } from './host-contract.ts'
import type { ExecutionContext } from '../tools/context.ts'

const scope: BotHostScope = { projectId: 'p', botId: 'demo', bindingKey: 'one', revision: 'r1', sessionId: 'bound', address: { projectId: 'p', botInstanceId: 'connection', platform: 'qq', conversationId: 'group:one' } }
const context = (signal = new AbortController().signal) => ({ projectId: 'p', sessionId: 'bound', signal }) as ExecutionContext

test('BOT watermark persists range and pending attempts; failed/cancelled processing never implicitly advances', async () => {
  await withTempWorkspace(async workspace => {
    let marks = new BotWatermark(workspace, 'p')
    const call = (input: Record<string, unknown>, ctx = context()) => marks.execute(scope, input, ctx) as Promise<any>
    const batch = await call({ action: 'prepare', source: 'feed', from: null, to: 'page-1' })
    await call({ action: 'claim', id: batch.id, attempt: 'first' })
    marks = new BotWatermark(workspace, 'p')
    let state = await call({ action: 'inspect' })
    assert.equal(state.cursors.feed, undefined)
    assert.equal(state.batches[0].state, 'running')
    const abort = new AbortController(); abort.abort()
    await assert.rejects(call({ action: 'ack', id: batch.id, attempt: 'first' }, context(abort.signal)), /abort/i)
    state = await call({ action: 'inspect' })
    assert.equal(state.cursors.feed, undefined)
    await call({ action: 'retry', id: batch.id, attempt: 'first', error: 'interrupted processing' })
    await call({ action: 'claim', id: batch.id, attempt: 'second' })
    await assert.rejects(call({ action: 'ack', id: batch.id, attempt: 'first' }), /attempt/i)
    await call({ action: 'ack', id: batch.id, attempt: 'second' })
    state = await call({ action: 'inspect' })
    assert.equal(state.cursors.feed, 'page-1')
    await assert.rejects(call({ action: 'prepare', source: 'feed', from: null, to: 'page-1' }), /cursor|range/i)
    await assert.rejects(call({ action: 'inspect', consumer: 'other' }), /fixed/)
    for (const other of [{ ...scope, bindingKey: 'two' }, { ...scope, botId: 'other' }, { ...scope, revision: 'r2' }]) {
      const isolated = await marks.execute(other, { action: 'inspect' }, context()) as any
      assert.deepEqual(isolated.cursors, {})
      await assert.rejects(marks.execute(other, { action: 'ack', id: batch.id, attempt: 'second' }, context()), /Unknown/)
    }
    await assert.rejects(marks.execute({ ...scope, projectId: 'other' }, { action: 'inspect' }, context()), /scope/)
    await assert.rejects(marks.execute({ ...scope, sessionId: 'other' }, { action: 'inspect' }, context()), /scope/)
  })
})

test('BOT watermark source quota is bounded without advancing any source', async () => {
  await withTempWorkspace(async workspace => {
    const marks = new BotWatermark(workspace, 'p')
    for (let i = 0; i < 32; i++) await marks.execute(scope, { action: 'prepare', source: `feed-${i}`, to: 'one' }, context())
    await assert.rejects(marks.execute(scope, { action: 'prepare', source: 'overflow', to: 'one' }, context()), /capacity/)
    const state = await marks.execute(scope, { action: 'inspect' }, context()) as any
    assert.equal(state.batches.length, 32)
    assert.deepEqual(state.cursors, {})
  })
})
