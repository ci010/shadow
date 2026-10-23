import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { prepareSafegit, verifySafegitArchive, verifySafegitPackage } from './safegit-package.ts'
import { SAFEGIT_ARCHIVES, SAFEGIT_VERSION } from '../src/execution/git/safegit.ts'

test('release digests are pinned and reject unsupported/mismatched archives', () => {
  assert.equal(Object.keys(SAFEGIT_ARCHIVES).length, 5)
  for (const target of Object.keys(SAFEGIT_ARCHIVES)) {
    assert.match(SAFEGIT_ARCHIVES[target]!, /^[a-f0-9]{64}$/)
    assert.throws(() => verifySafegitArchive(Buffer.from('untrusted'), target), /SHA-256 mismatch/)
  }
  assert.throws(() => verifySafegitArchive(Buffer.from(''), 'windows_arm64'), /Unsupported/)
})

test('Unsupported platform preparation is a no-op, not a build-wide failure or substitute binary', async () => {
  await prepareSafegit('nonexistent-root', 'win32', 'arm64')
  await verifySafegitPackage('nonexistent-root', 'win32', 'arm64')
})

test('packaging includes safegit only on supported desktop targets', async () => {
  const pkg = JSON.parse(await readFile(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  assert(JSON.stringify(pkg.build.win.extraResources).includes('safegit.exe'))
  for (const target of ['mac', 'linux']) assert(pkg.build[target].extraResources.some((item: { from: string }) => item.from === 'safegit'))
})

test('real official archive checksum, binary extraction and tamper detection', async t => {
  const cache = resolve(`.tmp/safegit_${SAFEGIT_VERSION}_linux_amd64.tar.gz`)
  let bytes: Buffer
  try { bytes = await readFile(cache) } catch { t.skip('official archive not downloaded locally'); return }
  verifySafegitArchive(bytes, 'linux_amd64')
  const root = await mkdtemp(resolve('.tmp/safegit-package-test-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '.tmp'))
    await writeFile(join(root, `.tmp/safegit_${SAFEGIT_VERSION}_linux_amd64.tar.gz`), bytes)
    await prepareSafegit(root, 'linux', 'x64')
    await verifySafegitPackage(root, 'linux', 'x64')
    const binary = await readFile(join(root, 'desktop/safegit/safegit'))
    assert.equal(binary.toString('hex', 0, 4), '7f454c46')
    await writeFile(join(root, 'desktop/safegit/safegit'), 'tampered')
    await assert.rejects(verifySafegitPackage(root, 'linux', 'x64'), /inventory/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native Windows fork archive verifies PE, version, cache and tamper refusal', async t => {
  const archiveName = `safegit_${SAFEGIT_VERSION}_windows_amd64.tar.gz`
  let bytes: Buffer
  try { bytes = await readFile(resolve('.tmp', archiveName)) } catch { t.skip('fork Windows archive not downloaded locally'); return }
  verifySafegitArchive(bytes, 'windows_amd64')
  const root = await mkdtemp(resolve('.tmp/safegit-windows-test-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '.tmp'))
    await writeFile(join(root, '.tmp', archiveName), bytes)
    await prepareSafegit(root, 'win32', 'x64')
    await verifySafegitPackage(root, 'win32', 'x64')
    const binary = await readFile(join(root, 'desktop/safegit/safegit.exe'))
    assert.equal(binary.toString('ascii', 0, 2), 'MZ')
    await writeFile(join(root, 'desktop/safegit/safegit.exe'), 'tampered')
    await assert.rejects(verifySafegitPackage(root, 'win32', 'x64'), /inventory/)
    await writeFile(join(root, '.tmp', archiveName), 'corrupt cache')
    await assert.rejects(prepareSafegit(root, 'win32', 'x64'), /SHA-256 mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
