import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { recordNativeBuild, verifyNativeBuild } from './agent-desktop-integrity.ts'
import { acquireNativeInstallLock, prepareNativeAfterInstall } from './postinstall-native.ts'

function fixture() {
  const calls: string[] = []
  const info: string[] = []
  const warnings: string[] = []
  let valid = false
  const dependencies = {
    verify: async (_root: string, arch: string) => {
      calls.push(`verify:${arch}`)
      if (!valid) throw new Error('missing or stale fixture')
    },
    repair: (_root: string, arch: string) => { calls.push(`repair:${arch}`); valid = true },
    acquireLock: async (_root: string, arch: string) => {
      calls.push(`lock:${arch}`)
      return async () => { calls.push('release') }
    },
    info: (message: string) => { info.push(message) },
    warn: (message: string) => { warnings.push(message) },
  }
  return { calls, info, warnings, dependencies, setValid: () => { valid = true } }
}

test('non-Windows, explicit opt-out and unsupported architectures do not build or access assets', async () => {
  for (const [platform, arch, env] of [
    ['linux', 'x64', {}], ['darwin', 'arm64', {}],
    ['win32', 'x64', { SHADOW_SKIP_NATIVE_BUILD: '1' }], ['win32', 'ia32', {}],
  ] as const) {
    const f = fixture()
    await prepareNativeAfterInstall('unused', env, platform, arch, f.dependencies)
    assert.deepEqual(f.calls, [])
    assert.equal(f.warnings.length, arch === 'ia32' ? 1 : 0)
  }
})

test('verified cache needs no toolchain, lock, network or build, including CI/production installs', async () => {
  const f = fixture()
  f.setValid()
  await prepareNativeAfterInstall('unused', { CI: 'true', npm_config_production: 'true' }, 'win32', 'x64', f.dependencies)
  assert.deepEqual(f.calls, ['verify:x64'])
  assert.match(f.info.join('\n'), /Verified cached/)
  assert.deepEqual(f.warnings, [])
})

test('missing/stale assets repair the host architecture and verify the result before reporting success', async () => {
  for (const arch of ['x64', 'arm64']) {
    const f = fixture()
    await prepareNativeAfterInstall('unused', {}, 'win32', arch, f.dependencies)
    assert.deepEqual(f.calls, [`verify:${arch}`, `lock:${arch}`, `verify:${arch}`, `repair:${arch}`, `verify:${arch}`, 'release'])
    assert.match(f.info.at(-1)!, /native assets verified/)
    assert.deepEqual(f.warnings, [])
  }
})

test('rechecks the cache after acquiring a lock instead of rebuilding another installers result', async () => {
  const f = fixture()
  f.dependencies.acquireLock = async () => { f.setValid(); return async () => { f.calls.push('release') } }
  await prepareNativeAfterInstall('unused', {}, 'win32', 'x64', f.dependencies)
  assert.deepEqual(f.calls, ['verify:x64', 'verify:x64', 'verify:x64', 'release'])
  assert.deepEqual(f.warnings, [])
})

test('missing toolchains, offline fetches and build failures warn without rejecting install or leaking locks', async () => {
  for (const reason of ['rustup missing', 'MSVC missing', 'offline Cargo dependency', 'spawn failed', 'binary in use']) {
    const f = fixture()
    f.dependencies.repair = () => { throw new Error(reason) }
    await prepareNativeAfterInstall('unused', {}, 'win32', 'arm64', f.dependencies)
    assert.equal(f.calls.at(-1), 'release')
    assert.equal(f.warnings.length, 1)
    assert.ok(f.warnings[0]!.includes(reason))
    assert.match(f.warnings[0]!, /pnpm desktop:repair-native -Arch arm64/)
    assert.doesNotMatch(f.info.join('\n'), /native assets verified/)
  }
})

test('does not trust an unsuccessful repair or malformed build receipt', async () => {
  const f = fixture()
  f.dependencies.repair = () => {}
  await prepareNativeAfterInstall('unused', {}, 'win32', 'x64', f.dependencies)
  assert.match(f.warnings.join('\n'), /did not complete/)
  assert.equal(f.calls.at(-1), 'release')
  assert.doesNotMatch(f.info.join('\n'), /native assets verified/)
})

test('busy/stale locks and read-only checkouts are reported without concurrent repair', async () => {
  for (const code of ['EEXIST', 'EACCES']) {
    const f = fixture()
    f.dependencies.acquireLock = async () => { throw Object.assign(new Error('lock failure'), { code }) }
    await prepareNativeAfterInstall('unused', {}, 'win32', 'x64', f.dependencies)
    assert.deepEqual(f.calls, ['verify:x64'])
    assert.match(f.warnings.join('\n'), code === 'EEXIST' ? /Another installer/ : /lock failure/)
  }
})

