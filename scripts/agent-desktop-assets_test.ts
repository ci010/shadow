import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { copyAgentDesktopAssets } from './agent-desktop-assets.ts'
import { compileBackend } from './backend-bundle.ts'

test('native asset staging is required on Windows by default and allowlisted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-native-assets-'))
  try {
    const output = join(root, 'dist')
    const opts = { platform: 'win32', arch: 'x64' }
    await assert.rejects(copyAgentDesktopAssets(root, output, opts), /node scripts\/build\.mjs x86_64-pc-windows-msvc/)
    const source = join(root, 'integrations/agent-desktop')
    await mkdir(join(source, 'artifacts/win32-x64'), { recursive: true })
    await writeFile(join(source, 'artifacts/win32-x64/shadow-agent-desktop.node'), 'synthetic non-executable artifact; never load')
    await writeFile(join(source, 'LICENSE'), 'synthetic license')
    await writeFile(join(source, 'NOTICE'), 'synthetic notice')
    await assert.rejects(copyAgentDesktopAssets(root, output, opts), /missing or invalid/)
    await writeFile(join(source, 'artifacts/win32-x64/shadow-input-guard.exe'), 'synthetic guard; never execute')
    await writeFile(join(source, 'private-state.json'), 'must not copy')
    await writeFile(join(source, 'artifacts/win32-x64/secret.json'), 'must not copy')
    assert.equal(await copyAgentDesktopAssets(root, output, opts), true)
    assert.deepEqual((await readdir(join(output, 'integrations/agent-desktop'))).sort(), ['LICENSE', 'NOTICE', 'artifacts'])
    assert.deepEqual((await readdir(join(output, 'integrations/agent-desktop/artifacts/win32-x64'))).sort(), ['shadow-agent-desktop.node', 'shadow-input-guard.exe'])
    await writeFile(join(source, 'artifacts/win32-x64/shadow-input-guard.exe'), '')
    await assert.rejects(copyAgentDesktopAssets(root, output, opts), /missing or invalid/)
    await assert.rejects(copyAgentDesktopAssets(root, output, { platform: 'win32', arch: 'ia32' }), /supports only/)
    await assert.rejects(copyAgentDesktopAssets(root, output, { platform: 'win32', arch: 'arm64' }), /aarch64-pc-windows-msvc/)
    assert.equal(await copyAgentDesktopAssets(root, output, { platform: 'linux' }), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('relocated isolated worker bundles zod and starts without repository node_modules or native UI calls', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-native-worker-bundle-'))
  try {
    const repository = fileURLToPath(new URL('..', import.meta.url))
    await compileBackend(repository, root, ['execution/computer/agent-desktop-worker'])
    const worker = join(root, 'src/execution/computer/agent-desktop-worker.js')
    const code = await readFile(worker, 'utf8')
    assert.doesNotMatch(code, /from ["']zod["']/)
    assert.doesNotMatch(code, /__shadow_module_(?:url|dir)__/)
    const id = randomUUID()
    assert.throws(() => execFileSync(process.execPath, [worker], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ id, method: '__invalid_wire_probe__' }) + '\n',
      env: { ...process.env, NODE_OPTIONS: '' },
    }), (error: unknown) => {
      const failure = error as { status?: number; stdout?: string }
      return failure.status === 2 && String(failure.stdout) === ''
    })
    const artifact = join(root, `integrations/agent-desktop/artifacts/win32-${process.arch}/shadow-agent-desktop.node`)
    const { existsSync } = await import('node:fs')
    if (process.platform === 'win32') {
      assert.ok(existsSync(artifact), 'default Windows build must copy the native addon')
      const identity = execFileSync(process.execPath,
        [join(repository, 'integrations/agent-desktop/scripts/identity.mjs'), artifact],
        { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '' } })
      assert.equal(JSON.parse(identity).noUiAbiProbe, 'passed')
      assert.equal(JSON.parse(identity).ownerShutdown, 'passed')
      const guardIdentity = execFileSync(join(root, `integrations/agent-desktop/artifacts/win32-${process.arch}/shadow-input-guard.exe`), ['--identity'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true })
      assert.equal(JSON.parse(guardIdentity).backend, 'shadow-input-guard')
      const electron: string = createRequire(new URL('../desktop/package.json', import.meta.url))('electron')
      const electronIdentity = execFileSync(electron,
        [join(repository, 'integrations/agent-desktop/scripts/identity.mjs'), artifact],
        { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' } })
      assert.equal(JSON.parse(electronIdentity).noUiAbiProbe, 'passed')
      assert.equal(JSON.parse(electronIdentity).ownerShutdown, 'passed')
    }
    // Remove only the disposable copied addon, never the source/live artifact.
    // Release has no target reads even if a binary unexpectedly remains.
    await rm(artifact, { force: true })
    const missingId = randomUUID()
    const missing = execFileSync(process.execPath, [worker], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ id: missingId, method: 'release', targetId: randomUUID() }) + '\n',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    assert.deepEqual(JSON.parse(missing), { id: missingId, error: { code: 'host_failure' } })
    await assert.rejects(readFile(join(root, 'integrations/agent-desktop/src/lib.rs')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
