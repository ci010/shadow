import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionManager } from './session-manager.ts'
import type { SessionState } from './session-store.ts'

// Isolate review construction from provider/executor IO. The reviewer must use
// the worker's opaque binding, not a local path or the creator's current folder.
test('agent reviewer inherits the submitted worker remote workdir and folder', async () => {
  const workdir = { version: 2 as const, nodeId: 'child-node', workdirId: 'opaque', displayPathSnapshot: 'Z:\\do-not-resolve-on-main' }
  const owner: SessionState = { sessionId: 'web:owner', segmentIndex: 2, mode: 'session' }
  const worker = {
    sessionId: 'virtual:worker', mode: 'task', workspaceRoot: 'web:owner', workdir, folderId: 'registered-folder',
    task: {
      creatorSessionId: owner.sessionId, revision: 1,
      submissions: [{ artifactRef: 'submission-ref' }],
      workflow: { mode: 'agent', agentType: 'verify', assignment: 'Inspect remote files', criteria: 'Correct files' },
    },
  } as unknown as SessionState
  let built: Parameters<SessionManager['buildSession']>[2]
  let delivered = ''
  const manager = Object.create(SessionManager.prototype) as any
  manager.sessionStates = { [owner.sessionId]: owner }
  manager.saveReviewTask = async (_state: SessionState, task: SessionState['task']) => { worker.task = task }
  manager.buildSession = async (_id: string, parent: { id: string }, fields: typeof built) => {
    assert.equal(parent.id, owner.sessionId)
    built = fields
  }
  manager.deliver = async (id: string) => { delivered = id }
  await manager.requestTaskReview(worker, { status: 'completed', content: 'Submission' })
  assert.deepEqual(built?.workdir, workdir)
  assert.equal(built?.folderId, worker.folderId)
  assert.equal(built?.workspaceRoot, worker.workspaceRoot)
  assert.equal(built?.agentType, 'verify')
  assert.equal(built?.parentSessionId, owner.sessionId)
  assert.equal(delivered, worker.task?.workflow?.reviewerSessionId)
  assert.match(delivered, /^virtual:review-/)
})
