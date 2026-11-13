import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createGitHubFixture } from '../testing/github.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { WorkflowRuntime } from './runtime.ts'
import { TestSignalProviderRuntime } from '../signals/providers/testing.ts'
import { GitHubService } from '../projects/github/service.ts'
import { GitHubStore } from '../projects/github/store.ts'
import { CronService } from '../cron/service.ts'

const host = { canUse: () => true, deliver: async () => { throw new Error('No LLM/inbox transform expected') } }

test('source v4 has no business subscriptions; old source identifiers cannot reactivate historical workflows', async () => withTempWorkspace(async directory => {
  const path = projectStoragePath(directory, '.signals', 'sources-v3.json')
  const old = JSON.stringify({ format: 3, instances: [{ id: 'old-source', code: 'must not execute' }], subscriptions: [{ id: 'old-subscription' }] })
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, old)
  const source = new TestSignalProviderRuntime(directory, { execute: async () => { throw new Error('No collection') } }, host.deliver, host.canUse, () => true)
  source.start()
  try {
    assert.throws(() => source.create('owner', { id: 'old-source', provider: 'github-issues', version: 1, secretRef: 'fixture' }), /identity reserved/)
    source.create('owner', { id: 'new-source', provider: 'github-issues', version: 1, secretRef: 'fixture' })
    source.subscribe('owner', { id: 'reader', instance: 'new-source', demand: { repository: 'test/repo' }, first: 'baseline', action: { kind: 'record' } })
    const stored = JSON.parse(await readFile(projectStoragePath(directory, '.signals', 'sources-v4.json'), 'utf8'))
    assert.equal(stored.format, 4); assert.equal(Object.hasOwn(stored, 'subscriptions'), false)
    const definition = source.workflow.inspect().definitions[0]
    assert.deepEqual(definition.binding?.demand, { repository: 'test/repo' })
    assert.throws(() => source.unsubscribe('owner', 'reader', 2), /revision conflict/)
    source.unsubscribe('owner', 'reader', 1)
    assert.equal(source.snapshot('owner').subscriptions.length, 0)
    assert.throws(() => source.subscribe('owner', { id: 'reader', instance: 'new-source', demand: { repository: 'test/repo' }, first: 'emit', action: { kind: 'record' } }), /Retired/)
    assert.equal(await readFile(path, 'utf8'), old)
  } finally { await source.stop() }
}))

test('GitHub typed signal admission recovers after restart with one Workflow outbox and no model call', async () => withTempWorkspace(async directory => {
  const f = await createGitHubFixture(directory)
  let restored: GitHubService | undefined, runtime: WorkflowRuntime | undefined
  try {
    await f.service.configureRepository('octo/demo', true, false)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent', events: ['ci'] })
    await f.workflows.stop(); f.workflows.start(true)
    f.remote.checks[0].conclusion = 'failure'
    await f.service.refresh('PR_2')
    assert.equal(f.delivered.length, 0)
    const admitted = f.workflows.inspect().runs[0]
    assert.equal(admitted.definition.source.kind, 'github-resource')
    assert.equal(admitted.definition.nodes[0].kind, 'github-notify')
    assert.equal(admitted.status, 'queued'); assert.equal(f.store.read().notifications.length, 0)
    await f.service.stop(); await f.workflows.stop()
    runtime = new WorkflowRuntime(directory, 'fixture', host); runtime.start(true)
    restored = new GitHubService(new GitHubStore(directory), f.client, { workflows: runtime, alignment: f.alignment, durableSession: () => true, changed: () => {}, emit: async event => { f.delivered.push(event) } })
    runtime.activate(); await runtime.drain(); await restored.refresh('PR_2'); await runtime.drain()
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].targetSessionId, 'worker')
    assert.deepEqual(f.delivered[0].audienceSessionIds, ['worker']); assert.equal(f.delivered[0].delivery?.urgency, 'silent')
    assert.equal(runtime.inspect().runs[0].status, 'completed')
    assert.equal(f.alignment.get(f.work.key).workflow?.status, 'pending')
  } finally { await restored?.stop(); await runtime?.stop(); await f.close() }
}))

for (const revoke of ['repository', 'subscription', 'link', 'assignment'] as const) test(`GitHub queued signal rechecks ${revoke} authority before target inbox acceptance`, async () => withTempWorkspace(async directory => {
  const f = await createGitHubFixture(directory)
  try {
    await f.service.configureRepository('octo/demo', true, false)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    const subscription = { resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'queue' as const, events: ['ci' as const] }
    await f.service.subscribe(subscription)
    await f.workflows.stop(); f.workflows.start(true)
    f.remote.checks[0].conclusion = 'failure'; await f.service.refresh('PR_2')
    if (revoke === 'repository') await f.service.configureRepository('octo/demo', false, false)
    if (revoke === 'subscription') await f.service.subscribe({ ...subscription, enabled: false })
    if (revoke === 'link') await f.service.unlink('PR_2', f.work.key)
    if (revoke === 'assignment') await f.alignment.assignNote({ kind: 'user' }, f.work.key, f.alignment.get(f.work.key).sequence, null)
    f.workflows.activate(); await f.workflows.drain()
    assert.equal(f.delivered.length, 0); assert.equal(f.workflows.inspect().runs[0].error, 'authority_unavailable')
    assert.equal(f.store.read().notifications.length, 0)
  } finally { await f.close() }
}))

