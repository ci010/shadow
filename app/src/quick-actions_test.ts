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
