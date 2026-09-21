import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createPackage } from '@electron/asar'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { createReleaseManifest, parseReleaseManifest, sourceFingerprint, verifyReleaseManifest } from './release-manifest.ts'
import { downloadUrl, verifyWinSW } from './release-downloads.ts'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'

const windows = desktopTarget('win32', 'x64')

async function file(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function fixture(root: string, target: DesktopTarget = windows): Promise<string> {
  for (const [path, text] of [
    ['src/index.ts', 'source'],
    ['desktop/package.json', JSON.stringify({ version: '0.1.0', main: 'dist/main.js', devDependencies: { electron: '44.1.1' } })],
    ['desktop/backend/package.json', '{"type":"module"}'],
    ['desktop/backend/dist/src/index.js', 'backend'],
    ['app/dist/index.html', 'renderer'],
    ['desktop/dist/main.js', 'main'],
    ['desktop/dist/preload.cjs', 'preload'],
    ['desktop/dist/service/connection.js', 'service connection'],
    ['desktop/assets/icon.ico', 'icon'],
    ['desktop/service/ShadowService.exe', 'synthetic-wrapper'],
  ]) await file(root, path, text)
  const sourceHash = await sourceFingerprint(root)
  await createReleaseManifest(root, sourceHash, target)
  const packaged = join(root, 'fixture-package', target.unpackedDirectory)
  for (const [from, to] of [
    ['desktop/release-manifest.v1.json', 'resources/release-manifest.v1.json'],
    ['desktop/backend/package.json', 'resources/backend/package.json'],
    ['desktop/backend/dist/src/index.js', 'resources/backend/dist/src/index.js'],
    ['app/dist/index.html', 'resources/app-dist/index.html'],
    ['desktop/service/ShadowService.exe', 'resources/service/ShadowService.exe'],
    ['desktop/package.json', 'archive/package.json'],
    ['desktop/dist/main.js', 'archive/dist/main.js'],
    ['desktop/dist/preload.cjs', 'archive/dist/preload.cjs'],
    ['desktop/dist/service/connection.js', 'archive/dist/service/connection.js'],
    ['desktop/assets/icon.ico', 'archive/assets/icon.ico'],
  ]) {
    if (to.startsWith('resources/service/') && target.platform !== 'win32') continue
    await file(packaged, to.replace(/^resources/, target.resourcesRelativePath), await readFile(join(root, from), 'utf8'))
  }
  await createPackage(join(packaged, 'archive'), join(packaged, target.resourcesRelativePath, 'app.asar'))
  return packaged
}

test('release verification binds dirty source, renderer, service host and actual ASAR to one build', async () => {
  await withTempWorkspace(async root => {
    const packaged = await fixture(root)
    await verifyReleaseManifest(packaged, root, windows)
    await file(root, 'src/index.ts', 'changed source without a commit')
    await assert.rejects(verifyReleaseManifest(packaged, root, windows), /current source/)
  })
})

test('release verification rejects tampered or extra packaged resources', async () => {
  await withTempWorkspace(async root => {
    const packaged = await fixture(root)
    await file(packaged, 'resources/app-dist/index.html', 'stale renderer')
    await assert.rejects(verifyReleaseManifest(packaged, root, windows), /differs from validated build/)
    await file(packaged, 'resources/app-dist/index.html', 'renderer')
    await file(packaged, 'resources/backend/extra.js', 'unvalidated')
    await assert.rejects(verifyReleaseManifest(packaged, root, windows), /inventory/)
  })
})

test('release snapshot rejects source edits during build and unsafe manifest paths', async () => {
  await withTempWorkspace(async root => {
    await fixture(root)
    await assert.rejects(createReleaseManifest(root, 'stale', windows), /Source changed/)
    const manifest = JSON.parse(await readFile(join(root, 'desktop/release-manifest.v1.json'), 'utf8'))
    manifest.files['resources/backend/../../escape'] = '0'.repeat(64)
    assert.throws(() => parseReleaseManifest(manifest), /Invalid release manifest entry/)
  })
})

test('release verification rejects stale code inside the real Electron ASAR', async () => {
  await withTempWorkspace(async root => {
    const packaged = await fixture(root)
    await file(packaged, 'archive/dist/preload.cjs', 'stale preload')
    await createPackage(join(packaged, 'archive'), join(packaged, 'resources/app.asar'))
    await assert.rejects(verifyReleaseManifest(packaged, root, windows), /asar\/dist\/preload.cjs/)
  })
})

test('release verification rejects a mismatched Electron version and missing required entries', async () => {
  await withTempWorkspace(async root => {
    const packaged = await fixture(root)
    const manifestPath = join(packaged, 'resources/release-manifest.v1.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.electronVersion = '0.0.0'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyReleaseManifest(packaged, root, windows), /version does not match/)
    delete manifest.files['asar/dist/preload.cjs']
    assert.throws(() => parseReleaseManifest(manifest), /missing asar\/dist\/preload.cjs/)
  })
})

test('legacy v1 manifests are Windows x64 only', async () => {
  await withTempWorkspace(async root => {
    const packaged = await fixture(root)
    const path = join(packaged, 'resources', 'release-manifest.v1.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.version = 1
    delete manifest.platform
    delete manifest.arch
    await writeFile(path, JSON.stringify(manifest))
    assert.equal(parseReleaseManifest(manifest).platform, 'win32')
    assert.equal(parseReleaseManifest(manifest).arch, 'x64')
    assert.deepEqual(parseReleaseManifest(parseReleaseManifest(manifest)), parseReleaseManifest(manifest))
    await verifyReleaseManifest(packaged, root, windows)
    await assert.rejects(verifyReleaseManifest(packaged, root, desktopTarget('linux', 'x64')), /target win32\/x64 does not match/)
    delete manifest.files['resources/service/ShadowService.exe']
    assert.throws(() => parseReleaseManifest(manifest), /missing resources\/service/)
  })
})

for (const target of [desktopTarget('darwin', 'arm64'), desktopTarget('darwin', 'x64'), desktopTarget('linux', 'x64')]) {
  test(`${target.platform}/${target.arch} manifest verifies real resource layout and ASAR without Windows services`, async () => {
    await withTempWorkspace(async root => {
      const packaged = await fixture(root, target)
      const resources = join(packaged, target.resourcesRelativePath)
      const path = join(resources, 'release-manifest.v1.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(manifest.version, 2)
      assert.equal(manifest.platform, target.platform)
      assert.equal(manifest.arch, target.arch)
      assert.ok(!Object.keys(manifest.files).some(name => name.startsWith('resources/service/')))
      await verifyReleaseManifest(packaged, root, target)
      await mkdir(join(resources, 'service'))
      await assert.rejects(verifyReleaseManifest(packaged, root, target), /must not contain service resources/)
      manifest.files['resources/service/ShadowService.exe'] = '0'.repeat(64)
      assert.throws(() => parseReleaseManifest(manifest), /must not contain service resources/)
    })
  })

  test(`${target.platform}/${target.arch} rejects tampered ASAR, extra resources and stale source`, async () => {
    await withTempWorkspace(async root => {
      const packaged = await fixture(root, target)
      await file(packaged, 'archive/dist/preload.cjs', 'tampered')
      await createPackage(join(packaged, 'archive'), join(packaged, target.resourcesRelativePath, 'app.asar'))
      await assert.rejects(verifyReleaseManifest(packaged, root, target), /asar\/dist\/preload.cjs/)
      await file(packaged, join(target.resourcesRelativePath, 'backend', 'extra.js'), 'extra')
      await assert.rejects(verifyReleaseManifest(packaged, root, target), /inventory/)
      await file(root, 'src/index.ts', 'stale')
      await assert.rejects(verifyReleaseManifest(packaged, root, target), /current source/)
    })
  })
}

test('v2 manifests reject unsupported targets, missing identity and wrong architecture', async () => {
  await withTempWorkspace(async root => {
    const target = desktopTarget('darwin', 'arm64')
    const packaged = await fixture(root, target)
    const manifest = JSON.parse(await readFile(join(packaged, target.resourcesRelativePath, 'release-manifest.v1.json'), 'utf8'))
    await assert.rejects(verifyReleaseManifest(packaged, root, desktopTarget('darwin', 'x64')), /target darwin\/arm64 does not match/)
    assert.throws(() => parseReleaseManifest({ ...manifest, arch: 'ia32' }), /Unsupported desktop release host/)
    assert.throws(() => parseReleaseManifest({ ...manifest, platform: null }), /Invalid release manifest target/)
    delete manifest.platform
    assert.throws(() => parseReleaseManifest(manifest), /Invalid release manifest/)
  })
})

test('release downloads reject insecure sources and unverified service binaries', () => {
  assert.equal(downloadUrl('https://example.test/pinned.exe'), 'https://example.test/pinned.exe')
  for (const value of ['http://example.test/tool.exe', 'https://user:password@example.test/tool.exe', 'file:///tool.exe']) {
    assert.throws(() => downloadUrl(value))
  }
  assert.throws(() => verifyWinSW(Buffer.from('not WinSW')), /SHA-256 mismatch/)
})
