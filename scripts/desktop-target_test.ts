import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { desktopTarget } from './desktop-target.ts'
import { prepareReleaseDownloads } from './release-downloads.ts'

test('native release targets select explicit archives, executable and resource paths', () => {
  assert.deepEqual(desktopTarget('win32', 'x64'), {
    platform: 'win32', arch: 'x64', builderFlag: '--win', format: 'nsis',
    unpackedDirectory: 'win-unpacked', executableRelativePath: 'Shadow.exe', resourcesRelativePath: 'resources',
  })
  for (const arch of ['arm64', 'x64']) {
    const target = desktopTarget('darwin', arch)
    assert.equal(target.format, 'zip')
    assert.equal(target.unpackedDirectory, join(arch === 'arm64' ? 'mac-arm64' : 'mac', 'Shadow.app'))
    assert.equal(target.executableRelativePath, join('Contents', 'MacOS', 'Shadow'))
    assert.equal(target.resourcesRelativePath, join('Contents', 'Resources'))
  }
  assert.equal(desktopTarget('linux', 'x64').format, 'tar.gz')
  assert.equal(desktopTarget('linux', 'x64').executableRelativePath, 'shadow')
  for (const [platform, arch] of [['win32', 'arm64'], ['linux', 'arm64'], ['freebsd', 'x64']]) {
    assert.throws(() => desktopTarget(platform, arch), /Unsupported desktop release host/)
  }
})

test('portable releases validate native Electron distributions without downloading Windows services', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected download on a portable build') })
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64']]) {
    await withTempWorkspace(async root => {
      await mkdir(join(root, 'desktop'))
      await writeFile(join(root, 'desktop', 'package.json'), JSON.stringify({ devDependencies: { electron: '44.1.1' } }))
      const distribution = join(root, 'electron')
      const executable = platform === 'darwin'
        ? join(distribution, 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(distribution, 'electron')
      await mkdir(dirname(executable), { recursive: true })
      await writeFile(executable, 'synthetic executable, never run')
      await writeFile(join(distribution, 'version'), '44.1.1')
      const env = { SHADOW_ELECTRON_DIST: distribution, SHADOW_WINSW_BINARY: join(root, 'must-not-read.exe') }
      assert.equal(await prepareReleaseDownloads(root, env, desktopTarget(platform, arch)), distribution)
      await assert.rejects(stat(join(root, 'desktop', 'service')), { code: 'ENOENT' })
      await writeFile(join(distribution, 'version'), '1.0.0')
      await assert.rejects(prepareReleaseDownloads(root, env, desktopTarget(platform, arch)), /expected 44.1.1/)
    })
  }
})

test('packaging configuration keeps WinSW Windows-only and uses shared portable icons', async () => {
  const desktop = JSON.parse(await readFile(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  assert.equal(desktop.scripts.dist, 'electron-builder --publish never')
  assert.equal(desktop.build.win.target, 'nsis')
  assert.equal(desktop.build.mac.target, 'zip')
  assert.equal(desktop.build.mac.identity, '-')
  assert.equal(desktop.build.mac.entitlements, 'assets/entitlements.mac.plist')
  assert.equal(desktop.build.mac.entitlementsInherit, desktop.build.mac.entitlements)
  const entitlements = await readFile(new URL('../desktop/assets/entitlements.mac.plist', import.meta.url), 'utf8')
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/)
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/)
  assert.equal(desktop.build.mac.notarize, false)
  assert.equal(desktop.build.linux.target, 'tar.gz')
  assert.equal(desktop.build.linux.executableName, 'shadow')
  assert(!desktop.build.extraResources.some((item: { from: string }) => item.from === 'service'))
  assert(desktop.build.extraResources.some((item: { from: string; to: string }) =>
    item.from === 'aria2' && item.to === 'aria2'))
  assert(desktop.build.win.extraResources.some((item: { from: string }) => item.from === 'service'))
  assert.equal(desktop.build.mac.icon, 'assets/icon.png')
  assert.equal(desktop.build.linux.icon, 'assets/icon.png')
  assert.deepEqual(await readFile(new URL('../desktop/assets/icon.png', import.meta.url)),
    await readFile(new URL('../app/src/assets/shadow-logo.png', import.meta.url)))
})

test('CI builds all requested architectures natively and uploads only packaged artifacts', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/release-check.yml', import.meta.url), 'utf8'))
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert('pull_request' in workflow.on && 'workflow_dispatch' in workflow.on)
  const portable = workflow.jobs['portable-release']
  assert.equal(portable.strategy['fail-fast'], false)
  assert.deepEqual(portable.strategy.matrix.include.map((job: { runner: string; platform: string; arch: string }) =>
    [job.runner, job.platform, job.arch]), [
    ['macos-15', 'darwin', 'arm64'], ['macos-15-intel', 'darwin', 'x64'], ['ubuntu-22.04', 'linux', 'x64'],
  ])
  assert(portable.steps.some((step: { run?: string }) => step.run === 'xvfb-run --auto-servernum pnpm test:release'))
  assert(portable.steps.some((step: { run?: string }) => step.run === 'xvfb-run --auto-servernum pnpm desktop:package'))
  for (const job of [workflow.jobs['windows-release'], portable]) {
    const upload = job.steps.find((step: { uses?: string }) => step.uses === 'actions/upload-artifact@v4')
    assert.equal(upload.with['if-no-files-found'], 'error')
    assert.equal(upload.if, undefined, 'Artifacts must not upload after a failed verification')
  }
})
