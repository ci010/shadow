import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { unpackBundle, download, verifyArchiveDigest, installBundle } from './download-aria2.ts'
import { createHash } from 'node:crypto'

function archive(names: string[], type = '0', content: (name: string) => Buffer = () => Buffer.from('x')): Buffer {
  const blocks: Buffer[] = []
  for (const name of names) {
    const bytes = content(name)
    const h = Buffer.alloc(512)
    h.write(name); h.write('0000644\0', 100); h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    h.fill(32, 148, 156); h.write(type, 156)
    const sum = h.reduce((a, b) => a + b, 0)
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const names = ['aria2c', 'COPYING', 'LICENSE.OpenSSL', 'build-aria2-native.sh', 'aria2-1.37.0-source.tar.gz', 'THIRD-PARTY-NOTICES.txt', 'wslay-autoconf.patch']
test('safe complete tar bundle extracts only allowed regular files', () => {
  assert.equal(unpackBundle(archive(names), 'aria2c').size, 7)
  for (const bad of ['../aria2c', '/aria2c', 'directory/aria2c']) assert.throws(() => unpackBundle(archive([bad, ...names]), 'aria2c'), /Unsafe/)
  assert.throws(() => unpackBundle(archive([...names, 'aria2c']), 'aria2c'), /Unsafe/)
  assert.throws(() => unpackBundle(archive(names, '2'), 'aria2c'), /Unsafe/)
  assert.throws(() => unpackBundle(archive(names.slice(1)), 'aria2c'), /Incomplete/)
  assert.throws(() => unpackBundle(Buffer.from('not gzip'), 'aria2c'))
})
test('download rejects non TLS URLs and redirect overflow before network', () => {
  assert.throws(() => download('http://example.com'), /Unsafe/)
  assert.throws(() => download('https://example.com', 6), /Unsafe/)
})
test('archive SHA256 fails closed on tampering or malformed lock values', () => {
  const bytes = archive(names)
  const digest = createHash('sha256').update(bytes).digest('hex')
  verifyArchiveDigest(bytes, digest)
  assert.throws(() => verifyArchiveDigest(Buffer.concat([bytes, Buffer.from('tampered')]), digest), /SHA256/)
  for (const bad of ['', '0'.repeat(64), digest.toUpperCase()]) assert.throws(() => verifyArchiveDigest(bytes, bad), /SHA256/)
})

import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { desktopTarget } from './desktop-target.ts'

test('installer refuses existing links/unknown files, preserves prior bundle on failure, and swaps validated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria2-install-test-'))
  const dest = join(root, 'desktop', 'aria2')
  const recipe = Buffer.alloc(200, 120)
  const binary = Buffer.alloc(2048)
  binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4)
  const bytes = archive(names, '0', name => name === 'aria2c' ? binary : recipe)
  const target = desktopTarget('darwin', 'arm64')
  try {
    await mkdir(dest, {recursive:true}); await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts', 'build-aria2-native.sh'), recipe)
    await writeFile(join(root, 'scripts', 'wslay-autoconf.patch'), recipe)
    await writeFile(join(dest, 'BUILD.md'), recipe)
    await writeFile(join(root, 'outside'), 'untouched')
    // Windows file symlinks require an optional OS privilege; exercise this guard on Unix.
    if (process.platform !== 'win32') {
      await symlink(join(root, 'outside'), join(dest, 'aria2c'))
      await assert.rejects(installBundle(root, bytes, target), /Unexpected existing/)
      assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'untouched')
      await rm(join(dest, 'aria2c'))
    }
    await writeFile(join(dest, 'user-file'), 'preserve')
    await assert.rejects(installBundle(root, bytes, target), /Unexpected existing/)
    await rm(join(dest, 'user-file'))
    await writeFile(join(dest, 'aria2c'), 'old-binary')
    await assert.rejects(installBundle(root, bytes, target, async () => { throw new Error('loader failure') }), /loader failure/)
    assert.equal(await readFile(join(dest, 'aria2c'), 'utf8'), 'old-binary')
    await installBundle(root, bytes, target, async () => ({stdout:'aria2 version 1.37.0\n'}))
    assert.deepEqual(await readFile(join(dest, 'aria2c')), binary)
    assert.deepEqual(await readFile(join(dest, 'BUILD.md')), recipe)
    if (process.platform !== 'win32') assert((await stat(join(dest, 'aria2c'))).mode & 0o111)
  } finally { await rm(root, {recursive:true, force:true}) }
})

test('published lock covers all native targets and exact replayable recipe bytes', async () => {
  const lock = JSON.parse(await readFile(new URL('./aria2-native-lock.json', import.meta.url), 'utf8'))
  assert.equal(lock.release, 'aria2-1.37.0-shadow.1')
  assert.equal(lock.sourceRevision, '02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a')
  assert.match(lock.recipeCommit, /^[a-f0-9]{40}$/)
  assert.deepEqual(Object.keys(lock.assets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
  for (const [key, entry] of Object.entries(lock.assets) as [string, {url: string; sha256: string}][]) {
    assert.equal(entry.url, `https://github.com/ci010/shadow-native-deps/releases/download/${lock.release}/${lock.release}-${key}.tar.gz`)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
  }
  for (const name of ['build-aria2-native.sh', 'wslay-autoconf.patch']) {
    verifyArchiveDigest(await readFile(new URL(`./${name}`, import.meta.url)), lock.recipeFiles[name])
  }
  const script = await readFile(new URL('./build-aria2-native.sh', import.meta.url), 'utf8')
  assert.match(script, /patch -p1/)
  assert.match(script, /bash -n deps\/wslay\/configure/)
  const patch = await readFile(new URL('./wslay-autoconf.patch', import.meta.url), 'utf8')
  assert.match(patch, /\+AS_CASE/)
})
