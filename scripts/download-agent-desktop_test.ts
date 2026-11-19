import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { downloadAgentDesktop, unpackAgentDesktopArchive, verifyAgentDesktopArchive } from './download-agent-desktop.ts'
import { agentDesktopTarget } from './agent-desktop-integrity.ts'

function archive(entries: Array<{ name: string; type?: string; bytes?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const { name, type = '0', bytes = 'inert' } of entries) {
    const header = Buffer.alloc(512)
    header.write(name)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156)
    header.write(type, 156)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, Buffer.from(bytes), Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

test('all six targets pin CLI tarballs and matching required helper sets', () => {
  const hashes = new Set<string>()
  for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['x64', 'arm64']) {
    const target = agentDesktopTarget(platform, arch)
    assert.match(target.url, /^https:\/\/github.com\/vercel-labs\/agent-desktop\/releases\/download\/v1\.2\.0\/agent-desktop-v1\.2\.0-/)
    assert.ok(!target.name.includes('ffi'))
    assert.match(target.sha256, /^[a-f0-9]{64}$/)
    hashes.add(target.sha256)
    assert.deepEqual([...unpackAgentDesktopArchive(archive(target.files.map(name => ({ name }))), target.files).keys()], target.files)
  }
  assert.equal(hashes.size, 6)
})

test('archive rejection: missing helper, traversal, links, duplicate, empty and truncation', () => {
  const required = ['agent-desktop', 'agent-desktop-macos-helper']
  assert.throws(() => unpackAgentDesktopArchive(archive([{ name: required[0] }]), required), /Incomplete/)
  for (const entry of [{ name: '../outside' }, { name: '/absolute' }, { name: required[0], type: '2' },
    { name: required[0], type: '1' }, { name: required[0], type: 'x' }, { name: required[0], bytes: '' }]) {
    assert.throws(() => unpackAgentDesktopArchive(archive([entry]), required), /Unexpected/)
  }
  assert.throws(() => unpackAgentDesktopArchive(archive([{ name: required[0] }, { name: required[0] }]), required), /Unexpected/)
  assert.throws(() => unpackAgentDesktopArchive(Buffer.from('not gzip'), required))
  assert.throws(() => verifyAgentDesktopArchive(Buffer.from('wrong'), agentDesktopTarget('darwin', 'arm64').sha256), /SHA-256/)
})

test('hash mismatch never publishes install, lock is released; existing assets never overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-cli-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let downloads = 0
  const operations = { download: async () => { downloads++; return Buffer.from('not the locked archive') } }
  await assert.rejects(downloadAgentDesktop(root, 'linux', 'arm64', operations), /SHA-256/)
  const parent = join(root, 'integrations/agent-desktop/artifacts')
  assert.deepEqual(await readdir(parent), [])
  const existing = join(parent, 'linux-arm64')
  await mkdir(existing)
  await writeFile(join(existing, 'agent-desktop'), 'existing invalid user data')
  await assert.rejects(downloadAgentDesktop(root, 'linux', 'arm64', operations))
  assert.equal(downloads, 1)
  assert.deepEqual(await readdir(existing), ['agent-desktop'])
  await writeFile(join(parent, '.download-linux-arm64.lock'), 'another installer')
  await assert.rejects(downloadAgentDesktop(root, 'linux', 'arm64', operations), { code: 'EEXIST' })
  assert.equal(downloads, 1)
})
