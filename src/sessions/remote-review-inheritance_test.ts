import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionManager } from './session-manager.ts'
import type { SessionState } from './session-store.ts'

function assertReviewPrompt(prompt: string) {
  assert.match(prompt, /Acceptance criteria:\nCorrect files\n/)
  assert.match(prompt, /address each original criterion separately: mark it passed, failed, or not verified, and give the actual evidence or describe the gap/)
  assert.match(prompt, /Distinguish independently verified evidence from the worker's claims/)
  assert.match(prompt, /Do not return pass if any required criterion failed or was not verified/)
  assert.match(prompt, /Do not add acceptance criteria/)
  assert.match(prompt, /Submission revision 1; artifact: submission-ref\nSubmission/)
}

// Isolate review construction from provider/executor IO. The reviewer must use
// the worker's opaque binding, not a local path or the creator's current folder.
for (const mode of ['parent', 'agent'] as const) test(`${mode} reviewer receives evidence rules; agent inherits worker remote binding`, async () => {
  const workdir = { version: 2 as const, nodeId: 'child-node', workdirId: 'opaque', displayPathSnapshot: 'Z:\\do-not-resolve-on-main' }
  const owner: SessionState = { sessionId: 'web:owner', segmentIndex: 2, mode: 'session' }
  const worker = {
    sessionId: 'virtual:worker', mode: 'task', workspaceRoot: 'web:owner', workdir, folderId: 'registered-folder',
    task: {
      creatorSessionId: owner.sessionId, revision: 1,
      submissions: [{ artifactRef: 'submission-ref' }],
      workflow: { mode, agentType: 'verify', assignment: 'Inspect remote files', criteria: 'Correct files' },
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
  const parentNotices: string[] = []
  manager.emitReviewOutcome = async (state: SessionState, kind: string, prompt: string) => {
    assert.equal(state, worker)
    assert.equal(kind, 'review')
    parentNotices.push(prompt)
  }
  manager.deliver = async (id: string, input: { content: string }) => {
    delivered = id
    assertReviewPrompt(input.content)
  }
  await manager.requestTaskReview(worker, { status: 'completed', content: 'Submission' })
  if (mode === 'parent') {
    assert.equal(parentNotices.length, 1)
    assertReviewPrompt(parentNotices[0]!)
    assert.equal(delivered, '')
    return
  }
  assert.deepEqual(parentNotices, [])
  assert.deepEqual(built?.workdir, workdir)
  assert.equal(built?.folderId, worker.folderId)
  assert.equal(built?.workspaceRoot, worker.workspaceRoot)
  assert.equal(built?.agentType, 'verify')
  assert.equal(built?.parentSessionId, owner.sessionId)
  assert.equal(delivered, worker.task?.workflow?.reviewerSessionId)
  assert.match(delivered, /^virtual:review-/)
})
