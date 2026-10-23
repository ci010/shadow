import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { createGitHubFixture, githubDefinition } from '../../testing/github.ts'
import { GitHubStore } from './store.ts'
import { GitHubService } from './service.ts'
import { randomUUID } from 'node:crypto'
import { writePrivateFile } from '../../config/store.ts'
import { parseGitHubUrl } from './contracts.ts'

test('GitHub URLs and project repository grants cannot escape to another host or inject shell paths', async () => withTempWorkspace(async home => {
  for (const url of ['http://github.com/octo/demo/issues/1', 'https://github.com.evil.test/octo/demo/issues/1',
    'https://user@github.com/octo/demo/issues/1', 'file:///octo/demo/issues/1', 'https://github.com/octo/demo/tree/main']) assert.throws(() => parseGitHubUrl(url))
  const f = await createGitHubFixture(home)
  try {
    assert.equal((await f.request('', undefined, false)).status, 401)
    assert.equal((await f.request('/repositories', { name: 'octo/demo', read: true, write: true }, false)).status, 401)
    assert.equal((await f.request('/links', { url: f.remote.issue.html_url })).status, 403)
    assert.equal(f.requests.length, 0)
    assert.equal((await f.request('/repositories', { name: 'octo/demo', read: true, write: false })).status, 200)
    assert.equal((await f.request('/links', { url: f.remote.issue.html_url, workKey: f.work.key })).status, 200)
    assert.equal((await f.request('/operations', { kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'Update' })).status, 403)
    assert.equal((await f.request('/operations', { actor: 'user', kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'Update' })).status, 400)
    assert.equal((await f.request('/resources/foreign/refresh', {})).status, 404)
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0)
  } finally { await f.close() }
}))

test('Issue import is unassigned, explicitly accepted, idempotent and survives a partial linkage receipt', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, false)
    const issue = await f.service.link(f.remote.issue.html_url)
    const first = await f.service.importIssue(issue.id, issue.sourceHash, githubDefinition)
    const again = await f.service.importIssue(issue.id, issue.sourceHash, githubDefinition)
    assert.equal(first.key, again.key)
    assert.equal(first.workflow?.assignee, null)
    assert.deepEqual(first.definition, githubDefinition)
    assert.equal(f.delivered.length, 0)
    f.store.update(state => { state.links = []; state.imports[0].workKey = undefined })
    assert.equal((await f.service.importIssue(issue.id, issue.sourceHash, githubDefinition)).key, first.key)
    assert.equal(f.works.workRecords().length, 2)
    const restored = new GitHubStore(home)
    assert.equal(restored.read().links[0].workKey, first.key)
    f.remote.issue.body = 'Changed remote requirement'
    await f.service.refresh(issue.id)
    assert.deepEqual(f.alignment.get(first.key).definition, githubDefinition)
    assert.notEqual(f.service.state().links[0].sourceHash, f.service.state().resources[0].sourceHash)
    assert.match(f.service.readVirtual('I_1'), /External GitHub snapshot/)
    assert.equal(f.service.references()[first.key][0].number, 1)
  } finally { await f.close() }
}))

test('exact write previews are required, reject remote/Work changes and publish only the approved text once', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    const input = { kind: 'comment' as const, resourceId: 'I_1', workKey: f.work.key, body: 'Only this explicit public summary.' }
    const preview = await f.service.prepare(input)
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0)
    assert.equal((await f.request(`/operations/${preview.id}/execute`, {})).status, 400)
    f.remote.issue.title = 'Updated title'
    await assert.rejects(f.service.execute(preview.id), /changed since preview/)
    const next = await f.service.prepare(input)
    const completed = await f.service.execute(next.id)
    await f.service.execute(next.id)
    assert.equal(completed.status, 'succeeded')
    assert.equal(f.remote.comments.length, 1)
    assert.equal(f.remote.comments[0].body, `${input.body}\n\n<!-- shadow-operation:${next.id} -->`)
    assert.equal(f.works.workEffects().length, 0)
    const stale = await f.service.prepare(input)
    await f.alignment.execute({ kind: 'user' }, 'update', f.work.key, 1,
      { definition: { ...githubDefinition, objective: 'New agreement' }, change: 'goal', reason: 'User revised scope', paused: false })
    await assert.rejects(f.service.execute(stale.id), /Work changed/)
    assert.equal(f.remote.comments.length, 1)
  } finally { await f.close() }
}))

