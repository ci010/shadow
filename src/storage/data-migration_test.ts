import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, toNamespacedPath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { copyDataMigration, planDataMigration } from './data-migration.ts'

const p = (path: string) => toNamespacedPath(path)
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(resolve('.'), '.test-layout-'))
  t.after(() => rm(p(root), { recursive: true, force: true }))
  async function put(path: string, data: string) {
    const dest = join(root, path)
    await mkdir(p(join(dest, '..')), { recursive: true })
    await writeFile(p(dest), data)
  }
  await put('config/bot.config.json', JSON.stringify({ agent: { workspace: 'old', name: 'test' }, secret: 'synthetic', opaque: { path: 'old' } }))
  await put('workspace.projects/projects.v2.json', JSON.stringify({ version: 2, projects: [{ id: 'default', name: 'Default', createdAt: '2026-01-01T00:00:00Z' }], folders: [{ path: 'external/untouched' }] }))
  await put('workspace.projects/projects/default/config/project.json', JSON.stringify({ agent: { workspace: 'old' }, untouched: 'old' }))
  await mkdir(p(join(root, 'workspace.projects/projects/default/workspace')), { recursive: true })
  await mkdir(p(join(root, 'workspace')), { recursive: true })
  const home = 'workspace.projects/projects/default/workspace/'
  return { root, put, home, text: (path: string) => readFile(p(join(root, path)), 'utf8') }
}

test('canonical mapping, opaque revisions, unknown Home workdirs, JSONL, config and idempotence', async t => {
  const f = await fixture(t)
  const jsonl = '{"workspace":"old","revision":"opaque"}\n'
  await f.put(f.home + '.sessions/session/history.jsonl', jsonl)
  await f.put(f.home + '.io/revisions/token', 'opaque-io')
  await f.put(f.home + '.microapps/bundle/v1.js', 'opaque-bundle')
  await f.put(f.home + 'memory/wiki.md', 'memory')
  await f.put(f.home + 'my-session/notes.txt', 'notes')
  await f.put(f.home + 'arbitrary-wal', 'not-a-database-companion')
  await f.put(f.home + '.env', 'SYNTHETIC=1')
  await f.put('cluster/identity.json', '{"key":"synthetic"}')
  const before = await f.text('config/bot.config.json')
  const tree = await readdir(f.root)
  const plan = await planDataMigration(f.root)
  assert.equal(plan.preliminary, true)
  assert.deepEqual(await readdir(f.root), tree)
  assert.equal((await copyDataMigration(f.root, { offline: true })).status, 'copied')
  assert.equal(await f.text('config/bot.config.json'), before)
  assert.equal(await f.text(f.home + '.sessions/session/history.jsonl'), jsonl)
  assert.equal(await f.text('projects/default/state/sessions/session/history.jsonl'), jsonl)
  assert.equal(await f.text('projects/default/state/io/revisions/token'), 'opaque-io')
  assert.equal(await f.text('projects/default/state/microapps/bundle/v1.js'), 'opaque-bundle')
  assert.equal(await f.text('projects/default/workdirs/my-session/notes.txt'), 'notes')
  assert.equal(await f.text('projects/default/workdirs/arbitrary-wal'), 'not-a-database-companion')
  assert.equal(await f.text('projects/default/config/.env'), 'SYNTHETIC=1')
  assert.equal(JSON.parse(await f.text('projects/default/config/project.json')).agent.workspace, join(f.root, 'projects/default'))
  assert.equal(JSON.parse(await f.text('app.json')).opaque.path, 'old')
  assert.equal(JSON.parse(await f.text('app.json')).agent.workspace, f.root)
  assert.deepEqual(JSON.parse(await f.text('projects/default/state/layout-migration.json')), { version: 1, legacyHome: resolve(f.root, f.home) })
  assert.equal((await copyDataMigration(f.root, { offline: true })).status, 'already-copied')
  await f.put('projects/default/workdirs/changed', 'change')
  await assert.rejects(copyDataMigration(f.root, { offline: true }), /Target since receipt changed/)
})