test('lock cleanup errors are visible without failing dependency installation', async () => {
  const f = fixture()
  f.dependencies.acquireLock = async () => async () => { throw new Error('cleanup denied') }
  await prepareNativeAfterInstall('unused', {}, 'win32', 'x64', f.dependencies)
  assert.match(f.warnings.join('\n'), /Could not release native build lock: cleanup denied/)
})

async function seedNative(root: string) {
  const source = join(root, 'integrations', 'agent-desktop')
  for (const directory of ['src', 'scripts', 'patches', 'artifacts/win32-x64']) {
    await mkdir(join(source, directory), { recursive: true })
  }
  for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src/lib.rs', 'patches/owned.rs', 'scripts/build.mjs']) {
    await writeFile(join(source, file), 'synthetic fingerprint input; never executed')
  }
  for (const file of ['shadow-agent-desktop.node', 'shadow-input-guard.exe']) {
    await writeFile(join(source, 'artifacts', 'win32-x64', file), 'synthetic artifact; never executed')
  }
  for (const file of [
    'src/execution/computer/agent-desktop-worker.js', 'src/execution/computer/agent-desktop-errors.js',
    'src/execution/computer/stdio-transport.ts', 'src/execution/computer/windows-input.cs',
    'scripts/agent-desktop-input-guard.ts', 'scripts/agent-desktop-integrity.ts',
  ]) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), 'synthetic fingerprint input; never executed')
  }
}

test('real content hashes invalidate changed sources, binaries and corrupt manifests, not mtimes', async () => {
  const root = await mkdtemp(join(process.cwd(), '.shadow-test-postinstall-'))
  try {
    await seedNative(root)
    await recordNativeBuild(root, 'x64')
    const f = fixture()
    f.dependencies.verify = verifyNativeBuild
    let repairs = 0
    const dependencies = { ...f.dependencies, repair: async () => { repairs++; await recordNativeBuild(root, 'x64') } }
    await prepareNativeAfterInstall(root, {}, 'win32', 'x64', dependencies)
    assert.equal(repairs, 0)
    for (const file of [
      'integrations/agent-desktop/src/lib.rs',
      'integrations/agent-desktop/artifacts/win32-x64/shadow-input-guard.exe',
      'integrations/agent-desktop/artifacts/win32-x64/build-manifest.json',
    ]) {
      await writeFile(join(root, file), 'changed')
      await prepareNativeAfterInstall(root, {}, 'win32', 'x64', dependencies)
    }
    assert.equal(repairs, 3)
    assert.deepEqual(f.warnings, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real filesystem lock excludes concurrent installs and is removed after a failed build', async () => {
  const root = await mkdtemp(join(process.cwd(), '.shadow-test-postinstall-'))
  try {
    const f = fixture()
    let started!: () => void
    const building = new Promise<void>(resolve => { started = resolve })
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const dependencies = {
      ...f.dependencies,
      acquireLock: acquireNativeInstallLock,
      repair: async () => { started(); await finished },
    }
    const first = prepareNativeAfterInstall(root, {}, 'win32', 'x64', dependencies)
    await building
    try {
      await prepareNativeAfterInstall(root, {}, 'win32', 'x64', dependencies)
      assert.match(f.warnings.join('\n'), /Another installer/)
    } finally { finish(); await first }
    const lock = join(root, 'integrations', 'agent-desktop', 'artifacts', '.postinstall-win32-x64.lock')
    await assert.rejects(stat(lock), { code: 'ENOENT' })
    assert.match(f.warnings.join('\n'), /Native preparation did not complete/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('hook runs with plain Node and no node_modules, resolving the repository from its own location', async () => {
  const root = await mkdtemp(join(process.cwd(), '.shadow-test-postinstall-'))
  try {
    await seedNative(root)
    for (const file of ['postinstall-native.ts', 'agent-desktop-integrity.ts']) {
      await cp(new URL(file, import.meta.url), join(root, 'scripts', file))
    }
    await recordNativeBuild(root, 'x64')
    const hook = pathToFileURL(join(root, 'scripts', 'postinstall-native.ts')).href
    const output = execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `const {prepareNativeAfterInstall} = await import(${JSON.stringify(hook)}); `
        + `await prepareNativeAfterInstall(${JSON.stringify(root)}, {}, 'win32', 'x64');`,
    ], { cwd: join(root, 'scripts'), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
    assert.match(output, /Verified cached/)
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.scripts.postinstall, 'node scripts/postinstall-native.ts')
    assert.equal(pkg.scripts['pnpm:devPreinstall'], pkg.scripts.postinstall)
  } finally { await rm(root, { recursive: true, force: true }) }
})