test('unknown writes block duplicate publication and Work completion until marker reconciliation', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    const input = { kind: 'comment' as const, resourceId: 'I_1', workKey: f.work.key, body: 'A write whose reply may be lost.' }
    const preview = await f.service.prepare(input)
    f.remote.failAfterWrite = true
    await assert.rejects(f.service.execute(preview.id), /unknown/)
    assert.equal(f.store.read().operations[0].status, 'unknown')
    assert.equal(f.works.workEffects()[0].status, 'unknown')
    await assert.rejects(f.service.execute(preview.id), /cannot be replayed/)
    await assert.rejects(f.service.prepare(input), /unresolved/)
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'progress', f.work.key, 1,
      { expectedSequence: 1, status: 'done', result: { summary: 'Verified', evidence: [] } }), /effect|operation|unresolved/i)
    const reconciled = await f.service.reconcile(preview.id)
    assert.equal(reconciled.status, 'reconciled')
    assert.equal(f.remote.comments.length, 1)
    assert.equal(f.works.workEffects().length, 0)
    f.store.update(state => { state.operations[0].status = 'sending' })
    assert.equal(new GitHubStore(home).read().operations[0].status, 'unknown')
  } finally { await f.close() }
}))

test('PR creation binds exact remote branches, and inline replies use the original review thread endpoint', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    const input = { kind: 'create_pr' as const, repositoryId: 'R_demo', workKey: f.work.key, head: 'feature', base: 'main',
      title: 'A bounded correction', body: 'Description approved by the owner.', draft: true }
    const preview = await f.service.prepare(input)
    f.remote.head = 'c'.repeat(40)
    await assert.rejects(f.service.execute(preview.id), /changed since preview/)
    f.remote.head = 'a'.repeat(40)
    const fresh = await f.service.prepare(input)
    assert.equal((await f.service.execute(fresh.id)).status, 'succeeded')
    assert.equal(f.service.state().links[0].resourceId, 'PR_2')
    assert.equal(f.service.state().resources[0].ci, 'success')
    const reply = await f.service.prepare({ kind: 'reply', resourceId: 'PR_2', workKey: f.work.key, commentId: 20, body: 'Covered by the focused regression.' })
    await f.service.execute(reply.id)
    assert.ok(f.requests.some(request => request.method === 'POST' && request.path === 'repos/octo/demo/pulls/2/comments/20/replies'))
    assert.equal(f.alignment.get(f.work.key).workflow?.status, 'pending')
    f.remote.pull.merged = true
    await f.service.refresh('PR_2')
    assert.equal(f.alignment.get(f.work.key).workflow?.status, 'pending', 'Merged is not locally accepted')
  } finally { await f.close() }
}))

test('Issue closure observes local completion and never cancels or finishes Work by synchronization', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    const close = { kind: 'close_issue' as const, resourceId: 'I_1', workKey: f.work.key, reason: 'completed' as const }
    await assert.rejects(f.service.prepare(close), /completion gate/)
    await f.alignment.execute({ kind: 'user' }, 'progress', f.work.key, 1,
      { expectedSequence: 1, status: 'done', result: { summary: 'Acceptance verified', evidence: [] } })
    const preview = await f.service.prepare(close)
    await f.service.execute(preview.id)
    assert.equal(f.remote.issue.state_reason, 'completed')
    assert.equal(f.alignment.get(f.work.key).workflow?.status, 'done')
  } finally { await f.close() }
}))

test('subscriptions deliver changed snapshots only to their bound session and stop on reassignment, disablement or uncertain delivery', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'queue', events: ['ci', 'review', 'comments', 'source'] })
    await f.service.refresh('PR_2')
    assert.equal(f.delivered.length, 0, 'Initial snapshot is not replayed as an event')
    f.remote.checks[0].conclusion = 'failure'
    await f.service.refresh('PR_2'); await f.service.refresh('PR_2')
    assert.equal(f.delivered.length, 1)
    assert.deepEqual(f.delivered[0].audienceSessionIds, ['worker'])
    assert.equal(f.delivered[0].delivery?.urgency, 'queue')
    assert.match(f.delivered[0].content!, /not an instruction or approval/)
    assert.equal(f.alignment.get(f.work.key).workflow?.status, 'pending')
    f.remote.failDelivery = true
    f.remote.reviews[0].state = 'CHANGES_REQUESTED'
    await f.service.refresh('PR_2'); await f.service.refresh('PR_2')
    assert.equal(f.delivered.length, 2)
    assert.equal(f.service.state().notifications.at(-1)?.status, 'unknown')
    await f.service.resolveNotification(f.service.state().notifications.at(-1)!.id, false)
    f.remote.failDelivery = false
    await f.alignment.execute({ kind: 'user' }, 'assign', f.work.key, 1, { expectedSequence: 1, assignee: null, reason: 'Reassigned before starting' })
    f.remote.pull.body = 'Changed externally'
    await f.service.refresh('PR_2')
    assert.equal(f.delivered.length, 2, 'Old assignment never wakes a new executor')
    assert.match(f.service.state().notifications.at(-1)?.error ?? '', /assignment changed/)
    await f.service.configureRepository('octo/demo', false, false)
    assert.equal(f.service.state().subscriptions[0].enabled, false)
    assert.equal(f.service.virtualEntries().length, 0)
  } finally { await f.close() }
}))

