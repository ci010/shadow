import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { DesktopConnectionStore, RuntimeConnectionPublication } from './publication.js'
import { assertProtectedWindowsFile, dpapi, parseConnectionDescriptor, readBoundedLocalFile } from './connection.js'

const authorization = { apiBase: 'http://127.0.0.1:43177', launchToken: 'synthetic'.padEnd(43, 'x') }

test('publication announces only completed writes and removes on stop', async () => {
  const calls: string[] = []
  const publication = new RuntimeConnectionPublication({
    store: { publish: async (auth) => {
      assert.deepEqual(auth, authorization)
      calls.push('write')
      return { path: 'safe-descriptor', renew: async () => {}, remove: async () => { calls.push('remove') } }
    } },
    isReady: () => true,
    onPublished: (path) => calls.push(path), onError: () => calls.push('error'), onUnavailable: () => {},
  })
  await publication.setAuthorization(authorization)
  assert.deepEqual(calls, ['write', 'safe-descriptor'])
  await publication.close()
  await publication.setAuthorization(authorization)
  assert.deepEqual(calls, ['write', 'safe-descriptor', 'remove'])
})

test('in-flight stale ready publication is cleaned up and never announced', async () => {
  const calls: string[] = []
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  const publication = new RuntimeConnectionPublication({
    store: { publish: async () => {
      entered()
      await wait
      return { path: 'safe', renew: async () => {}, remove: async () => { calls.push('remove') } }
    } },
    isReady: () => true, onPublished: () => calls.push('published'),
    onError: () => calls.push('error'), onUnavailable: () => {},
  })
  const ready = publication.setAuthorization(authorization)
  await started
  const stopped = publication.close()
  release()
  await Promise.all([ready, stopped])
  assert.deepEqual(calls, ['remove'])
})

test('publication failures are explicit and do not report success', async () => {
  const calls: string[] = []
  const publication = new RuntimeConnectionPublication({
    store: { publish: async () => { throw new Error(authorization.launchToken) } },
    isReady: () => true, onPublished: () => calls.push('published'),
    onError: () => calls.push('error'), onUnavailable: () => {},
  })
  await publication.setAuthorization(authorization)
  await publication.close()
  assert.deepEqual(calls, ['error'])
})

test('lease renews only while ready and cleans up when runtime becomes unavailable', async (t) => {
  const calls: string[] = []
  let ready = true
  const publication = new RuntimeConnectionPublication({
    refreshMs: 10,
    store: { publish: async () => ({
      path: 'safe', renew: async () => { calls.push('renew') },
      remove: async () => { calls.push('remove') },
    }) },
    isReady: () => ready, onPublished: () => {},
    onError: () => calls.push('error'), onUnavailable: () => calls.push('unavailable'),
  })
  t.after(() => publication.close())
  await publication.setAuthorization(authorization)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(calls.includes('renew'))
  ready = false
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(calls.slice(-2), ['unavailable', 'remove'])
})

test('desktop store persists only protected synthetic material and removes published files', async (t) => {
  const directory = resolve(`.web-publication-test-配对-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const published = await new DesktopConnectionStore(directory).publish(authorization)
  const descriptor = parseConnectionDescriptor(JSON.parse((await readBoundedLocalFile(published.path)).toString()))
  assert.ok('credentialProtection' in descriptor)
  const bytes = await readFile(descriptor.credentialPath)
  if (process.platform === 'win32') {
    assert.equal(descriptor.credentialProtection, 'windows-dpapi-current-user')
    assert.ok(!bytes.includes(Buffer.from(authorization.launchToken)))
    await assertProtectedWindowsFile(published.path)
    await assertProtectedWindowsFile(descriptor.credentialPath)
    assert.equal((await dpapi('Unprotect', bytes)).toString(), authorization.launchToken)
  } else {
    assert.equal(descriptor.credentialProtection, 'unix-owner-only')
    assert.equal((await lstat(descriptor.credentialPath)).mode & 0o077, 0)
    assert.equal(bytes.toString(), authorization.launchToken)
  }
  await published.renew()
  await published.remove()
  await assert.rejects(readFile(published.path), { code: 'ENOENT' })
  await assert.rejects(readFile(descriptor.credentialPath), { code: 'ENOENT' })
})
