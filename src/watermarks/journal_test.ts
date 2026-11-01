import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Journal } from './journal.ts'
import { hostname } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(process.cwd(), '.tmp/journal-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'events.json')
}
const parse = (value: unknown) => value as { count: number }

test('journal releases owned lock after successful write and optimistic conflict', t => {
  const file = fixture(t)
  const first = new Journal(file, parse)
  const stale = new Journal(file, parse)
  first.save({ count: 1 })
  assert.equal(existsSync(`${file}.lock`), false)
  assert.throws(() => stale.save({ count: 2 }), /conflict/)
  assert.equal(existsSync(`${file}.lock`), false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { count: 1 })
})

test('journal never steals legacy or owned locks and preserves data', t => {
  const file = fixture(t)
  const journal = new Journal(file, parse)
  const lock = `${file}.lock`
  mkdirSync(lock)
  assert.throws(() => journal.save({ count: 1 }), { code: 'EEXIST' })
  const owner = JSON.stringify({ version: 1, pid: process.pid, hostname: 'test-host', acquiredAt: 'test' })
  writeFileSync(join(lock, 'owner.json'), owner)
  assert.throws(() => journal.save({ count: 2 }), { code: 'EEXIST' })
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), owner)
  assert.equal(existsSync(file), false)
})

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  assert.equal(child.status, 0)
  const pid = Number(child.stdout)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  return pid
}
function seedLock(file: string, owner: unknown) {
  mkdirSync(`${file}.lock`)
  writeFileSync(join(`${file}.lock`, 'owner.json'), JSON.stringify(owner))
}
function owner(pid: number) {
  return { version: 1, pid, hostname: hostname(), acquiredAt: '2000-01-01T00:00:00.000Z' }
}

test('journal recovers a definitively dead local writer and still checks revision', t => {
  const file = fixture(t)
  const journal = new Journal(file, parse)
  seedLock(file, owner(deadPid()))
  journal.save({ count: 1 })
  assert.equal(existsSync(`${file}.lock`), false)
  assert.equal(existsSync(`${file}.lock.recovery`), false)
  const stale = new Journal(file, parse)
  journal.save({ count: 2 })
  seedLock(file, owner(deadPid()))
  assert.throws(() => stale.save({ count: 3 }), /conflict/)
  assert.equal(existsSync(`${file}.lock`), false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { count: 2 })
})

test('live, foreign, malformed and incomplete owners are not reclaimed regardless of age', t => {
  const pid = deadPid()
  for (const metadata of [owner(process.pid), { ...owner(pid), hostname: 'foreign-host' },
    { ...owner(pid), version: 2 }, { ...owner(pid), pid: -1 }, { ...owner(pid), acquiredAt: 'invalid' }, {}]) {
    const file = fixture(t)
    seedLock(file, metadata)
    const before = readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8')
    assert.throws(() => new Journal(file, parse).save({ count: 1 }), { code: 'EEXIST' })
    assert.equal(readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8'), before)
    assert.equal(existsSync(file), false)
  }
  const file = fixture(t)
  seedLock(file, owner(pid))
  writeFileSync(join(`${file}.lock`, 'owner.json'), '{partial')
  assert.throws(() => new Journal(file, parse).save({ count: 1 }), { code: 'EEXIST' })
  assert.equal(readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8'), '{partial')
})

test('an abandoned recovery gate fails closed without touching the dead owner', t => {
  const file = fixture(t)
  seedLock(file, owner(deadPid()))
  mkdirSync(`${file}.lock.recovery`)
  const before = readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8')
  assert.throws(() => new Journal(file, parse).save({ count: 1 }), { code: 'EEXIST' })
  assert.equal(readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8'), before)
  assert.equal(existsSync(file), false)
})

test('competing processes recover without deleting replacement locks or losing revision checks', async t => {
  const file = fixture(t)
  seedLock(file, owner(deadPid()))
  const source = `import { Journal } from './src/watermarks/journal.ts';
    const journal = new Journal(process.argv[1], x => x);
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      try { journal.save({count: Number(process.argv[2])}); process.stdout.write('saved\\n') }
      catch (error) { if (error.code !== 'EEXIST' && !error.message.includes('conflict')) throw error; process.stdout.write('blocked\\n') }
    });`
  const children = Array.from({ length: 6 }, (_, index) => spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source, file, String(index)], { stdio: ['pipe', 'pipe', 'pipe'] }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  const results = children.map(child => new Promise<string>((resolve, reject) => {
    let output = ''; let errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(errors)))
  }))
  await Promise.all(children.map(child => new Promise<void>(resolve => child.stdout.once('data', () => resolve()))))
  for (const child of children) child.stdin.end('go')
  const outputs = await Promise.all(results)
  assert.equal(outputs.filter(output => output.includes('saved')).length, 1)
  assert.equal(existsSync(`${file}.lock`), false)
  assert.equal(existsSync(`${file}.lock.recovery`), false)
  assert.ok(Number.isInteger(JSON.parse(readFileSync(file, 'utf8')).count))
})

test('PID permission errors are ambiguous and preserve the lock', t => {
  const file = fixture(t)
  seedLock(file, owner(12345))
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) })
  const before = readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8')
  assert.throws(() => new Journal(file, parse).save({ count: 1 }), { code: 'EEXIST' })
  assert.equal(readFileSync(join(`${file}.lock`, 'owner.json'), 'utf8'), before)
})
