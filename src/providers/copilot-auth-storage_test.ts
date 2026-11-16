import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCopilotAuthStorage } from './copilot-auth-storage.ts'

function fixture(t: { after(fn: () => void): void }) {
  const root = join(process.cwd(), '.test-data', `protected-copilot-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let master: Buffer | undefined
  let unavailable = false
  const secrets = {
    load: () => { if (unavailable) throw new Error('synthetic locked'); return master && Buffer.from(master) },
    save: (value: Buffer) => { if (unavailable) throw new Error('synthetic locked'); master = Buffer.from(value) },
  }
  return { root, secrets, storage: createCopilotAuthStorage(root, secrets),
    lock: () => { unavailable = true }, loseKey: () => { master = undefined } }
}

test('encryption, disk reconstruction, random nonce, no plaintext master on disk', t => {
  const f = fixture(t), name = join(f.root, 'access-token')
  f.storage.write(name, 'synthetic-access-secret')
  assert.equal(existsSync(name), false)
  const first = readFileSync(`${name}.protected`, 'utf8')
  assert.equal(first.includes('synthetic-access-secret'), false)
  assert.equal(createCopilotAuthStorage(f.root, f.secrets).read(name), 'synthetic-access-secret')
  f.storage.write(name, 'synthetic-access-secret')
  assert.notEqual(readFileSync(`${name}.protected`, 'utf8'), first)
  assert.equal(existsSync(join(f.root, 'master-key')), false)
})

test('AAD binds host, instance, file type and data root even with same master key', t => {
  const f = fixture(t), source = join(f.root, 'access-token')
  f.storage.write(source, 'synthetic-secret')
  for (const target of [join(f.root, 'api-key.json'), join(f.root, 'hosts', 'octocat.ghe.com', 'access-token'), join(f.root, 'instances', 'other', 'access-token')]) {
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(`${source}.protected`, `${target}.protected`)
    assert.throws(() => f.storage.read(target))
  }
  const other = fixture(t), target = join(other.root, 'access-token')
  copyFileSync(`${source}.protected`, `${target}.protected`)
  assert.throws(() => createCopilotAuthStorage(other.root, f.secrets).read(target))
})

test('legacy migration verifies ciphertext before deleting plaintext, and cleanup retries fail closed', t => {
  const f = fixture(t), name = join(f.root, 'access-token')
  writeFileSync(name, 'synthetic-legacy')
  f.lock()
  assert.throws(() => f.storage.read(name))
  assert.equal(readFileSync(name, 'utf8'), 'synthetic-legacy')
  assert.equal(existsSync(`${name}.protected`), false)
  const g = fixture(t), legacy = join(g.root, 'api-key.json')
  writeFileSync(legacy, 'synthetic-legacy')
  assert.equal(g.storage.read(legacy), 'synthetic-legacy')
  assert.equal(existsSync(legacy), false)
  // Simulate undeletable legacy path without relying on root/Windows permission semantics.
  mkdirSync(legacy)
  assert.throws(() => g.storage.read(legacy))
  rmSync(legacy, { recursive: true })
  assert.equal(g.storage.read(legacy), 'synthetic-legacy')
})

test('tampered ciphertext and missing OS key never fall back to plaintext or replace master', t => {
  const f = fixture(t), name = join(f.root, 'access-token')
  f.storage.write(name, 'synthetic-secret')
  const raw = readFileSync(`${name}.protected`, 'utf8')
  writeFileSync(name, 'synthetic-fallback')
  writeFileSync(`${name}.protected`, raw.slice(0, -8) + randomBytes(6).toString('base64'))
  assert.throws(() => f.storage.read(name))
  f.loseKey()
  assert.throws(() => f.storage.write(name, 'synthetic-new'))
  assert.equal(readFileSync(name, 'utf8'), 'synthetic-fallback')
  f.storage.remove(name)
  assert.equal(existsSync(name), false)
  assert.equal(existsSync(`${name}.protected`), false)
})

test('unavailable provider does not block construction or empty status; writes fail closed', t => {
  const f = fixture(t)
  f.lock()
  const storage = createCopilotAuthStorage(f.root, f.secrets)
  assert.equal(storage.read(join(f.root, 'active-host')), undefined)
  assert.equal(storage.read(join(f.root, 'access-token')), undefined)
  assert.throws(() => storage.write(join(f.root, 'access-token'), 'synthetic-secret'))
  assert.equal(existsSync(join(f.root, 'access-token')), false)
})


test('concurrent master initialization fails closed without replacing a key or removing another lock', t => {
  const f = fixture(t), name = join(f.root, 'access-token')
  mkdirSync(join(f.root, '.protected-key-lock'))
  assert.throws(() => f.storage.write(name, 'synthetic-secret'))
  assert.equal(existsSync(join(f.root, '.protected-key-lock')), true)
  assert.equal(existsSync(`${name}.protected`), false)
  rmSync(join(f.root, '.protected-key-lock'), { recursive: true })
  f.storage.write(name, 'synthetic-secret')
  assert.equal(f.storage.read(name), 'synthetic-secret')
})

test('migration readback verification failure preserves original and refuses plaintext use', t => {
  const f = fixture(t), name = join(f.root, 'access-token')
  writeFileSync(name, 'synthetic-legacy')
  let wrong: Buffer | undefined
  const storage = createCopilotAuthStorage(f.root, {
    load: () => wrong && Buffer.from(wrong),
    save: () => { wrong = randomBytes(32) },
  })
  assert.throws(() => storage.read(name))
  assert.equal(readFileSync(name, 'utf8'), 'synthetic-legacy')
  assert.equal(existsSync(`${name}.protected`), true)
  assert.throws(() => storage.read(name))
})
