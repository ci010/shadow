import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureDevelopmentSafegit } from './development-safegit.ts'

function fixture(present = false) {
  const calls: string[] = []
  return { calls, dependencies: {
    exists: async (_path: string) => present,
    prepare: async (_root: string, platform?: string, arch?: string) => { calls.push(`prepare:${platform}/${arch}`) },
    verify: async (_root: string, platform?: string, arch?: string) => { calls.push(`verify:${platform}/${arch}`) },
    status: async (binary: string) => { calls.push(`status:${binary}`); return { supported: true, version: 'checked' } },
  } }
}

test('missing development resources prepare the host target; matching resources only verify', async () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    const missing = fixture()
    await ensureDevelopmentSafegit('root', {}, platform, arch, missing.dependencies)
    assert.deepEqual(missing.calls, [`prepare:${platform}/${arch}`, `verify:${platform}/${arch}`])
    const cached = fixture(true)
    await ensureDevelopmentSafegit('root', {}, platform, arch, cached.dependencies)
    assert.deepEqual(cached.calls, [`verify:${platform}/${arch}`])
  }
})

test('invalid, partial or wrong-version packages fail closed without replacement', async () => {
  for (const reason of ['inventory', 'wrong executable format/architecture', 'version mismatch']) {
    const f = fixture(true)
    f.dependencies.verify = async () => { throw new Error(reason) }
    await assert.rejects(ensureDevelopmentSafegit('root', {}, 'darwin', 'arm64', f.dependencies),
      (error: Error) => error.message.includes('preparation failed') && String(error.cause).includes(reason))
    assert.deepEqual(f.calls, [])
  }
  const partial = fixture(true)
  partial.dependencies.exists = async path => !path.endsWith('release.json')
  partial.dependencies.verify = async () => { throw new Error('missing inventory') }
  await assert.rejects(ensureDevelopmentSafegit('root', {}, 'darwin', 'arm64', partial.dependencies))
  assert.deepEqual(partial.calls, [])
})

test('absolute override is validated without preparing or verifying bundled files', async () => {
  const f = fixture()
  const binary = resolve('explicit-safegit')
  await ensureDevelopmentSafegit('root', { SHADOW_SAFEGIT_PATH: binary }, process.platform, process.arch, f.dependencies)
  assert.deepEqual(f.calls, [`status:${binary}`])
  for (const path of ['', 'relative/safegit']) {
    await assert.rejects(ensureDevelopmentSafegit('root', { SHADOW_SAFEGIT_PATH: path }, 'darwin', 'arm64', f.dependencies))
  }
  f.dependencies.status = async () => { throw new Error('Expected pinned version') }
  await assert.rejects(ensureDevelopmentSafegit('root', { SHADOW_SAFEGIT_PATH: binary }, 'darwin', 'arm64', f.dependencies))
})

test('unsupported host fails without preparing resources', async () => {
  const f = fixture()
  await assert.rejects(ensureDevelopmentSafegit('root', {}, 'win32', 'arm64', f.dependencies))
  assert.deepEqual(f.calls, [])
})

test('dev and source start prepare before building/importing; installed entry is unchanged', async () => {
  const desktop = await readFile(new URL('./desktop.ts', import.meta.url), 'utf8')
  assert(desktop.indexOf("if (mode === 'dev') await ensureDevelopmentSafegit") < desktop.indexOf("await runPnpm(['build'])"))
  const start = await readFile(new URL('./start.ts', import.meta.url), 'utf8')
  assert(start.indexOf('await ensureDevelopmentSafegit') < start.indexOf("await import('../src/index.ts')"))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.scripts.start, /scripts\/start\.ts$/)
})