test('Schedule cannot start without its required active runtime or reuse a removed identity', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'fixture', host)
  const cron = new CronService(directory, runtime)
  await assert.rejects(cron.start(), /active Workflow/)
  runtime.start(); await cron.start()
  try {
    const job = { session: 'fresh' as const, schedule: 'every 1h', task: 'fixture' }
    cron.addJob(job, 'id'); cron.removeJob('id'); await cron.flush()
    assert.throws(() => cron.addJob(job, 'id'), /Duplicate/)
  } finally { await cron.stop(); await runtime.stop() }
}))

test('GitHub checkpoint failure recollects the same transition without a second notification admission', async t => withTempWorkspace(async directory => {
  const f = await createGitHubFixture(directory)
  try {
    await f.service.configureRepository('octo/demo', true, false)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent', events: ['ci'] })
    const update = f.store.update.bind(f.store)
    let fail = true
    t.mock.method(f.store, 'update', (change: Parameters<GitHubStore['update']>[0]) => { if (fail) { fail = false; throw new Error('Synthetic checkpoint failure') }; update(change) })
    f.remote.checks[0].conclusion = 'failure'
    await assert.rejects(f.service.refresh('PR_2'), /checkpoint failure/)
    assert.equal(f.workflows.inspect().runs.length, 1); assert.equal(f.delivered.length, 0)
    await f.service.refresh('PR_2')
    assert.equal(f.workflows.inspect().runs.length, 1); assert.equal(f.delivered.length, 1)
    assert.equal(f.store.read().notifications.length, 0)
  } finally { await f.close() }
}))

test('default Schedule installation recovers its exact pre-jobs checkpoint without reviving retired identities', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'fixture', host); runtime.start()
  const cron = new CronService(directory, runtime); await cron.start()
  const definition = { session: 'fresh' as const, schedule: 'every 1h', task: 'default fixture' }
  const job = { ...definition, id: 'default:fixture', createdAt: '2026-01-01T00:00:00.000Z' }
  runtime.define({ id: 'schedule:default:fixture', source: { kind: 'schedule', id: job.id }, enabled: true, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'schedule-action', action: 'agent', job }] })
  try {
    await cron.ensureDefaultJob('fixture', definition)
    assert.deepEqual(cron.listJobs(), [job])
    assert.equal(JSON.parse(await readFile(projectStoragePath(directory, '.cron', 'jobs.json'), 'utf8')).jobs[0].id, job.id)
    cron.removeJob(job.id); await cron.flush(); await cron.ensureDefaultJob('fixture', definition)
    assert.equal(cron.listJobs().length, 0)
  } finally { await cron.stop(); await runtime.stop() }
}))

for (const action of ['stop', 'remove'] as const) test(`Schedule update cannot reinstall timers after concurrent ${action}`, async t => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'fixture', host); runtime.start()
  const cron = new CronService(directory, runtime); await cron.start()
  const id = cron.addJob({ session: 'fresh', schedule: 'every 1h', task: 'original' }); await cron.flush()
  let finish!: () => void
  const saving = new Promise<void>(resolve => { finish = resolve })
  const internals = cron as unknown as { saveJobs(): Promise<void>; scheduledJobs: Map<string, unknown> }
  t.mock.method(internals, 'saveJobs', () => saving)
  try {
    const update = cron.updateJob(id, { session: 'fresh', schedule: 'every 2h', task: 'revised' })
    if (action === 'stop') await cron.stop()
    else cron.removeJob(id)
    finish(); await update
    assert.equal(internals.scheduledJobs.size, 0)
  } finally { finish(); await cron.stop(); await runtime.stop() }
}))

test('historical Workflow namespace collision rejects GitHub subscription before saving authorization', async () => withTempWorkspace(async directory => {
  const f = await createGitHubFixture(directory)
  try {
    await f.service.configureRepository('octo/demo', true, false)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    const subscription = { resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent' as const, events: ['ci' as const] }
    const { digest } = await import('../projects/github/client.ts')
    const { githubSubscriptionSchema } = await import('../projects/github/contracts.ts')
    const id = `github:${digest(githubSubscriptionSchema.parse({ ...subscription, assignmentRevision: f.alignment.get(f.work.key).workflow!.assignmentRevision }))}`
    f.workflows.define({ id, owner: 'owner', source: { kind: 'external', id: 'unrelated' }, enabled: true, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'record' }] })
    await assert.rejects(f.service.subscribe(subscription), /identity is occupied/)
    assert.equal(f.store.read().subscriptions.length, 0)
    const { AuthorDefinition } = await import('./contracts.ts')
    for (const id of ['github:x', 'schedule:x', 'internal:x']) assert.equal(AuthorDefinition.safeParse({ id, name: 'Not a host', source: { kind: 'external', id: 'source' }, binding: { demand: {} }, enabled: true, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'record' }] }).success, false)
  } finally { await f.close() }
}))

test('stopping Schedule during async startup cannot reactivate its timers', async t => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'fixture', host); runtime.start()
  const cron = new CronService(directory, runtime)
  let finish!: () => void, loading!: () => void
  const loadStarted = new Promise<void>(resolve => { loading = resolve })
  const internals = cron as unknown as { loadJobs(): Promise<void>; scheduledJobs: Map<string, unknown> }
  t.mock.method(internals, 'loadJobs', async () => { loading(); await new Promise<void>(resolve => { finish = resolve }) })
  const starting = cron.start()
  try {
    await loadStarted; await cron.stop(); finish()
    await assert.rejects(starting, /startup superseded/)
    assert.equal(internals.scheduledJobs.size, 0)
    assert.throws(() => cron.addJob({ session: 'fresh', schedule: 'every 1h', task: 'No reactivation' }), /stopped/)
  } finally { finish?.(); await cron.stop(); await runtime.stop() }
}))
