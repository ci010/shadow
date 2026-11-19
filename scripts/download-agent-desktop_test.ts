import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { agentDesktopRelease, agentDesktopRevision, bundleFiles, unpackAgentDesktopBundle, validateNativePE, installAgentDesktop, nativeRecipeFingerprint } from './download-agent-desktop.ts'
import { verifyNativeBuild } from './agent-desktop-integrity.ts'
import { copyAgentDesktopAssets } from './agent-desktop-assets.ts'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function archive(names = bundleFiles, content: (name: string) => Buffer = () => Buffer.from('synthetic; never execute'), type = '0') {
  const blocks: Buffer[] = []
  for (const name of names) {
    const bytes = content(name), h = Buffer.alloc(512)
    h.write(name); h.write('0000644\0', 100); h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    h.fill(32, 148, 156); h.write(type, 156)
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
function pe(arch: string) {
  const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68); return bytes
}
test('native archive rejects traversal, links, duplicate/unknown files, malformed and incomplete tar', () => {
  assert.equal(unpackAgentDesktopBundle(archive()).size, bundleFiles.length)
  for (const name of ['../guard.exe', '/guard.exe', 'folder/guard.exe', 'C:\\guard.exe', 'LICENSE']) {
    assert.throws(() => unpackAgentDesktopBundle(archive([...bundleFiles, name])), /Unsafe/)
  }
  assert.throws(() => unpackAgentDesktopBundle(archive(bundleFiles, undefined, '2')), /Unsafe/)
  assert.throws(() => unpackAgentDesktopBundle(archive(bundleFiles.slice(1))), /Incomplete/)
  assert.throws(() => unpackAgentDesktopBundle(Buffer.from('not gzip')))
  for (const arch of ['x64', 'arm64']) {
    validateNativePE(pe(arch), arch)
    assert.throws(() => validateNativePE(pe(arch === 'x64' ? 'arm64' : 'x64'), arch), /architecture/)
  }
  assert.throws(() => validateNativePE(Buffer.alloc(2), 'x64'), /Invalid/)
})

test('pinned installation verifies digest/provenance and preserves prior assets; package carries full source/licenses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-desktop-download-'))
  const destination = join(root, 'integrations/agent-desktop/artifacts/win32-x64')
  try {
    await mkdir(destination, { recursive: true }); await mkdir(join(root, 'scripts'))
    const repository = new URL('../', import.meta.url)
    for (const name of ['integrations/agent-desktop/src', 'integrations/agent-desktop/patches', 'integrations/agent-desktop/scripts',
      'integrations/agent-desktop/Cargo.toml', 'integrations/agent-desktop/Cargo.lock', 'integrations/agent-desktop/build.rs',
      'integrations/agent-desktop/LICENSE', 'integrations/agent-desktop/NOTICE',
      'src/execution/computer/agent-desktop-worker.js', 'src/execution/computer/agent-desktop-errors.js',
      'src/execution/computer/stdio-transport.ts', 'src/execution/computer/windows-input.cs',
      'scripts/agent-desktop-input-guard.ts', 'scripts/agent-desktop-integrity.ts']) {
      await mkdir(join(root, name, '..'), { recursive: true })
      await cp(new URL(name, repository), join(root, name), { recursive: true })
    }
    const commit = 'a'.repeat(40)
    const content = new Map(bundleFiles.map(name => [name, name === 'shadow-agent-desktop.node' ? pe('x64') : Buffer.from('synthetic test source; never execute')]))
    content.set('provenance.json', Buffer.from(JSON.stringify({ recipe: agentDesktopRelease, upstream: agentDesktopRevision, commit, target: 'x86_64-pc-windows-msvc', files: Object.fromEntries([...content].map(([name, bytes]) => [name, { sha256: sha(bytes) }])) })))
    const bytes = archive(bundleFiles, name => content.get(name)!)
    const lock = { release: agentDesktopRelease, sourceRevision: agentDesktopRevision, commit, nativeInputs: await nativeRecipeFingerprint(root), assets: { 'win32-x64': { url: `https://github.com/ci010/shadow-native-deps/releases/download/${agentDesktopRelease}/${agentDesktopRelease}-win32-x64.tar.gz`, sha256: sha(bytes) } } }
    await writeFile(join(root, 'scripts/agent-desktop-native-lock.json'), JSON.stringify(lock))
    const old = join(destination, 'shadow-agent-desktop.node'); await writeFile(old, 'prior artifact')
    await assert.rejects(installAgentDesktop(root, 'x64', async () => Buffer.from('bad')), /SHA256/)
    assert.equal(await readFile(old, 'utf8'), 'prior artifact')
    await writeFile(join(destination, 'user-file'), 'preserve')
    await assert.rejects(installAgentDesktop(root, 'x64', async () => bytes), /Unexpected/)
    assert.equal(await readFile(old, 'utf8'), 'prior artifact'); await rm(join(destination, 'user-file'))
    if (process.platform !== 'win32') {
      await rm(old); await symlink(join(root, 'scripts/agent-desktop-native-lock.json'), old)
      await assert.rejects(installAgentDesktop(root, 'x64', async () => bytes), /Unexpected/)
      await rm(old)
    }
    await installAgentDesktop(root, 'x64', async () => bytes)
    await verifyNativeBuild(root, 'x64')
    const output = join(root, 'packaged')
    await copyAgentDesktopAssets(root, output, { platform: 'win32', arch: 'x64' })
    assert.deepEqual(await readFile(join(output, 'integrations/agent-desktop/artifacts/win32-x64/source.tar.gz')), content.get('source.tar.gz'))
    await writeFile(join(destination, 'NOTICE'), 'tampered')
    await assert.rejects(verifyNativeBuild(root, 'x64'), /Stale/)
    await writeFile(join(root, 'integrations/agent-desktop/src/lib.rs'), 'native change')
    await assert.rejects(installAgentDesktop(root, 'x64', async () => bytes), /stale pinned/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('postinstall is download-only while explicit developer repair retains pinned source build', async () => {
  const hook = await readFile(new URL('./postinstall-native.ts', import.meta.url), 'utf8')
  assert.match(hook, /import\('\.\/download-agent-desktop\.ts'\)/)
  assert.doesNotMatch(hook, /spawnSync|powershell\.exe|cargo.*build/)
  const build = await readFile(new URL('../integrations/agent-desktop/scripts/build.mjs', import.meta.url), 'utf8')
  assert.match(build, /'--locked'/)
})