test('SQLite WAL recovered only in private scratch; committed rows preserved, source bytes unchanged', async t => {
  const f = await fixture(t)
  const dbPath = join(f.root, f.home, 'initiatives.sqlite')
  const db = new DatabaseSync(p(dbPath))
  let closed = false
  t.after(async () => { if (!closed) db.close() })
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE revisions (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO revisions VALUES(1, \'opaque\')')
  // Synthetic writer remains open but does not write during migration: tests WAL recovery,
  // not the operational offline precondition (which a flag cannot establish).
  const bytes = await Promise.all(['', '-wal', '-shm'].map(s => readFile(p(dbPath + s))))
  await copyDataMigration(f.root, { offline: true })
  for (let i = 0; i < 3; i++) assert.deepEqual(await readFile(p(dbPath + ['', '-wal', '-shm'][i])), bytes[i])
  const target = join(f.root, 'projects/default/state/initiatives.sqlite')
  const output = new DatabaseSync(p(target), { readOnly: true })
  try { assert.equal(output.prepare('SELECT body FROM revisions').get()!.body, 'opaque') } finally { output.close() }
  for (const suffix of ['-wal', '-shm', '-journal']) await assert.rejects(lstat(p(target + suffix)), { code: 'ENOENT' })
  db.close(); closed = true
})

for (const [title, setup, pattern] of [
  ['nonempty single Home', (f: Awaited<ReturnType<typeof fixture>>) => f.put('workspace/unknown', 'x'), /Nonempty/],
  ['uncatalogued project', (f: Awaited<ReturnType<typeof fixture>>) => f.put('workspace.projects/projects/other/workspace/file', 'x'), /Uncatalogued/],
  ['config collision', (f: Awaited<ReturnType<typeof fixture>>) => Promise.all([f.put('workspace.projects/projects/default/config/SOUL.md', 'one'), f.put(f.home + 'SOUL.md', 'two')]), /conflict/],
  ['unknown target', (f: Awaited<ReturnType<typeof fixture>>) => f.put('projects/default/preexisting', 'x'), /Unknown existing/],
] as const) test(`rejects ${title} without activation`, async t => {
  const f = await fixture(t)
  await setup(f)
  await assert.rejects(copyDataMigration(f.root, { offline: true }), pattern)
  await assert.rejects(lstat(join(f.root, 'app.json')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(f.root, '.layout-migration/copy.lock')), { code: 'ENOENT' })
})

test('staging failure and source instability never activate app or publish partial target', async t => {
  const f = await fixture(t)
  await assert.rejects(copyDataMigration(f.root), /offline/)
  await assert.rejects(copyDataMigration(f.root, { offline: true, onPhase: () => { throw new Error('injected staging failure') } }), /injected/)
  await assert.rejects(lstat(join(f.root, 'projects')), { code: 'ENOENT' })
  await assert.rejects(copyDataMigration(f.root, { offline: true, onPhase: phase => phase === 'staged' ? f.put(f.home + 'changed', 'new') : undefined }), /Source changed/)
  await assert.rejects(lstat(join(f.root, 'app.json')), { code: 'ENOENT' })
})

test('links and ancestor junctions rejected; exclusive existing lock is retained', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'destination'))
  await symlink(join(f.root, 'destination'), join(f.root, f.home, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(planDataMigration(f.root), /Links\/junctions/)
  await assert.rejects(planDataMigration(join(f.root, f.home, 'linked', 'nested')), /Links\/junctions/)
  await rm(join(f.root, f.home, 'linked'))
  await mkdir(join(f.root, '.layout-migration/copy.lock'), { recursive: true })
  await assert.rejects(copyDataMigration(f.root, { offline: true }), { code: 'EEXIST' })
  assert.equal((await lstat(join(f.root, '.layout-migration/copy.lock'))).isDirectory(), true)
})

test('long paths and file modes survive copy', async t => {
  const f = await fixture(t)
  const long = ['deep'.repeat(18), 'nested'.repeat(12), 'more'.repeat(18), 'file.txt'].join('/')
  await f.put(f.home + long, 'long path bytes')
  assert.ok(join(f.root, f.home, long).length > 260)
  if (process.platform !== 'win32') await chmod(join(f.root, f.home, long), 0o640)
  await copyDataMigration(f.root, { offline: true })
  assert.equal(await f.text('projects/default/workdirs/' + long), 'long path bytes')
  if (process.platform !== 'win32') assert.equal((await lstat(join(f.root, 'projects/default/workdirs', long))).mode & 0o777, 0o640)
})

test('partial publication failure rolls back only owned paths, leaving foreign target intact', async t => {
  const f = await fixture(t)
  await assert.rejects(copyDataMigration(f.root, { offline: true, onPhase: phase => phase === 'before-publish' ? f.put('projects/foreign', 'do not delete') : undefined }), /Target appeared/)
  assert.equal(await f.text('projects/foreign'), 'do not delete')
  await assert.rejects(lstat(join(f.root, 'projects.json')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(f.root, 'app.json')), { code: 'ENOENT' })
})

test('stage tampering is detected before publication', async t => {
  const f = await fixture(t)
  await assert.rejects(copyDataMigration(f.root, { offline: true, onPhase: async phase => {
    if (phase !== 'staged') return
    const stage = (await readdir(join(f.root, '.layout-migration'))).find(name => name.startsWith('stage-'))!
    await f.put(`.layout-migration/${stage}/app.json`, '{}')
  } }), /Staging changed/)
  await assert.rejects(lstat(join(f.root, 'app.json')), { code: 'ENOENT' })
})

