import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { HomeMigrationError, migrateLegacyHome } from './home-migration.ts'

async function fixture(root: string) {
  const sourceHome = join(root, 'legacy')
  const targetHome = join(root, 'organizations', 'default', 'workspace')
  await mkdir(join(sourceHome, 'memory'), { recursive: true })
  await mkdir(join(sourceHome, '.sessions'))
  await writeFile(join(sourceHome, 'SOUL.md'), 'original identity\n')
  await writeFile(join(sourceHome, 'memory', 'unknown-user-data.bin'), new Uint8Array([0, 1, 255, 7]))
  return { sourceHome, targetHome, organizationId: 'default', sourceIsQuiescent: true as const }
}

test('Home migration preserves unknown files and JSONL bytes while preparing only the staging copy', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    const history = '{"role":"assistant","tool_calls":[{"id":"call-1"}]}\n{"role":"tool","tool_call_id":"call-1","content":"ok"}\n'
    await writeFile(join(options.sourceHome, '.sessions', 'session.jsonl'), history)
    const result = await migrateLegacyHome({
      ...options,
      async prepare(staged) { await writeFile(join(staged, 'organization.json'), '{"organizationId":"default"}') },
    })
    assert.equal(result.migrated, true)
    assert.equal(await readFile(join(result.targetHome, '.sessions', 'session.jsonl'), 'utf8'), history)
    assert.equal(await readFile(join(result.sourceHome, 'SOUL.md'), 'utf8'), 'original identity\n')
    assert.deepEqual(await readFile(join(result.targetHome, 'memory', 'unknown-user-data.bin')), Buffer.from([0, 1, 255, 7]))
    await assert.rejects(readFile(join(result.sourceHome, 'organization.json')), { code: 'ENOENT' })
    await writeFile(join(result.targetHome, 'SOUL.md'), 'updated in org\n')
    assert.equal((await migrateLegacyHome(options)).migrated, false)
    assert.equal(await readFile(join(result.targetHome, 'SOUL.md'), 'utf8'), 'updated in org\n')
  })
})

test('Home migration never overwrites an unrelated existing destination or accepts overlapping roots', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    await mkdir(options.targetHome, { recursive: true })
    await writeFile(join(options.targetHome, 'keep.txt'), 'untouched')
    await assert.rejects(migrateLegacyHome(options), { code: 'target-exists' })
    assert.equal(await readFile(join(options.targetHome, 'keep.txt'), 'utf8'), 'untouched')
    await assert.rejects(migrateLegacyHome({ ...options, targetHome: join(options.sourceHome, 'nested') }), { code: 'overlapping-homes' })
    await assert.rejects(migrateLegacyHome({ ...options, targetHome: root }), { code: 'overlapping-homes' })
  })
})

test('Home migration aborts changed-source and failed preparation without publishing or deleting the original', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    await assert.rejects(migrateLegacyHome({
      ...options,
      async prepare() { await writeFile(join(options.sourceHome, 'new.txt'), 'late writer') },
    }), { code: 'source-changed' })
    await assert.rejects(readFile(join(options.targetHome, 'SOUL.md')), { code: 'ENOENT' })
    assert.equal(await readFile(join(options.sourceHome, 'new.txt'), 'utf8'), 'late writer')
    await assert.rejects(migrateLegacyHome({
      ...options, prepare: async () => { throw new Error('metadata transform failed') },
    }), /metadata transform failed/)
    assert.deepEqual(await readdir(join(root, 'organizations', 'default')), [])
    assert.equal((await migrateLegacyHome(options)).migrated, true)
  })
})

test('Home migration keeps internal directory links inside the new Home and refuses external links', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(options.sourceHome, 'memory'), join(options.sourceHome, 'memory-alias'), type)
    await migrateLegacyHome(options)
    assert.equal(await realpath(join(options.targetHome, 'memory-alias')), await realpath(join(options.targetHome, 'memory')))
    const other = await fixture(join(root, 'second'))
    await symlink(options.sourceHome, join(other.sourceHome, 'outside'), type)
    await assert.rejects(migrateLegacyHome(other), { code: 'external-link' })
    assert.equal(await readFile(join(options.sourceHome, 'SOUL.md'), 'utf8'), 'original identity\n')
  })
})

test('Home migration copies a stopped SQLite WAL database as a complete consistent file set', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    const dbPath = join(options.sourceHome, '.sessions', 'sessions.db')
    const script = `import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('history-in-wal');");
      process.exit(0);`
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dbPath])
    const wal = await readFile(`${dbPath}-wal`)
    assert(wal.length > 0)
    await migrateLegacyHome(options)
    assert.deepEqual(await readFile(join(options.targetHome, '.sessions', 'sessions.db-wal')), wal)
    const reopened = new DatabaseSync(join(options.targetHome, '.sessions', 'sessions.db'))
    try { assert.equal(reopened.prepare('SELECT value FROM preserved').get()?.value, 'history-in-wal') }
    finally { reopened.close() }
    assert.deepEqual(await readFile(`${dbPath}-wal`), wal)
  })
})

test('Home migration retries an interrupted staging copy and resumes a verified ready journal', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    const module = new URL('./home-migration.ts', import.meta.url).href
    const script = `import { migrateLegacyHome } from ${JSON.stringify(module)};
      await migrateLegacyHome({...${JSON.stringify(options)}, prepare: async () => { process.exit(17); }});`
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]), { code: 17 })
    assert.equal((await migrateLegacyHome(options)).migrated, true)
    const markerPath = join(options.targetHome, '.organization-home-migration.v1.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    const stagingHome = `${options.targetHome}.migration-recovery-test`
    await rename(options.targetHome, stagingHome)
    await writeFile(`${options.targetHome}.migration.json`, JSON.stringify({ ...marker, stagingHome }))
    assert.equal((await migrateLegacyHome(options)).migrated, true)
    assert.equal(await readFile(join(options.targetHome, 'SOUL.md'), 'utf8'), 'original identity\n')
  })
})

test('Home migration rejects cancellation, concurrent attempts and foreign recovery metadata', async () => {
  await withTempWorkspace(async root => {
    const options = await fixture(root)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(migrateLegacyHome({ ...options, signal: controller.signal }), { name: 'AbortError' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = migrateLegacyHome({
      ...options, prepare: async () => { entered.resolve(); await release.promise },
    })
    await entered.promise
    try { await assert.rejects(migrateLegacyHome(options), { code: 'migration-running' }) }
    finally { release.resolve() }
    await first
    await assert.rejects(migrateLegacyHome({ ...options, organizationId: 'another-org' }), error =>
      error instanceof HomeMigrationError && error.code === 'invalid-journal')
  })
})
