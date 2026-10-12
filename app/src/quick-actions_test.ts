import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuickActionsClient, parseQuickAction, parseActionRun } from './quick-actions.ts'
const action = { id: 'a', name: 'Build', command: 'npm run build', folderId: 'folder', pinned: false }
const run = { id: 'r', actionId: 'a', name: 'Build', command: 'npm run build', folderId: 'folder', state: 'running', startedAt: '2026-10-11T00:00:00Z', stdout: '', stderr: '' }
test('Quick Actions validates wire fields and run states', () => {
  assert.deepEqual(parseQuickAction(action), action)
  assert.throws(() => parseQuickAction({ ...action, folderId: '' }), /invalid/)
  assert.throws(() => parseQuickAction({ ...action, pinned: 'true' }), /invalid/)
  assert.deepEqual(parseActionRun(run), run)
  assert.throws(() => parseActionRun({ ...run, state: 'unknown' }), /invalid/)
  assert.throws(() => parseActionRun({ ...run, stdout: null }), /invalid/)
})
test('Quick Actions uses explicit project and folder scope for CRUD discovery runs and stop', async () => {
  const calls: { url: URL; init?: RequestInit }[] = []
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init })
    const payload = url.pathname.endsWith('/scripts') ? { scripts: [{ name: 'build', command: 'npm run build' }], packageManager: 'npm' }
      : init?.method === 'DELETE' ? { deletedActionId: 'a' } : url.pathname.endsWith('/stop') || url.pathname.endsWith('/run') ? { run }
      : init?.method ? { action } : { actions: [action] }
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  const client = createQuickActionsClient('http://fixture/projects/chat-project/', 'target-project', request)
  await client.actions(); await client.save({ name: 'Build', command: 'npm run build', folderId: 'folder' }); await client.save({ pinned: true }, 'a')
  await client.scripts('folder'); await client.run('a'); await client.stop('r'); await client.remove('a')
  assert.ok(calls.every(call => call.url.pathname.startsWith('/projects/target-project/api/actions')))
  assert.equal(calls[3]!.url.searchParams.get('folderId'), 'folder')
  assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), { name: 'Build', command: 'npm run build', folderId: 'folder' })
  await assert.rejects(client.save({ name: 'Build', command: 'echo build' }), /explicit target/)
  await assert.rejects(client.scripts(''), /Choose a target/)
})
test('Quick Actions rejects HTTP failures and mismatched identities', async () => {
  const failing = createQuickActionsClient('http://fixture', 'p', async () => new Response(JSON.stringify({ error: 'Remote folders are unavailable' }), { status: 400 }))
  await assert.rejects(failing.run('a'), /Remote folders/)
  const mismatch = createQuickActionsClient('http://fixture', 'p', async () => new Response(JSON.stringify({ action: { ...action, id: 'other' } })))
  await assert.rejects(mismatch.save({ pinned: true }, 'a'), /invalid/)
})

test('Quick Actions accepts the actual local FolderRecord wire shape and preserves explicit remote kinds', async () => {
  const { FolderRegistry } = await import('../../src/folders/registry.ts')
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  await mkdir('.test-artifacts', { recursive: true })
  const directory = await mkdtemp(resolve('.test-artifacts', 'quick-actions-folders-'))
  try {
    const registry = new FolderRegistry(directory)
    await registry.init()
    await registry.register(directory)
    const payload = registry.list()
    assert.equal(payload[0]?.kind, undefined, 'Local folder API intentionally does not require kind')
    const client = createQuickActionsClient('http://fixture', 'p', async () => new Response(JSON.stringify({ folders: payload })))
    assert.equal((await client.folders())[0]?.kind, 'local')
    const remote = createQuickActionsClient('http://fixture', 'p', async () => new Response(JSON.stringify({ folders: [{ id: 'remote', name: 'Remote', path: 'opaque', kind: 'remote' }] })))
    assert.equal((await remote.folders())[0]?.kind, 'remote')
    const malformed = createQuickActionsClient('http://fixture', 'p', async () => new Response(JSON.stringify({ folders: [{ id: 'remote', name: 'Remote', path: 'opaque', kind: 'unsupported' }] })))
    await assert.rejects(malformed.folders(), /invalid/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
