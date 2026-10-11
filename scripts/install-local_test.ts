import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { installLocalDesktop, localInstallDirectory } from './install-local.ts'

test('local installation requires Windows x64 and an absolute current-user directory', () => {
  assert.equal(localInstallDirectory('win32', 'x64', process.cwd()), join(process.cwd(), 'Programs', 'Shadow'))
  assert.throws(() => localInstallDirectory('darwin', 'arm64', process.cwd()), /Windows x64 only/)
  assert.throws(() => localInstallDirectory('win32', 'arm64', process.cwd()), /Windows x64 only/)
  assert.throws(() => localInstallDirectory('win32', 'x64', ''), /LOCALAPPDATA/)
  assert.throws(() => localInstallDirectory('win32', 'x64', 'relative'), /LOCALAPPDATA/)
})

async function fixture(t: test.TestContext) {
  await mkdir('.test-data', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.test-data', 'local-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'installed')
  const unpacked = join(root, 'desktop', 'release', 'win-unpacked')
  const installer = join(root, 'desktop', 'release', 'Shadow-0.1.0-win-x64.exe')
  const manifest = Buffer.from('synthetic current build identity')
  const calls: string[] = []
  await mkdir(join(unpacked, 'resources'), { recursive: true })
  await writeFile(join(root, 'desktop', 'package.json'), '{"version":"0.1.0"}')
  await writeFile(installer, 'synthetic installer')
  await writeFile(join(unpacked, 'resources', 'release-manifest.v1.json'), manifest)
  const runner = {
    async assertStopped(path: string) {
      assert.equal(path, directory)
      calls.push('stopped')
    },
    async install(path: string) {
      assert.equal(path, installer)
      calls.push('install')
      await mkdir(join(directory, 'resources'), { recursive: true })
      await writeFile(join(directory, 'Shadow.exe'), 'synthetic executable')
      await writeFile(join(directory, 'resources', 'release-manifest.v1.json'), manifest)
    },
    async verify(path: string, repository: string) {
      assert.equal(repository, root)
      calls.push(path === directory ? 'verify-installed' : 'verify-package')
    },
  }
  return { root, directory, installer, runner, calls }
}

test('local installation only installs existing output and verifies exact installed identity and files', async t => {
  const { root, directory, runner, calls } = await fixture(t)
  await installLocalDesktop(root, directory, runner)
  assert.deepEqual(calls, ['stopped', 'verify-package', 'stopped', 'install', 'verify-installed'])
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.scripts['desktop:install'], 'node --import tsx scripts/install-local.ts')
  assert.equal(packageJson.scripts['desktop:build'], 'node --import tsx scripts/desktop.ts build')
  assert.equal(packageJson.scripts['desktop:prepare-aria2'], 'node --import tsx scripts/local-aria2.ts')
  const source = await readFile(new URL('./install-local.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /runPnpm|prepareLocalAria2/)
  const desktop = await readFile(new URL('./desktop.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(desktop, /runPnpm\(\['(?:typecheck|test[^']*)'\]\)/)
})

test('running app, missing installer and failed package verification prevent installation', async t => {
  for (const failure of ['running', 'missing', 'verify', 'running-after-verification']) {
    const { root, directory, installer, runner, calls } = await fixture(t)
    if (failure === 'running' || failure === 'running-after-verification') {
      const check = runner.assertStopped
      runner.assertStopped = async path => {
        await check(path)
        if (failure === 'running' || calls.includes('verify-package')) throw new Error('running app')
      }
    } else if (failure === 'missing') {
      await rm(installer)
    } else {
      runner.verify = async () => { throw new Error('package verification failed') }
    }
    await assert.rejects(installLocalDesktop(root, directory, runner))
    assert.ok(!calls.includes('install'), failure)
  }
})

test('installer failures and installed identity or file verification failures are reported', async t => {
  for (const failure of ['installer', 'identity', 'files', 'missing']) {
    const { root, directory, runner, calls } = await fixture(t)
    const install = runner.install
    runner.install = async path => {
      if (failure === 'installer') throw new Error('installer failed')
      if (failure === 'missing') return
      await install(path)
      if (failure === 'identity') {
        await writeFile(join(directory, 'resources', 'release-manifest.v1.json'), 'older build')
      }
    }
    if (failure === 'files') {
      const verify = runner.verify
      runner.verify = async (path, repository) => {
        await verify(path, repository)
        if (path === directory) throw new Error('installed file checksum mismatch')
      }
    }
    await assert.rejects(installLocalDesktop(root, directory, runner))
    assert.ok(calls.includes('verify-package'))
  }
})
