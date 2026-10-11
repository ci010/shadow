import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { FolderRegistry } from '../folders/registry.ts'
import { ProjectActions } from './actions.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { projectActionsPlugin } from './action-routes.ts'

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.test-artifacts', 'actions-'))
  const home = join(root, 'home'), folder = join(root, 'folder')
  await mkdir(home); await mkdir(folder)
  const folders = new FolderRegistry(home); await folders.init()
  const record = await folders.register(folder)
  const actions = new ProjectActions(home, folders); await actions.init()
  const app = new Hono(); projectActionsPlugin(actions, req => req.headers.get('x-admin') === 'yes')(app)
  return { root, home, folder, folders, record, actions, app, async close() { await actions.shutdown(); await rm(root, { recursive: true, force: true }) } }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function finished(actions: ProjectActions, id: string) {
  for (let n = 0; n < 200; n++) { const run = actions.getRun(id); if (run.finishedAt) return run; await sleep(25) }
  throw new Error('Run did not finish')
}

test('persistent CRUD, strict validation, project isolation and copy safety', async () => {
  const f = await fixture()
  try {
    const action = await f.actions.create({ name: ' test ', command: 'echo works', folderId: f.record.id })
    assert.equal(action.name, 'test'); assert.equal(action.pinned, false)
    await f.actions.patch(action.id, { pinned: true })
    const loaded = new ProjectActions(f.home, f.folders); await loaded.init()
    assert.equal(loaded.list()[0].pinned, true)
    const list = loaded.list(); list[0].name = 'mutated'; assert.equal(loaded.list()[0].name, 'test')
    const otherHome = join(f.root, 'other'); await mkdir(otherHome)
    const other = new ProjectActions(otherHome, f.folders); await other.init(); assert.deepEqual(other.list(), [])
    assert.throws(() => f.actions.create({ name: 'x', command: 'echo x', folderId: f.record.id, extra: true }))
    assert.throws(() => f.actions.patch(action.id, {}))
    await f.actions.delete(action.id); assert.deepEqual(f.actions.list(), [])
    await assert.rejects(f.actions.delete(action.id), { code: 'action_not_found' })
  } finally { await f.close() }
})

test('all endpoints require admin authorization; malformed payloads are rejected', async () => {
  const f = await fixture()
  try {
    for (const [method, path] of [['GET', '/api/actions'], ['POST', '/api/actions'], ['GET', '/api/actions/scripts?folderId=x'], ['POST', '/api/actions/x/run'], ['POST', '/api/actions/runs/x/stop'], ['PATCH', '/api/actions/x'], ['DELETE', '/api/actions/x'], ['GET', '/api/actions/runs'], ['GET', '/api/actions/runs/x']]) {
      const response = await f.app.request(path, { method }); assert.equal(response.status, 403, `${method} ${path}`)
    }
    const bad = await f.app.request('/api/actions', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json' }, body: '{' }); assert.equal(bad.status, 400)
    const create = await f.app.request('/api/actions', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'run', command: 'echo done', folderId: f.record.id }) }); assert.equal(create.status, 201)
    const { action } = await create.json()
    const run = await f.app.request(`/api/actions/${action.id}/run`, { method: 'POST', headers: { 'x-admin': 'yes' } }); assert.equal(run.status, 202)
    await finished(f.actions, (await run.json()).run.id)
  } finally { await f.close() }
})

test('npm discovery reads registered local package, rejects remote before filesystem access', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', dev: 'vite' }, packageManager: 'untrusted-command' }))
    assert.deepEqual(await f.actions.scripts(f.record.id), { packageManager: 'npm', scripts: [{ name: 'test', command: 'npm run test', script: 'node --test' }, { name: 'dev', command: 'npm run dev', script: 'vite' }], unsupportedScripts: [] })
    await assert.rejects(f.actions.scripts('missing'), { code: 'folder_not_found' })
    let touched = false
    const remote = new ProjectActions(f.home, { get: () => ({ kind: 'remote', path: f.folder }), acquireAccess: () => () => {}, requireAvailable: () => { touched = true; throw new Error('must not access') } } as unknown as FolderRegistry)
    await assert.rejects(remote.scripts(f.record.id), { code: 'remote_actions_unsupported' }); assert.equal(touched, false)
    await assert.rejects(remote.create({ name: 'remote', command: 'echo bad', folderId: f.record.id }), { code: 'remote_actions_unsupported' }); assert.equal(touched, false)
  } finally { await f.close() }
})

test('runs capture final stdout/stderr, failure, capped logs and unavailable folders', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'run.cjs'), "process.stdout.write('x'.repeat(200000));process.stderr.write('error');process.exitCode=7")
    const action = await f.actions.create({ name: 'failure', command: 'node run.cjs', folderId: f.record.id })
    const run = await finished(f.actions, (await f.actions.run(action.id)).id)
    assert.equal(run.state, 'failed'); assert.equal(run.exitCode, 7); assert.equal(run.stdout.length, 128000); assert.equal(run.stderr, 'error')
    await rm(f.folder, { recursive: true })
    await assert.rejects(f.actions.run(action.id), { code: 'folder_unavailable' })
  } finally { await f.close() }
})

test('imported npm command preserves lifecycle hooks and rejects unsafe names', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'package.json'), JSON.stringify({ scripts: { precheck: 'echo before', check: 'echo main', postcheck: 'echo after', 'bad&name': 'echo unsafe' } }))
    const discovery = await f.actions.scripts(f.record.id)
    assert.deepEqual(discovery.unsupportedScripts, ['bad&name'])
    const command = discovery.scripts.find(s => s.name === 'check')!.command
    const action = await f.actions.create({ name: 'npm', command, folderId: f.record.id })
    const run = await finished(f.actions, (await f.actions.run(action.id)).id)
    assert.equal(run.state, 'succeeded')
    assert.match(run.stdout, /before/); assert.match(run.stdout, /main/); assert.match(run.stdout, /after/)
  } finally { await f.close() }
})

test('stop and project shutdown terminate owned long-running processes', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'long.cjs'), "console.log('started');setInterval(()=>{},1000)")
    const action = await f.actions.create({ name: 'long', command: 'node long.cjs', folderId: f.record.id })
    const first = await f.actions.run(action.id)
    await sleep(150)
    assert.equal((await f.actions.stop(first.id)).state, 'stopped')
    assert.equal((await f.actions.stop(first.id)).state, 'stopped')
    const second = await f.actions.run(action.id)
    await f.actions.shutdown()
    assert.equal(f.actions.getRun(second.id).state, 'stopped')
    await assert.rejects(f.actions.run(action.id), { code: 'actions_stopping' })
  } finally { await f.close() }
})


test('failed termination restores retryable state and a second stop succeeds', async () => {
  const f = await fixture(), processes = new ProcessManager()
  const actions = new ProjectActions(f.home, f.folders, processes)
  await actions.init()
  try {
    await writeFile(join(f.folder, 'retry.cjs'), "setInterval(()=>{},1000)")
    const action = await actions.create({ name: 'retry', command: 'node retry.cjs', folderId: f.record.id })
    const run = await actions.run(action.id)
    const terminate = processes.terminate.bind(processes)
    processes.terminate = async () => { throw new Error('Synthetic termination failure') }
    await assert.rejects(actions.stop(run.id), /Synthetic termination failure/)
    assert.equal(actions.getRun(run.id).state, 'running')
    processes.terminate = terminate
    assert.equal((await actions.stop(run.id)).state, 'stopped')
  } finally { await actions.shutdown(); await f.close() }
})
