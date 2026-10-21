import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of payload) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(payload.length + 8)
    result.writeUInt32BE(data.length); payload.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))])
}
import { backendEntries, bundleBackend, compileBackend, stageBackend } from './backend-bundle.ts'
import { directoryFingerprint } from './release-manifest.ts'

// Relocate outside the repository: dependencies cannot resolve from development.
test('relocated Vite backend preserves CLI, assets, WASM and isolated script entry', { timeout: 120_000 }, async () => {
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'shadow-bundle-relocated-'))
  try {
    const target = join(root, 'resources/backend')
    const prepared = join(root, 'prepared')
    await compileBackend(repository, join(prepared, 'dist'), [...backendEntries, 'events/input-processor-compiler'])
    const fingerprint = await directoryFingerprint(join(prepared, 'dist'))
    await stageBackend(prepared, target)
    assert.equal(await directoryFingerprint(join(target, 'dist')), fingerprint)
    await rm(prepared, { recursive: true, force: true })
    assert.deepEqual((await readdir(join(target, 'dist/node_modules'))).sort(),
      ['@esbuild', '@jsquash', 'esbuild', 'typescript', 'wasm-feature-detect'])
    assert.match(await readFile(join(target, 'dist/THIRD-PARTY-NOTICES.txt'), 'utf8'), /hono@/)
    assert.ok((await readdir(join(target, 'dist/_chunks'))).length > 1, 'entries should share chunks')
    for (const entry of backendEntries) {
      const file = join(target, 'dist/src', entry + '.js')
      const code = await readFile(file, 'utf8')
      assert.doesNotMatch(code, /__shadow_module_(?:url|dir)__/)
      execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' })
    }
    // Unknown wire operations are rejected before addon load. Do not use an
    // actual foreground/observe request to probe packaging without a user grant.
    const nativeId = '11111111-1111-4111-8111-111111111111'
    assert.throws(() => execFileSync(process.execPath,
      [join(target, 'dist/src/execution/computer/agent-desktop-worker.js')], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        input: JSON.stringify({ id: nativeId, method: '__invalid_wire_probe__' }) + '\n',
        env: { ...process.env, NODE_OPTIONS: '' },
      }), (error: unknown) => {
        const failure = error as { status?: number; stdout?: string }
        return failure.status === 2 && String(failure.stdout) === ''
      })
    const chunks = await readdir(join(target, 'dist/_chunks'))
    for (const chunk of chunks) {
      assert.doesNotMatch(await readFile(join(target, 'dist/_chunks', chunk), 'utf8'), /__shadow_module_(?:url|dir)__/)
    }
    for (const asset of ['agent/context/AGENTS.tools.md', 'sessions/handoff/HANDOFF.md',
      'execution/processes/windows-guardian.ps1', 'execution/computer/windows-input.cs',
      'skills/builtin/computer-use/SKILL.md', 'microapps/sdk.js']) assert.ok(await readFile(join(target, 'dist/src', asset)))
    await assert.rejects(readFile(join(target, 'dist/src/execution/computer/windows-host.cs')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(target, 'dist/src/execution/computer/testing/window.cs')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(target, 'dist/src/execution/computer/testing/input.cs')), { code: 'ENOENT' })
    const entry = join(target, 'dist/src/index.js')
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `const backend = await import(${JSON.stringify(pathToFileURL(entry).href)}); if(typeof backend.runRootProcessEntry !== 'function') throw Error('missing CLI');`],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    const data = join(root, 'synthetic-data')
    await mkdir(join(data, 'config'), { recursive: true })
    await mkdir(join(data, 'workspace.projects/projects/default/workspace'), { recursive: true })
    await writeFile(join(data, 'config/bot.config.json'), JSON.stringify({ agent: { workspace: data } }))
    await writeFile(join(data, 'workspace.projects/projects.v2.json'), JSON.stringify({ version: 2, projects: [{ id: 'default' }], folders: [] }))
    const plan = execFileSync(process.execPath, [entry, 'data-migration', '--data-dir', data, '--plan'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    assert.match(plan, /"preliminary":true/)
    const electron: string = createRequire(new URL('../desktop/package.json', import.meta.url))('electron')
    const processor = join(root, 'processor')
    await mkdir(processor)
    await writeFile(join(processor, 'valid.ts'),
      'export function run() { const ids: Array<string> = ["fixture"]; return { action: "ignore" as const, state: { ids } } }')
    await writeFile(join(processor, 'invalid.ts'), 'export function run() { return { action: "invalid" as const } }')
    const compilerUrl = pathToFileURL(join(target, 'dist/src/events/input-processor-compiler.js')).href
    const checkCompiler = `
      import assert from 'node:assert/strict';
      const { compileProcessor } = await import(${JSON.stringify(compilerUrl)});
      const valid = await compileProcessor(${JSON.stringify(processor)}, 'valid.ts');
      assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
      assert.match(valid.code, /function run/);
      const invalid = await compileProcessor(${JSON.stringify(processor)}, 'invalid.ts');
      assert.equal(invalid.ok, false);
      assert.ok(invalid.diagnostics.length);
      assert.equal(invalid.code, '');
    `
    for (const executable of [process.execPath, electron]) {
      execFileSync(executable, ['--input-type=module', '-e', checkCompiler], {
        cwd: root, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1', ESBUILD_BINARY_PATH: '' },
      })
    }
    const electronPlan = execFileSync(electron, [entry, 'data-migration', '--data-dir', data, '--plan'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
    })
    assert.match(electronPlan, /"preliminary":true/)
    execFileSync(process.execPath, [join(target, 'dist/src/a2a/mcp-cli.js'), '--help'], { cwd: root, stdio: 'pipe' })
    execFileSync(process.execPath, ['--import', pathToFileURL(join(target, 'dist/src/execution/network/proxy-preload.js')).href,
      '-e', ''], { cwd: root, stdio: 'pipe', env: { ...process.env, SHADOW_APP_NETWORK_PROXY: '', NODE_OPTIONS: '' } })
    await assert.rejects(readFile(join(data, 'app.json')), { code: 'ENOENT' })
    const worker = new Worker(pathToFileURL(join(target, 'dist/src/utils/image-codec-worker.js')), {
      execArgv: [], workerData: { bytes: Uint8Array.from(png()), width: 1, height: 1 },
    })
    try {
      const [image] = await once(worker, 'message', { signal: AbortSignal.timeout(10_000) })
      assert.ok(image instanceof Uint8Array && image.length > 0, 'WASM conversion must not silently fall back')
    } finally { await worker.terminate() }
    const child = fork(join(target, 'dist/src/script-runtime/worker.js'), [], {
      cwd: root, execArgv: ['--experimental-vm-modules', '--experimental-import-meta-resolve', '--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    try {
      const packet = once(child, 'message', { signal: AbortSignal.timeout(10_000) })
      child.send({ type: 'start', code: 'export function run() { return 42 }', args: '{}',
        policy: { kind: 'restricted', mode: 'test', imports: [] }, entry: 'run', filename: join(root, 'guest.ts'),
        toolNames: [], maxCalls: 0, envKeys: [] })
      const [message] = await packet
      assert.deepEqual(message, { type: 'result', json: '42' })
    } finally {
      if (child.connected) child.disconnect()
      if (child.exitCode === null) await once(child, 'exit')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('backend bundling refuses to erase the source tree or checked output', async () => {
  const repository = fileURLToPath(new URL('..', import.meta.url))
  await assert.rejects(bundleBackend(repository, repository), /must be separate/)
  await assert.rejects(bundleBackend(repository, join(repository, 'dist')), /must be separate/)
})
