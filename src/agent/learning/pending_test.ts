import assert from 'node:assert/strict'
import test from 'node:test'
import { LearningRuntime, learningTask } from './pipelines.ts'
import { LearningTools } from './tools.ts'
import { pendingCandidates } from './pending.ts'
import { fakeSessions } from './test-fixtures.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const candidate = { path: 'topics/event-source-polling.md',
  correction: 'Synthetic human selection replaces the earlier unchosen alternative: read-only VFS discovery, mutations via tools, no session share whitelist.',
  action: 'Correct the existing alternative-not-chosen statement, preserving unrelated guidance.',
  conditions: 'Requirement only; implementation and real-site acceptance unverified. Provider owns query/aggregation; infra stays lightweight. Revalidate against later human corrections.',
  evidence: [{ sessionId: 'web:source', physicalId: 'source-0', offset: 2, end: 4 }] }

test('partial candidate survives receipt, restart and retry without becoming a published effect', async () => withTempWorkspace(async workspace => {
  const f = fakeSessions(workspace, [{ sessionId: 'web:source', segmentIndex: 0, total: 6 }])
  let runtime = new LearningRuntime(f.sessions, 'a')
  const batch = runtime.ledger.create('reflector', [{ sessionId: 'web:source', physicalId: 'source-0', segmentIndex: 0, offset: 0, end: 6 }], [])
  runtime.ledger.bind(batch.id, 'cron:first')
  for (const sessionId of ['cron:first', 'cron:resume']) f.records.set(sessionId, { sessionId, segmentIndex: 0, projectId: 'a' })
  const context = (sessionId: string) => ({ sessionId, projectId: 'a', tools: {}, signal: new AbortController().signal }) as ExecutionContext
  let tools = new LearningTools(runtime)
  await assert.rejects(tools.result.execute({ status: 'partial', summary: 'unsaved', pendingCandidates: [{ ...candidate, evidence: [{ ...candidate.evidence[0], physicalId: 'other-physical' }] }] }, context('cron:first')), /exact assigned/)
  await tools.result.execute({ status: 'partial', summary: 'Correction identified, not saved; remaining scope unread.', pendingCandidates: [candidate] }, context('cron:first'))
  runtime.ledger.complete(batch.id)
  runtime = new LearningRuntime(f.sessions, 'a')
  assert.deepEqual(runtime.ledger.batch(batch.id).pendingCandidates, [candidate])
  assert.equal(runtime.ledger.cursor(batch.sources[0]), 0)
  assert.equal(runtime.ledger.batch(batch.id).artifacts.length, 0)
  runtime.ledger.bind(batch.id, 'cron:resume')
  tools = new LearningTools(runtime)
  assert.match(learningTask(runtime.ledger.batch(batch.id)), /Focused recovery.*UNSAVED/)
  await assert.rejects(tools.result.execute({ status: 'no_change', summary: 'Done' }, context('cron:resume')), /Unresolved candidates/)
  await assert.rejects(tools.result.execute({ status: 'partial', summary: 'Duplicate', resolutions: [{ path: candidate.path, outcome: 'duplicate', reason: 'already covered' }] }, context('cron:resume')), /fresh read_wiki/)
  const save = { action: 'save_wiki', path: candidate.path, revision: '', content: '# Corrected requirement\n\n' + candidate.correction + '\n\n' + candidate.conditions, summary: 'Sourced requirement correction; no implementation claim.', wikiEvidence: candidate.evidence }
  await assert.rejects(tools.memory.execute(save, context('cron:resume')), /fresh read_wiki/)
  await tools.memory.execute({ action: 'read_wiki', path: candidate.path }, context('cron:resume'))
  await assert.rejects(tools.memory.execute({ ...save, revision: 'a'.repeat(64) }, context('cron:resume')), /changed since read/)
  assert.equal(runtime.ledger.batch(batch.id).pendingCandidates?.length, 1)
  await tools.memory.execute(save, context('cron:resume'))
  await tools.result.execute({ status: 'partial', summary: 'Correction saved, other assigned messages still unread.', resolutions: [{ path: candidate.path, outcome: 'published', reason: 'Saved sourced correction with conditions and readback.' }] }, context('cron:resume'))
  const retained = new LearningRuntime(f.sessions, 'a').ledger.batch(batch.id)
  assert.deepEqual(retained.pendingCandidates, [])
  assert.equal(retained.candidateResolutions?.[0].outcome, 'published')
  assert.equal(retained.artifacts.length, 1)
  assert.equal(retained.events.length, 1)
  assert.equal(runtime.ledger.cursor(batch.sources[0]), 0)
}))

test('serialization is bounded, consolidated and rejects drafts and invalid physical ranges', () => {
  assert.equal(pendingCandidates.safeParse([candidate]).success, true)
  for (const value of [[candidate, candidate], Array.from({ length: 5 }, (_, i) => ({ ...candidate, path: `topics/test-${i}.md` })),
    [{ ...candidate, correction: 'x'.repeat(1201) }], [{ ...candidate, content: 'unvalidated draft' }],
    [{ ...candidate, evidence: [{ ...candidate.evidence[0], end: 2 }] }]]) {
    assert.equal(pendingCandidates.safeParse(value).success, false)
  }
})

test('duplicate and superseded dispositions require current page; pending omission never discards recovery', async () => withTempWorkspace(async workspace => {
  const f = fakeSessions(workspace, [{ sessionId: 'web:source', segmentIndex: 0, total: 6 }])
  const runtime = new LearningRuntime(f.sessions, 'a')
  const batch = runtime.ledger.create('reflector', [{ sessionId: 'web:source', physicalId: 'source-0', segmentIndex: 0, offset: 0, end: 6 }], [])
  for (const id of ['one', 'two', 'three']) f.records.set(id, { sessionId: id, segmentIndex: 0, projectId: 'a' })
  const ctx = (sessionId: string) => ({ sessionId, projectId: 'a', tools: {}, signal: new AbortController().signal }) as ExecutionContext
  runtime.ledger.bind(batch.id, 'one')
  let tools = new LearningTools(runtime)
  await tools.result.execute({ status: 'partial', summary: 'unsaved correction', pendingCandidates: [candidate] }, ctx('one'))
  runtime.ledger.complete(batch.id); runtime.ledger.bind(batch.id, 'two')
  tools = new LearningTools(runtime)
  await tools.result.execute({ status: 'partial', summary: 'No work capacity; still pending', pendingCandidates: [] }, ctx('two'))
  assert.equal(runtime.ledger.batch(batch.id).pendingCandidates?.length, 1)
  runtime.ledger.complete(batch.id); runtime.ledger.bind(batch.id, 'three')
  tools = new LearningTools(runtime)
  await tools.memory.execute({ action: 'read_wiki', path: candidate.path }, ctx('three'))
  await assert.rejects(tools.result.execute({ status: 'partial', summary: 'not published', resolutions: [{ path: candidate.path, outcome: 'published', reason: 'mere draft' }] }, ctx('three')), /unverified/)
  await tools.result.execute({ status: 'partial', summary: 'Synthetic later source invalidates the candidate; no automatic publication.', resolutions: [{ path: candidate.path, outcome: 'superseded', reason: 'In this synthetic case the proposed correction is unsupported by newer scoped evidence; retain no draft.' }] }, ctx('three'))
  assert.equal(runtime.ledger.batch(batch.id).artifacts.length, 0)
  assert.deepEqual(runtime.ledger.batch(batch.id).pendingCandidates, [])
}))