test('receipt source hashes reject later source changes', async t => {
  const f = await fixture(t)
  await copyDataMigration(f.root, { offline: true })
  await f.put(f.home + 'new-source-file', 'new')
  await assert.rejects(copyDataMigration(f.root, { offline: true }), /Source since receipt changed/)
})

test('SQLite header detection handles arbitrary names and host database; ordinary -wal stays opaque', async t => {
  const f = await fixture(t)
  for (const path of ['workspace.projects/.host.otel.db', f.home + 'unusual.data']) {
    const db = new DatabaseSync(p(join(f.root, path)))
    db.exec('CREATE TABLE events(body BLOB); INSERT INTO events VALUES (X\'0001FF\')')
    db.close()
  }
  await f.put(f.home + 'not-a-db', 'text')
  await f.put(f.home + 'not-a-db-wal', 'opaque')
  await copyDataMigration(f.root, { offline: true })
  for (const path of ['telemetry/host.db', 'projects/default/workdirs/unusual.data']) {
    const db = new DatabaseSync(p(join(f.root, path)), { readOnly: true })
    try { assert.equal(db.prepare('SELECT hex(body) AS body FROM events').get()!.body, '0001FF') } finally { db.close() }
  }
  assert.equal(await f.text('projects/default/workdirs/not-a-db-wal'), 'opaque')
})

test('process interruption retains lock/staging and prevents an automatic retry', async t => {
  const f = await fixture(t)
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { copyDataMigration } from './src/storage/data-migration.ts';
    await copyDataMigration(process.argv[1], { offline: true, onPhase: () => process.exit(79) });
  `, f.root], { cwd: resolve('.'), encoding: 'utf8' })
  assert.equal(result.status, 79, result.stderr)
  const evidence = await readdir(join(f.root, '.layout-migration'))
  assert.ok(evidence.includes('copy.lock'))
  assert.ok(evidence.some(name => name.startsWith('stage-')))
  await assert.rejects(lstat(join(f.root, 'app.json')), { code: 'ENOENT' })
  await assert.rejects(copyDataMigration(f.root, { offline: true }), { code: 'EEXIST' })
})

test('hot SQLite rollback journal recovered from scratch without modifying source', async t => {
  const f = await fixture(t)
  const path = join(f.root, f.home, 'conventions.sqlite')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE items(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO items VALUES (1, 'committed'); BEGIN IMMEDIATE; UPDATE items SET body='uncommitted';");
    const insert = db.prepare('INSERT INTO items VALUES (?, ?)');
    for (let i=2;i<100;i++) insert.run(i, 'x'.repeat(8192));
    process.exit(0);
  `, p(path)], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const before = await readFile(p(path))
  const journal = await readFile(p(path + '-journal'))
  assert.ok(journal.length > 0)
  await copyDataMigration(f.root, { offline: true })
  assert.deepEqual(await readFile(p(path)), before)
  assert.deepEqual(await readFile(p(path + '-journal')), journal)
  const db = new DatabaseSync(p(join(f.root, 'projects/default/state/conventions.sqlite')), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get()!.n, 1)
    assert.equal(db.prepare('SELECT body FROM items').get()!.body, 'committed')
  } finally { db.close() }
  await assert.rejects(lstat(p(join(f.root, 'projects/default/state/conventions.sqlite-journal'))), { code: 'ENOENT' })
})


test('config migration replaces only workspace tokens without rounding opaque integers or formatting', async t => {
  const f = await fixture(t)
  const original = '{\n "agent": {"workspace":"old", "model":"synthetic"}, "opaque":9007199254740993, "escaped":"a\\nb", "array":[1e40,-0,{"id":9007199254740995}]\n}\n'
  await f.put('config/bot.config.json', original)
  await f.put('workspace.projects/projects/default/config/project.json', original)
  await copyDataMigration(f.root, { offline: true })
  assert.equal(await f.text('app.json'), original.replace('"workspace":"old"', `"workspace":${JSON.stringify(f.root)}`))
  assert.equal(await f.text('projects/default/config/project.json'), original.replace('"workspace":"old"', `"workspace":${JSON.stringify(join(f.root, 'projects', 'default'))}`))
  assert.equal(await f.text('config/bot.config.json'), original)
})

test('ambiguous duplicate configuration keys fail before canonical publication', async t => {
  const f = await fixture(t)
  await f.put('config/bot.config.json', '{"agent":{"workspace":"old"},"opaque":{"id":1,"id":2}}')
  await assert.rejects(copyDataMigration(f.root, { offline: true }), /Duplicate config JSON property/)
  await assert.rejects(lstat(join(f.root, 'app.json')), { code: 'ENOENT' })
})
