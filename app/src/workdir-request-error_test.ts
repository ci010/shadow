import assert from 'node:assert/strict'
import test from 'node:test'
import { useSessionFiles } from './composables/useSessionFiles.ts'
import { createGitFilesClient } from './git-files.ts'
import { isNodeOfflineError, nodeOfflineError } from './workdir-request-error.ts'

const offline = { error: 'workdir_unavailable', reason: 'node-offline', nodeId: 'child', workdirId: 'folder' }

test('only a validated locality node-offline response is classified as offline', () => {
  assert.equal(nodeOfflineError(503, offline)?.nodeId, 'child')
  assert.ok(nodeOfflineError(503, { ...offline, error: 'remote_workdir_unavailable' }))
  for (const value of [
    null, [], 'Node offline', { error: 'workdir_unavailable' },
    { ...offline, nodeId: '' }, { ...offline, workdirId: 12 },
    { error: 'workdir_unavailable', reason: 'node-offline', nodeId: 'child', capabilityId: 'folder' },
    { ...offline, reason: 'node-missing' }, { ...offline, reason: 'workdir-offline' },
    { ...offline, reason: 'workdir-revoked' }, { ...offline, reason: 'workdir-missing' },
    { ...offline, reason: 'incompatible' },
    { ...offline, error: 'remote_filesystem_failed', code: 'remote-node-unavailable' },
    { ...offline, error: 'remote_git_failed' },
  ]) assert.equal(nodeOfflineError(503, value), undefined, JSON.stringify(value))
  for (const status of [200, 400, 401, 403, 404, 409, 500, 501, 504]) {
    assert.equal(nodeOfflineError(status, offline), undefined)
  }
  assert.equal(isNodeOfflineError(new TypeError('Failed to fetch')), false)
})

test('file and Git clients preserve project routes, true offline status and genuine errors without local fallback', async t => {
  let response: unknown = offline
  let status = 503
  const urls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    urls.push(new URL(input))
    return Response.json(response, { status })
  })
  const signal = new AbortController().signal
  for (const folderId of [undefined, 'remote-folder']) {
    const files = useSessionFiles('http://fixture/projects/one/', folderId)
    const git = createGitFilesClient('http://fixture/projects/one/', 'remote-session', folderId)
    const operations = [() => files.listDir('remote-session'), () => files.preview('remote-session', 'notes.txt'),
      () => git.status(signal), () => git.diff('notes.txt', signal)]
    for (const operation of operations) {
      response = offline
      status = 503
      await assert.rejects(operation(), isNodeOfflineError)
      for (const [data, httpStatus, message] of [
        [{ error: 'folder_unavailable', message: 'The folder changed.' }, 409, /folder/i],
        [{ ...offline, reason: 'workdir-revoked' }, 503, /revoked/],
        [{ ...offline, reason: 'workdir-missing' }, 503, /resource/],
        [{ ...offline, reason: 'workdir-offline' }, 503, /resource/],
        [{ ...offline, reason: 'incompatible' }, 503, /Update Main and the device/],
        [{ error: 'execution-upgrade-required' }, 409, /Update Main and the device/],
        [{ ...offline, reason: 'node-missing' }, 503, /registered/],
        [{ error: 'remote_filesystem_failed', code: 'remote-node-unavailable' }, 503, /unavailable|Could not load/],
        [{ error: 'remote_workdir_requires_executor' }, 501, /support|Could not load/],
        [{ error: 'workdir_unavailable' }, 503, /unavailable|Could not load/],
        [offline, 403, /denied/],
        [{ error: 'file-not-found' }, 404, /no longer available/],
      ] as const) {
        response = data
        status = httpStatus
        await assert.rejects(operation(), error => !isNodeOfflineError(error) && error instanceof Error && message.test(error.message))
      }
    }
    assert.ok(urls.every(url => url.pathname.startsWith('/projects/one/api/')))
    assert.ok(urls.splice(0).every(url => url.pathname.includes(folderId ? '/folders/remote-folder/' : '/sessions/remote-session/')))
  }
})