test('own comments do not create feedback loops; failed reads retain explicit errors and complete snapshots', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    const issue = await f.service.link(f.remote.issue.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'I_1', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent', events: ['comments'] })
    const preview = await f.service.prepare({ kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'Owner update.' })
    await f.service.execute(preview.id); await f.service.refresh('I_1')
    assert.equal(f.delivered.length, 0)
    f.remote.failReads = true
    await assert.rejects(f.service.refresh('I_1'), /offline/)
    assert.equal(f.service.state().resources[0].id, issue.id)
    assert.match(f.service.state().errors.I_1, /offline/)
    f.remote.failReads = false
    await f.service.refresh('I_1')
    assert.equal(f.service.state().errors.I_1, undefined)
  } finally { await f.close() }
}))

test('repeated real status transitions and relinking produce distinct notifications, not permanent fingerprint suppression', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.pull.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'PR_2', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent', events: ['ci'] })
    for (const conclusion of ['failure', 'success', 'failure']) {
      f.remote.checks[0].conclusion = conclusion
      await f.service.link(f.remote.pull.html_url, f.work.key)
    }
    assert.equal(f.delivered.length, 3)
    assert.equal(new Set(f.delivered.map(event => event.id)).size, 3)
    assert.ok(f.delivered.every(event => event.delivery?.urgency === 'silent'))
    assert.match(f.delivered[0].content!, /v:github\/PR_2/)
  } finally { await f.close() }
}))

test('closing rechecks all linked Work and existing previews cannot bypass an unknown write', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    await f.alignment.execute({ kind: 'user' }, 'progress', f.work.key, 1,
      { expectedSequence: 1, status: 'done', result: { summary: 'Acceptance verified', evidence: [] } })
    const closure = await f.service.prepare({ kind: 'close_issue', resourceId: 'I_1', workKey: f.work.key, reason: 'completed' })
    await f.alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
      { title: 'Additional required work', assignee: null, definition: githubDefinition, reason: 'Additional acceptance is now required' })
    const additional = f.works.workRecords().find(work => work.key !== f.work.key)!
    await f.service.link(f.remote.issue.html_url, additional.key)
    assert.equal((await f.request(`/operations/${closure.id}/execute`, { confirm: true })).status, 409)
    const input = { kind: 'comment' as const, resourceId: 'I_1', workKey: f.work.key, body: 'Update' }
    const first = await f.service.prepare(input), second = await f.service.prepare(input)
    f.remote.failAfterWrite = true
    await assert.rejects(f.service.execute(first.id), /unknown/)
    await assert.rejects(f.service.execute(second.id), /unresolved/)
    assert.equal(f.remote.comments.length, 1)
  } finally { await f.close() }
}))

test('durable receipts settle only their matching connector effects; uncertain writes and deliveries are never replayed on restart', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    const preview = await f.service.prepare({ kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'Verified publication' })
    await f.service.execute(preview.id)
    const unrelated = randomUUID()
    f.works.startWorkEffect(preview.id, 'human:github', 'github.comment', [{ key: f.work.key, revision: 1 }])
    f.works.startWorkEffect(unrelated, 'worker', 'exec', [{ key: f.work.key, revision: 1 }])
    f.works.recoverWorkEffects()
    const restored = new GitHubService(new GitHubStore(home), f.client, { alignment: f.alignment, durableSession: () => true,
      emit: async () => { assert.fail('Recovery must not replay a delivery') }, changed: () => {} })
    assert.deepEqual(f.works.workEffects().map(effect => effect.id), [unrelated])
    await restored.stop()
    const pending = await f.service.prepare({ kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'Not sent' })
    f.store.update(state => { state.operations.find(operation => operation.id === pending.id)!.status = 'sending' })
    assert.equal(new GitHubStore(home).read().operations.find(operation => operation.id === pending.id)!.status, 'unknown')
    assert.equal(f.remote.comments.length, 1)
  } finally { await f.close() }
}))

