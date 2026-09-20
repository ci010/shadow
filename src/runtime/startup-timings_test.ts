import assert from 'node:assert/strict'
import test from 'node:test'
import { StartupTimings } from './startup-timings.ts'

test('startup timing emits bounded structured stages, never operation values or errors', async t => {
  const messages: string[] = []
  t.mock.method(console, 'info', (message: string) => messages.push(message))
  const timing = new StartupTimings('project', 'default')
  assert.equal(await timing.measure('config', () => 'SYNTHETIC-PRIVATE-CONFIG'), 'SYNTHETIC-PRIVATE-CONFIG')
  const error = new Error('SYNTHETIC-PRIVATE-ERROR')
  await assert.rejects(timing.measure('sessions', () => { throw error }), cause => cause === error)
  timing.ready()
  const records = messages.map(message => JSON.parse(message.slice('[startup] '.length)))
  assert.deepEqual(records.map(record => [record.phase, record.status]), [
    ['config', 'started'], ['config', 'completed'], ['sessions', 'started'], ['sessions', 'failed'], ['ready', 'completed'],
  ])
  assert.doesNotMatch(messages.join('\n'), /SYNTHETIC-PRIVATE/)
  for (const record of records) {
    assert.equal(record.component, 'project')
    assert.equal(record.projectId, 'default')
    assert.ok(Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0)
    if (record.durationMs !== undefined) assert.ok(record.durationMs >= 0)
  }
})
