import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createGitHubFixture } from '../testing/github.ts'
import { WorkflowRuntime } from './runtime.ts'
import { OrganizationController } from '../projects/organization-controller.ts'
import { createProjectScope } from '../projects/scope.ts'

const noModel = { canUse: () => true, deliver: async () => { throw new Error('Unexpected model delivery') } }

test('GitHub resource subscription uses common run/effect state and never replays uncertain delivery automatically', async () => withTempWorkspace(async directory => {
  const f = await createGitHubFixture(directory)
  const runtime = f.workflows
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'queue', events: ['ci', 'review', 'source'] })
    await f.service.refresh('PR_2'); assert.equal(runtime.inspect().runs.length, 0)
    f.remote.checks[0].conclusion = 'failure'
    await f.service.refresh('PR_2'); await f.service.refresh('PR_2')
    assert.equal(runtime.inspect().runs.length, 1); assert.equal(runtime.inspect().runs[0].status, 'completed')
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].targetSessionId, 'worker')
    f.remote.failDelivery = true; f.remote.reviews[0].state = 'CHANGES_REQUESTED'
    await f.service.refresh('PR_2'); await f.service.refresh('PR_2'); await runtime.drain()
    const run = runtime.inspect().runs.at(-1)!
    assert.equal(run.status, 'blocked'); assert.equal(f.delivered.length, 2)
    assert.throws(() => runtime.manage(run.id, 'retry'), /acknowledgeReplay/)
    // Project host confirmation does not bypass revalidation of the bound Work assignment.
    const current = f.alignment.get(f.work.key)
    await f.alignment.assignNote({ kind: 'user' }, current.key, current.sequence, null)
    f.remote.failDelivery = false; runtime.manage(run.id, 'retry', true); await runtime.drain()
    assert.equal(f.delivered.length, 2)
    assert.equal(runtime.inspect().runs.at(-1)?.status, 'blocked')
    assert.equal(f.alignment.get(f.work.key).workflow?.status, 'pending')
  } finally { await runtime.stop(); await f.close() }
}))

test('event organizer source retains deterministic admission; model execution and uncertain outcomes are common Workflow nodes', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'fixture', noModel); runtime.start()
  const scope = createProjectScope('fixture')
  let calls = 0, delta = false, sequence = 0, fail = false
  const controller = new OrganizationController({ scope, changed: () => {}, hasDelta: async () => delta,
    organize: (mode, signal) => runtime.signalHost('organizer-fixture', { id: String(++sequence), data: { mode } }, 'confirm', signal),
  })
  runtime.bindHost('organizer-fixture', { current: () => controller.status().enabled, execute: async () => { if (!delta) return; calls++; if (fail) throw new Error('Uncertain agent effect'); return { sessionId: 'actual-organizer-session' } } })
  try {
    await controller.organize(new AbortController().signal, 'delta'); assert.equal(calls, 0)
    delta = true; await controller.organize(new AbortController().signal, 'delta')
    assert.equal(calls, 1); assert.equal(runtime.inspect().runs.at(-1)?.output?.sessionId, 'actual-organizer-session')
    fail = true; await assert.rejects(controller.organize(new AbortController().signal, 'delta'), /pending or blocked/)
    await assert.rejects(controller.organize(new AbortController().signal, 'delta'), /pending or blocked/)
    assert.equal(calls, 2)
    const run = runtime.inspect().runs.at(-1)!
    assert.equal(run.status, 'blocked'); assert.throws(() => runtime.manage(run.id, 'retry'), /acknowledgeReplay/)
    controller.update(false); runtime.manage(run.id, 'retry', true); await runtime.drain()
    assert.equal(calls, 2); assert.equal(runtime.inspect().runs.at(-1)?.error, 'authority_unavailable')
  } finally { await controller.stop(); await runtime.stop(); scope.close() }
}))