test('store rejects duplicate identities atomically and cached VFS never exposes write drafts or disabled repositories', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    await f.service.prepare({ kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'Unpublished-private-draft' })
    assert.doesNotMatch(f.service.readVirtual('I_1'), /Unpublished-private-draft/)
    assert.throws(() => f.store.update(state => { state.resources.push(state.resources[0]) }), /Duplicate/)
    assert.equal(new GitHubStore(home).read().resources.length, 1)
    await f.service.configureRepository('octo/demo', false, false)
    assert.equal(f.service.readVirtual(''), '[]')
    assert.throws(() => f.service.readVirtual('I_1'), /not available/)
  } finally { await f.close() }
}))

test('inactive polling performs no network requests and stop fences queued operations', async t => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    f.service.start()
    t.mock.timers.tick(60000)
    await Promise.resolve()
    assert.equal(f.requests.length, 0)
    await f.service.stop()
    await assert.rejects(f.service.configureRepository('octo/demo', true, false), /stopped/)
  } finally { t.mock.timers.reset(); await f.close() }
}))

test('expired/cancelled previews never publish, and explicit no-effect and interrupted-outbox recovery remain separate', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    const input = { kind: 'comment' as const, resourceId: 'I_1', workKey: f.work.key, body: 'Not published' }
    const expired = await f.service.prepare(input)
    f.store.update(state => { state.operations[0].createdAt = new Date(Date.now() - 16 * 60000).toISOString() })
    await assert.rejects(f.service.execute(expired.id), /expired/)
    await f.service.cancel(expired.id)
    await assert.rejects(f.service.execute(expired.id), /cannot be replayed/)
    const uncertain = await f.service.prepare(input)
    f.store.update(state => { state.operations[1].status = 'unknown' })
    f.works.startWorkEffect(uncertain.id, 'human:github', 'github.comment', [{ key: f.work.key, revision: 1 }])
    await f.service.verifyNotApplied(uncertain.id, 'Owner inspected the resource and verified that nothing was published.')
    assert.equal(f.store.read().operations[1].status, 'not_applied')
    assert.equal(f.works.workEffects().length, 0)
    assert.equal(f.remote.comments.length, 0)
    await f.service.subscribe({ resourceId: 'I_1', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent', events: ['source'] })
    f.remote.failDelivery = true; f.remote.issue.body = 'A new source observation'
    await f.service.refresh('I_1')
    f.store.update(state => { state.notifications[0].status = 'sending' })
    assert.equal(new GitHubStore(home).read().notifications[0].status, 'unknown')
    assert.equal(f.delivered.length, 1)
  } finally { await f.close() }
}))

test('unknown PR creation reconciles and links its one existing PR without publishing twice', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    const preview = await f.service.prepare({ kind: 'create_pr', repositoryId: 'R_demo', workKey: f.work.key,
      head: 'feature', base: 'main', title: 'Verified change', body: 'An explicit summary', draft: true })
    f.remote.failAfterWrite = true
    await assert.rejects(f.service.execute(preview.id), /unknown/)
    assert.equal((await f.service.reconcile(preview.id)).status, 'reconciled')
    assert.equal(f.store.read().links[0].resourceId, 'PR_2')
    assert.equal(f.store.read().links[0].workKey, f.work.key)
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
    assert.equal(f.works.workEffects().length, 0)
  } finally { await f.close() }
}))

test('a copied operation marker cannot suppress a different external comment', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, true)
    await f.service.link(f.remote.issue.html_url, f.work.key)
    await f.service.subscribe({ resourceId: 'I_1', workKey: f.work.key, sessionId: 'worker', enabled: true, mode: 'silent', events: ['comments'] })
    const preview = await f.service.prepare({ kind: 'comment', resourceId: 'I_1', workKey: f.work.key, body: 'An owner update' })
    await f.service.execute(preview.id)
    f.remote.comments.push({ ...f.remote.comments[0], id: 901, user: { login: 'another-user' } })
    await f.service.refresh('I_1')
    assert.equal(f.delivered.length, 1)
  } finally { await f.close() }
}))

test('Windows atomic state replacement retries transient sharing locks but preserves old state on persistent failure',
  { skip: process.platform !== 'win32' }, async () => withTempWorkspace(async home => {
    let attempts = 0, locked = false
    const store = new GitHubStore(home, (path, content) => {
      attempts++
      if (attempts < 3 || locked) throw Object.assign(new Error('Synthetic replacement lock'), { code: 'EPERM' })
      writePrivateFile(path, content)
    })
    assert.equal(attempts, 3)
    locked = true
    assert.throws(() => store.update(state => { state.repositories.push({ id: 'R_demo', name: 'octo/demo', read: true, write: false }) }), /replacement lock/)
    assert.equal(attempts, 7, 'Persistent failures stop after four attempts')
    assert.equal(store.read().repositories.length, 0)
    assert.equal(new GitHubStore(home).read().repositories.length, 0)
  }))
