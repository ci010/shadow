import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { TopicService, type TopicServiceOptions } from './topics.ts'
import { ProposalInboxes } from './proposal-inbox.ts'
import type { SessionState } from './session-store.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(resolve('.tmp/inbox-registry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const states = new Map<string, SessionState>()
  let builds = 0, denied = false, crash = false
  const sessions = {
    async validateExecutionInference() {},
    getSessionState: (id: string) => states.get(id) ?? null,
    assertFolderAccess() { if (denied) throw Error('Inaccessible') }, assertInitiativeAccess() {}, updateConversationMetadata: async () => {},
    buildSession: async (id: string, _: unknown, fields: Partial<SessionState>) => {
      builds++; states.set(id, { sessionId: id, projectId: 'project', segmentIndex: 0, ...fields })
      if (crash) { crash = false; throw Error('Synthetic crash after durable session creation') }
    }, deliver: async () => { throw Error('Setup must not dispatch') },
  }
  const topics = new TopicService({ projectId: 'project', sessions: sessions as TopicServiceOptions['sessions'],
    folders: { acquireAccess: () => () => {} } as TopicServiceOptions['folders'], listStates: async () => [...states.values()], resolveAgent: () => ({ defaultMode: 'session' }), changed() {} })
  const registry = () => new ProposalInboxes({ projectId: 'project', directory, topics, sessions })
  return { directory, states, registry, builds: () => builds, deny: () => { denied = true }, crash: () => { crash = true } }
}

test('logical inbox concurrent first use, restart, busy, deleted replacement, uncertain pin and disabled stop', async t => {
  const f = await fixture(t), inbox = f.registry(), repo = 'owner/repo'
  assert.equal((await inbox.status('issue-triage')).phase, 'unbound')
  const ids = await Promise.all(Array.from({ length: 10 }, () => f.registry().resolve('issue-triage', repo)))
  assert.equal(new Set(ids).size, 1); assert.equal(f.builds(), 1)
  const id = ids[0]
  f.states.get(id)!.executionStatus = 'running'
  assert.equal(await f.registry().resolve('issue-triage', repo), id)
  assert.equal(f.builds(), 1)
  await inbox.setEnabled('issue-triage', false)
  await assert.rejects(inbox.resolve('issue-triage', repo), /disabled/)
  f.states.delete(id)
  await assert.rejects(inbox.resolve('issue-triage', repo), /disabled/)
  assert.equal(f.builds(), 1)
  await inbox.setEnabled('issue-triage', true)
  await assert.rejects(inbox.resolve('issue-triage', repo, id), /Uncertain/)
  assert.equal(f.builds(), 1)
  const next = await inbox.resolve('issue-triage', repo)
  assert.notEqual(next, id); assert.equal(f.builds(), 2)
  await assert.rejects(inbox.resolve('issue-triage', 'foreign/repo'), /mismatch/)
  f.deny(); await assert.rejects(inbox.resolve('issue-triage', repo), /Inaccessible/)
  assert.equal(f.builds(), 2)
})

test('create intent crash recovery reuses marked session; rejects foreign/task/unmarked sessions', async t => {
  const f = await fixture(t), repo = 'owner/repo'
  f.crash()
  await assert.rejects(f.registry().resolve('issue-triage', repo), /Synthetic crash/)
  const id = [...f.states.keys()][0]
  assert.equal(await f.registry().resolve('issue-triage', repo), id)
  assert.equal(f.builds(), 1)
  const state = f.states.get(id)!
  state.projectId = 'foreign'
  await assert.rejects(f.registry().resolve('issue-triage', repo), /Foreign/)
  state.projectId = 'project'; state.mode = 'task'
  await assert.rejects(f.registry().resolve('issue-triage', repo), /temporary/)
  state.mode = 'session'; state.topicRequestHash = 'unrelated'
  await assert.rejects(f.registry().resolve('issue-triage', repo), /already used/)
  assert.equal(f.builds(), 1)
})

test('explicit disable before first proposal creates no session; persisted project ownership fails closed', async t => {
  const f = await fixture(t), registry = f.registry()
  await registry.setEnabled('issue-triage', false, 'owner/repo')
  await assert.rejects(registry.resolve('issue-triage', 'owner/repo'), /disabled/)
  assert.equal(f.builds(), 0)
  const path = join(f.directory, (await readdir(f.directory)).find(n => n.endsWith('.json'))!)
  const record = JSON.parse(await readFile(path, 'utf8')); record.projectId = 'foreign'
  await writeFile(path, JSON.stringify(record))
  await assert.rejects(registry.resolve('issue-triage', 'owner/repo'), /Foreign/)
})

test('owner-only logical inbox control API is inert and rejects arbitrary session targets', async t => {
  const { Hono } = await import('hono')
  const { topicsPlugin } = await import('./topic-routes.ts')
  const f = await fixture(t)
  const app = new Hono()
  topicsPlugin({} as TopicService, request => request.headers.get('x-owner') === 'yes', f.registry())(app)
  const patch = (body: unknown, owner = true) => app.request('/api/proposal-inboxes/issue-triage', {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...(owner ? { 'x-owner': 'yes' } : {}) }, body: JSON.stringify(body),
  })
  assert.equal((await patch({ enabled: false, repository: 'owner/repo' }, false)).status, 401)
  assert.equal((await patch({ enabled: false, repository: 'owner/repo', sessionId: 'arbitrary' })).status, 400)
  assert.equal((await patch({ enabled: false, repository: 'owner/repo' })).status, 200)
  assert.equal(f.builds(), 0)
  assert.equal((await app.request('/api/proposal-inboxes/issue-triage')).status, 401)
  assert.equal((await app.request('/api/proposal-inboxes/issue-triage', { headers: { 'x-owner': 'yes' } })).status, 200)
  assert.equal(f.builds(), 0)
})

test('dedicated OS lock is exclusive and recovers after process exit without stale stealing', async t => {
  const { acquireDurableInboxLock } = await import('./durable-inbox-lock.ts')
  const { spawnSync } = await import('node:child_process')
  const f = await fixture(t), path = join(f.directory, 'synthetic-lock.sqlite')
  const release = acquireDurableInboxLock(path)
  assert.throws(() => acquireDurableInboxLock(path), /locked/)
  release()
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(path)}); db.exec('BEGIN EXCLUSIVE'); process.exit(0)`])
  assert.equal(child.status, 0)
  acquireDurableInboxLock(path)()
})

test('disable linearizes against admission and a resolved target cannot bypass the stop control', async t => {
  const f = await fixture(t), inbox = f.registry(), repo = 'owner/repo'
  const target = await inbox.resolve('issue-triage', repo)
  await inbox.setEnabled('issue-triage', false)
  let deliveries = 0
  await assert.rejects(inbox.admit('issue-triage', repo, target, async () => { deliveries++ }), /disabled/)
  assert.equal(deliveries, 0)
  await inbox.setEnabled('issue-triage', true)
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const admission = inbox.admit('issue-triage', repo, target, async () => { entered.resolve(); await finish.promise; deliveries++ })
  await entered.promise
  let disabled = false
  const stop = inbox.setEnabled('issue-triage', false).then(() => { disabled = true })
  await Promise.resolve(); assert.equal(disabled, false)
  finish.resolve(); await admission; await stop
  assert.equal(disabled, true); assert.equal(deliveries, 1)
})
