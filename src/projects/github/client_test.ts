import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { createGitHubFixture } from '../../testing/github.ts'
import { GitHubClient } from './client.ts'

test('snapshot checks and decisive reviews refer to the current head, and comments do not erase an approval', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home), signal = new AbortController().signal
  try {
    const repo = { id: 'R_demo', name: 'octo/demo', read: true, write: false }
    f.remote.reviews.push({ ...f.remote.reviews[0], id: 31, state: 'COMMENTED', submitted_at: '2026-09-26T00:01:00Z' })
    f.remote.inline.push({ ...f.remote.inline[0], id: 21, in_reply_to_id: 20 })
    let snapshot = await f.client.snapshot(repo, 'pr', 2, signal)
    assert.equal(snapshot.review, 'approved')
    assert.equal(snapshot.comments.find(comment => comment.id === 21)?.inReplyTo, 20)
    assert.equal(snapshot.reviews.length, 2)
    f.remote.reviews[0].commit_id = 'b'.repeat(40)
    snapshot = await f.client.snapshot(repo, 'pr', 2, signal)
    assert.equal(snapshot.review, 'commented', 'Approval of another commit does not approve this head')
    f.remote.statuses = [{ context: 'build', state: 'pending' }, { context: 'build', state: 'success' }]
    assert.equal((await f.client.snapshot(repo, 'pr', 2, signal)).ci, 'pending')
    f.remote.checks[0].conclusion = 'unknown_conclusion'
    assert.equal((await f.client.snapshot(repo, 'pr', 2, signal)).ci, 'failure')
    f.remote.statuses[0].state = 'unrecognized'
    await assert.rejects(f.client.snapshot(repo, 'pr', 2, signal))
  } finally { await f.close() }
}))

test('mixed PR heads and changed resource or repository identities never replace a complete snapshot', async () => withTempWorkspace(async home => {
  const f = await createGitHubFixture(home)
  try {
    await f.service.configureRepository('octo/demo', true, false)
    const original = await f.service.link(f.remote.pull.html_url)
    f.remote.onRequest = path => { if (path.includes('/check-runs')) f.remote.pull.head.sha = 'c'.repeat(40) }
    await assert.rejects(f.service.refresh('PR_2'), /changed while reading/)
    assert.equal(f.service.state().resources[0].fingerprint, original.fingerprint)
    f.remote.onRequest = undefined
    f.remote.pull.head.sha = 'a'.repeat(40)
    f.remote.pull.number = 3
    await assert.rejects(f.service.refresh('PR_2'), /resource identity/)
    f.remote.pull.number = 2; f.remote.repositoryId = 'R_other'
    await assert.rejects(f.service.refresh('PR_2'), /Repository identity changed/)
    assert.equal(f.service.state().resources[0].head, original.head)
  } finally { await f.close() }
}))

test('pagination reads the exact 1000-entry boundary and rejects incomplete larger collections', async () => {
  const signal = new AbortController().signal
  let count = 1000
  const client = new GitHubClient(async path => {
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page'))
    return Array.from({ length: Math.min(100, Math.max(0, count - (page - 1) * 100)) }, (_, index) => ({ id: (page - 1) * 100 + index }))
  })
  assert.equal((await client.pages('repos/octo/demo/issues/1/comments', signal)).length, 1000)
  count = 1001
  await assert.rejects(client.pages('repos/octo/demo/issues/1/comments', signal), /incomplete/)
})
