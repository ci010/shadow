import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { BackgroundTaskManager } from './background-task.ts'
import { backgroundTasksPlugin } from './background-task-routes.ts'
import { createProjectScope } from '../projects/scope.ts'

function fixture(t: TestContext) {
  const bus = new Bus()
  const scope = createProjectScope('p')
  const events = new EventService('.', bus, async (sessionId, input) => ({ status: 'accepted', sessionId, inputId: input.id }))
  const tasks = new BackgroundTaskManager(bus, events, scope)
  t.after(async () => { await tasks.stop(); await events.stop(); bus.stopAll(); scope.close() })
  const app = new Hono()
  backgroundTasksPlugin(tasks, id => ['web:one', 'web:two'].includes(id))(app)
  return { app, tasks, bus }
}

test('background inventory includes only active tasks owned by the requested session', async t => {
  const { app, tasks } = fixture(t)
  const active = tasks.createDeferredTask({ kind: 'process', title: 'Synthetic server', sessionId: 'web:one' })
  tasks.createDeferredTask({ kind: 'tool', title: 'Finished tool', sessionId: 'web:one' }).complete('private output')
  tasks.createDeferredTask({ kind: 'process', title: 'Other session', sessionId: 'web:two' })
  tasks.createDeferredTask({ kind: 'process', title: 'Unbound process' })
  const response = await app.request('/api/sessions/web%3Aone/background-tasks')
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.sessionId, 'web:one')
  assert.equal(data.total, 1)
  assert.equal(data.tasks[0].id, active.taskId)
  assert.deepEqual(Object.keys(data.tasks[0]).sort(), ['createdAt', 'id', 'kind', 'sessionId', 'status', 'title'])
  assert.equal((await app.request('/api/sessions/unknown/background-tasks')).status, 404)
  assert.equal((await app.request('/api/sessions/%20/background-tasks')).status, 404)
})

test('separate project managers cannot disclose each other even with matching session IDs', async t => {
  const a = fixture(t)
  const b = fixture(t)
  a.tasks.createDeferredTask({ kind: 'process', title: 'Only A', sessionId: 'web:one' })
  const data = await (await b.app.request('/api/sessions/web%3Aone/background-tasks')).json()
  assert.deepEqual(data, { sessionId: 'web:one', total: 0, tasks: [] })
})

test('task inventory is bounded and reports the actual running count', async t => {
  const { tasks, app } = fixture(t)
  for (let i = 0; i < 105; i++) tasks.createDeferredTask({ kind: 'process', sessionId: 'web:one', title: 'x'.repeat(1000) })
  const data = await (await app.request('/api/sessions/web%3Aone/background-tasks')).json()
  assert.equal(data.total, 105)
  assert.equal(data.tasks.length, 100)
  assert.ok(data.tasks.every((task: { title: string }) => task.title.length === 512))
})

test('lifecycle invalidations observe committed task state and do not invoke process controls', async t => {
  const { tasks, bus } = fixture(t)
  const states: string[] = []
  let cancellations = 0
  bus.on('background.task.changed', fact => {
    const task = tasks.listTasks(fact.sessionId).find(task => task.id === fact.taskId)
    assert.equal(task?.status, fact.status)
    states.push(fact.status)
  })
  const a = tasks.createDeferredTask({ kind: 'process', title: 'A', sessionId: 'web:one', onCancel: () => { cancellations++ } })
  a.complete('done')
  a.complete('duplicate')
  const b = tasks.createDeferredTask({ kind: 'process', title: 'B', sessionId: 'web:one' })
  b.fail(new Error('Synthetic failure'))
  assert.deepEqual(states, ['running', 'completed', 'running', 'failed'])
  assert.equal(cancellations, 0)
})

test('cancelling work remains active in HTTP inventory until cleanup is confirmed', async t => {
  const { tasks, app } = fixture(t)
  const cleanup = Promise.withResolvers<void>()
  const task = tasks.createDeferredTask({
    kind: 'tool', title: 'Waiting for stop', sessionId: 'web:one', onCancel: () => cleanup.promise,
  })
  const cancel = tasks.cancelTask(task.taskId, { projectId: 'p', sessionId: 'web:one' })
  try {
    const pending = await (await app.request('/api/sessions/web%3Aone/background-tasks')).json()
    assert.equal(pending.total, 1)
    assert.equal(pending.tasks[0].status, 'cancelling')
    cleanup.resolve()
    await cancel
    const finished = await (await app.request('/api/sessions/web%3Aone/background-tasks')).json()
    assert.equal(finished.total, 0)
  } finally { cleanup.resolve(); await cancel }
})
