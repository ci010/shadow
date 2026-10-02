import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { JsonlSessionStore } from '../src/sessions/session-store-jsonl.ts'
import { resolveSessionLocations } from '../src/sessions/locality.ts'
import { MicroAppStore } from '../src/microapps/store.ts'
import { exportAcceptanceRecovery } from './microapp-acceptance-recovery.ts'

async function fixture(home: string) {
  const state = { sessionId: 'a2a:recovery', segmentIndex: 0, mode: 'session' as const }
  const sessions = new JsonlSessionStore(join(home, '.sessions'))
  await sessions.init()
  await sessions.saveState(state.sessionId, state)
  const location = resolveSessionLocations(home, state).workdir
  assert.ok(location.available && location.locality === 'local')
  const directory = location.path, app = join(directory, 'app'), output = join(home, 'evidence')
  await mkdir(app, { recursive: true })
  const manifest = { version: 1, name: 'Recovery fixture', description: 'Fixture only', entry: 'index.html',
    files: ['index.html', 'helper.ps1'] }
  await writeFile(join(app, 'index.html'), 'published version')
  await writeFile(join(app, 'helper.ps1'), '\uFEFFWrite-Output "fixture"')
  await writeFile(join(app, 'shadow-app.json'), JSON.stringify(manifest))
  const store = new MicroAppStore(home)
  await store.init()
  const publication = await store.publish(app, manifest, state.sessionId, new AbortController().signal)
  return { directory, app, output, publication }
}

test('recovery preserves unpublished source bytes, BOM and publication differences, not grants or caches', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  await writeFile(join(f.app, 'index.html'), 'unpublished version')
  await writeFile(join(f.app, 'new-worker.py'), 'print("not yet published")')
  await writeFile(join(f.directory, '.env'), 'PRIVATE_FIXTURE=not-for-export')
  await mkdir(join(f.directory, 'test-data'))
  await writeFile(join(f.directory, 'test-data', 'private.json'), '{"secret":"not-for-export"}')
  const report = await exportAcceptanceRecovery(home, f.output, [f.publication])
  assert.equal(report.files, 4)
  const scope = JSON.parse(await readFile(join(f.output, ...report.scopes[0].archive.split('/')), 'utf8'))
  assert.equal(Buffer.from(scope.files['app/helper.ps1'].base64, 'base64').toString('utf8'), '\uFEFFWrite-Output "fixture"')
  assert.equal(Buffer.from(scope.files['app/index.html'].base64, 'base64').toString('utf8'), 'unpublished version')
  assert.deepEqual(scope.candidates[0].unlistedSourceFiles, ['new-worker.py'])
  assert.deepEqual(new Set(scope.candidates[0].comparisons[0].changedFiles), new Set(['index.html', 'new-worker.py']))
  assert.equal(scope.candidates[0].comparisons[0].publishedRevision, f.publication.revision)
  assert.notEqual(scope.candidates[0].sourceRevision, f.publication.revision)
  assert.ok(!JSON.stringify(scope).includes('not-for-export'))
  assert.equal(scope.restoresRuntimeState, false)
  const restored = new MicroAppStore(home)
  await restored.init()
  assert.equal(restored.get(f.publication.id).revision, f.publication.revision)
  assert.equal(restored.get(f.publication.id).approval, undefined)
}))

test('source recovery refuses injected runtime credentials and retains the original source', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  await writeFile(join(f.app, 'index.html'), 'synthetic-runtime-credential')
  await assert.rejects(exportAcceptanceRecovery(home, f.output, [f.publication], ['synthetic-runtime-credential']), /credential/)
  assert.equal(await readFile(join(f.app, 'index.html'), 'utf8'), 'synthetic-runtime-credential')
}))

test('recovery excludes arbitrarily named Python environments before scanning their dependencies', async () => withTempWorkspace(async home => {
  const f = await fixture(home), environment = join(f.directory, 'author-env')
  await mkdir(join(environment, 'Lib', 'site-packages'), { recursive: true })
  await writeFile(join(environment, 'pyvenv.cfg'), 'include-system-site-packages = false')
  for (let index = 0; index < 257; index++) {
    await writeFile(join(environment, 'Lib', 'site-packages', `dependency-${index}.py`), 'generated dependency')
  }
  await mkdir(join(f.directory, 'environment-source'))
  await writeFile(join(f.directory, 'environment-source', 'helper.py'), 'print("owned source")')
  const report = await exportAcceptanceRecovery(home, f.output, [f.publication])
  assert.equal(report.files, 4)
  assert.ok(report.scopes[0].excluded.some(entry => entry.path === 'author-env' && /pyvenv\.cfg/.test(entry.reason)))
  const scope = JSON.parse(await readFile(join(f.output, ...report.scopes[0].archive.split('/')), 'utf8'))
  assert.ok(scope.files['environment-source/helper.py'])
  assert.ok(Object.keys(scope.files).every(path => !path.startsWith('author-env/')))
}))

test('a linked environment marker does not hide ordinary source from recovery', async () => withTempWorkspace(async home => {
  const f = await fixture(home), folder = join(f.directory, 'source')
  await mkdir(folder)
  await symlink(f.app, join(folder, 'pyvenv.cfg'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(folder, 'helper.py'), 'print("preserve me")')
  const report = await exportAcceptanceRecovery(home, f.output, [f.publication])
  assert.equal(report.files, 4)
  assert.ok(report.scopes[0].excluded.some(entry => entry.path === 'source/pyvenv.cfg' && entry.reason === 'link not followed'))
}))

test('recovery skips external directory links and rejects oversized source rather than deleting it', async () => withTempWorkspace(async home => {
  const f = await fixture(home), outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'outside.py'), 'never export')
  await symlink(outside, join(f.app, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const report = await exportAcceptanceRecovery(home, f.output, [f.publication])
  assert.ok(report.scopes[0].excluded.some(entry => entry.path === 'app/linked' && entry.reason === 'link not followed'))
  await writeFile(join(f.app, 'oversized.py'), Buffer.alloc(4 * 1024 * 1024 + 1))
  await assert.rejects(exportAcceptanceRecovery(home, f.output, [f.publication]), /bounded owned regular file/)
  assert.equal((await readFile(join(f.app, 'oversized.py'))).length, 4 * 1024 * 1024 + 1)
}))

test('unfinished manifests are saved as source evidence, never published or declared complete', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  await writeFile(join(f.app, 'shadow-app.json'), '{"unfinished":')
  const report = await exportAcceptanceRecovery(home, f.output, [])
  assert.equal(report.scopes[0].candidates[0].manifestValid, false)
  assert.equal(report.files, 3)
}))
