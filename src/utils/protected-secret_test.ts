import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { protectedSecretStore, type SecretCommand } from './protected-secret.ts'

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`${platform} master key uses synthetic provider only, stdin secrets and verified readback`, t => {
    const root = join(process.cwd(), '.test-data', `protected-secret-${randomUUID()}`)
    t.after(() => rmSync(root, { force: true, recursive: true }))
    const master = randomBytes(32)
    let encoded: Buffer | undefined
    const calls: { exe: string; args: string[] }[] = []
    const run: SecretCommand = (exe, args, input) => {
      calls.push({ exe, args })
      assert.equal(args.join(' ').includes(master.toString('base64')), false)
      if (exe === 'powershell.exe') {
        assert.match(args.join(' '), /::CurrentUser/)
        assert.doesNotMatch(args.join(' '), /LocalMachine/)
        if (args.join(' ').includes('::Protect(')) {
          encoded = Buffer.from(input)
          return { status: 0, stdout: Buffer.from('synthetic-dpapi-cipher'), stderr: Buffer.alloc(0) }
        }
        assert.equal(input.toString(), 'synthetic-dpapi-cipher')
      } else if (args[0] === '-i') {
        encoded = Buffer.from(input.toString().match(/-w "([^"]+)"/)![1])
      } else if (args[0] === 'store') encoded = Buffer.from(input)
      else if (!encoded) return { status: platform === 'darwin' ? 44 : 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      return { status: 0, stdout: encoded ?? Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    const store = protectedSecretStore(root, run, platform)
    assert.equal(store.load(), undefined)
    store.save(master)
    assert.deepEqual(store.load(), master)
    assert.ok(calls.length >= 3)
    if (platform === 'win32') assert.equal(readFileSync(join(root, 'master-key.dpapi'), 'utf8'), 'synthetic-dpapi-cipher')
  })
}

test('locked, denied, malformed and unverified stores fail without leaking provider output', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const unavailable: SecretCommand = () => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.from('synthetic-private-output'), error: new Error('spawn') })
    assert.throws(() => protectedSecretStore('synthetic', unavailable, platform).save(randomBytes(32)), error => !String(error).includes('synthetic-private-output'))
  }
  const denied: SecretCommand = () => ({ status: 36, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  assert.throws(() => protectedSecretStore('synthetic', denied, 'darwin').load(), /locked/)
  const invalid: SecretCommand = () => ({ status: 0, stdout: Buffer.from('not-a-master-key'), stderr: Buffer.alloc(0) })
  assert.throws(() => protectedSecretStore('synthetic', invalid, 'darwin').save(randomBytes(32)), /Invalid/)
})
