import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { assertPrivateReleaseConfig, isReleaseSource, parseMacReleaseConfig, shellQuote, snapshotReleaseSource } from './release-mac.ts'
import { sourceFingerprint } from './release-manifest.ts'

const exec = promisify(execFile)
const config = {
  host: 'dev@192.0.2.10',
  remoteRoot: '/Users/dev/.shadow-releases',
  remoteNode: '/opt/homebrew/bin/node',
  remotePnpm: '/opt/homebrew/bin/pnpm',
  remotePath: '/opt/homebrew/bin:/usr/bin:/bin',
}

test('Mac release configuration accepts explicit SSH locations, not executable options or unsafe paths', () => {
  assert.deepEqual(parseMacReleaseConfig(config), config)
  for (const invalid of [
    null, { ...config, host: '-oProxyCommand=unexpected' }, { ...config, host: 'dev@host;exit' },
    { ...config, remoteRoot: '/Users/dev' }, { ...config, remoteRoot: '/tmp/release' },
    { ...config, remoteRoot: '/Users/dev/../other' }, { ...config, remoteNode: 'node' },
    { ...config, remotePnpm: '/opt/homebrew/bin/pnpm\nexit' }, { ...config, remotePath: '/usr/bin:.' },
    { ...config, remotePath: '/usr/bin:' }, { ...config, identityFile: 'relative-key' },
    { ...config, password: 'do-not-store-secrets' },
  ]) assert.throws(() => parseMacReleaseConfig(invalid))
})

test('SSH arguments quote spaces, apostrophes and shell expansions literally', () => {
  assert.equal(shellQuote("/Users/dev/Mac's releases"), "'/Users/dev/Mac'\\''s releases'")
  assert.equal(shellQuote('$(touch unexpected)'), "'$(touch unexpected)'")
  assert.throws(() => shellQuote('path\ncommand'), /Control/)
})

test('private release configuration must stay untracked and outside all copied source roots', async () => {
  await withTempWorkspace(async root => {
    await exec('git', ['init', '--quiet'], { cwd: root })
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, '.gitignore'), '.shadow-release.json\nscripts/private-release.json\n')
    const local = join(root, '.shadow-release.json')
    await writeFile(local, JSON.stringify(config))
    await assertPrivateReleaseConfig(root, local)
    await assertPrivateReleaseConfig(root, join(root, '..', 'external-release.json'))
    await assert.rejects(assertPrivateReleaseConfig(root, join(root, 'unignored-release.json')), /Git-ignored/)
    await assert.rejects(assertPrivateReleaseConfig(root, join(root, 'scripts', 'private-release.json')), /source directories/)
    await assert.rejects(assertPrivateReleaseConfig(root, join(root, 'scripts', '.env.private')), /source directories/)
    await exec('git', ['add', '--force', '.shadow-release.json'], { cwd: root })
    await assert.rejects(assertPrivateReleaseConfig(root, local), /Git-ignored and untracked/)
  })
})

test('release source inventory excludes local state, credentials and foreign build outputs', () => {
  for (const path of ['src/index.ts', 'desktop/src/main.ts', 'desktop/tests/fixtures/example.ts',
    'integrations/a2a/package.json', 'scripts/release-mac.ts', '.github/actions/setup-build/action.yml',
    'bot.config.example.json', 'pnpm-lock.yaml']) assert.equal(isReleaseSource(path), true, path)
  for (const path of ['bot.config.json', '.shadow-release.json', '.env', 'src/.env.private', 'src/private.key',
    'src/device.credential', '.git/config', 'workspace/history.jsonl', 'desktop/release/Shadow.zip',
    'desktop/backend/package.json', 'app/node_modules/example/index.js', 'app/dist/index.html',
    'desktop/aria2/aria2c', 'desktop/service/ShadowService.exe', '../src/index.ts', 'src/../config.json',
    'src\\index.ts', '.test-artifacts/evidence.json', 'temp_botpy/main.py']) assert.equal(isReleaseSource(path), false, path)
})

test('snapshot includes dirty and untracked source, excludes config, and binds workspace integration code', async () => {
  await withTempWorkspace(async root => {
    await exec('git', ['init', '--quiet'], { cwd: root })
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'integrations', 'a2a'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'node_modules/\n')
    await writeFile(join(root, 'src', 'index.ts'), 'old source')
    await exec('git', ['add', '.'], { cwd: root })
    await writeFile(join(root, 'src', 'index.ts'), 'dirty source')
    await writeFile(join(root, 'src', 'new.ts'), 'new source')
    await writeFile(join(root, 'bot.config.json'), 'private fixture; never copied')
    await writeFile(join(root, 'integrations', 'a2a', 'cli.ts'), 'integration source')
    await mkdir(join(root, 'integrations', 'a2a', 'node_modules'))
    await writeFile(join(root, 'integrations', 'a2a', 'node_modules', 'ignored.js'), 'dependency')
    const destination = join(root, '.tmp', 'snapshot')
    const hash = await snapshotReleaseSource(root, destination)
    assert.equal(await readFile(join(destination, 'src', 'index.ts'), 'utf8'), 'dirty source')
    assert.equal(await readFile(join(destination, 'src', 'new.ts'), 'utf8'), 'new source')
    await assert.rejects(readFile(join(destination, 'bot.config.json')), { code: 'ENOENT' })
    assert.equal(hash, await sourceFingerprint(root))
    await writeFile(join(root, 'integrations', 'a2a', 'cli.ts'), 'changed integration source')
    assert.notEqual(hash, await sourceFingerprint(root))
  })
})
