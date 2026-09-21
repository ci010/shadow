import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ProtectedDeviceKeyStore } from '../cluster/device-credentials.ts'
import { runChildPairingCli } from './child-pairing-cli.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = resolve('.test-child-pairing', randomUUID())
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, 'bootstrap.json')
  const dataDir = join(directory, 'home')
  await writeFile(configPath, JSON.stringify({ version: 1, mode: 'child', dataDir,
    localNodeId: 'desktop-child-1', mainEndpoint: 'http://main.test:43125', allowInsecureLocalTransport: true }))
  const keys = new Map<string, Uint8Array>()
  const keyStore: ProtectedDeviceKeyStore = { providerId: 'test-protected',
    load: async id => keys.get(id) ?? null, save: async (id, value) => { keys.set(id, value) } }
  const input = async function* () { yield JSON.stringify({ offerId: 'offer-1', pin: '123456', displayName: 'Child' }) }
  return { directory, configPath, dataDir, keyStore, keys, input }
}

test('packaged child pair entry uses real production pairing, persists reference only and is restart-safe', async t => {
  const f = await fixture(t)
  let requests = 0
  const output: string[] = []
  const run = () => runChildPairingCli(['--config', f.configPath], f.input(), text => output.push(text), {
    keyStore: f.keyStore,
    fetchPairing: async (url, init) => {
      requests++
      assert.equal(String(url), 'http://main.test:43125/pair/v1/present')
      const request = JSON.parse(init?.body as string)
      assert.equal(request.pin, '123456')
      assert.ok(request.devicePublicKey)
      return Response.json({ version: 1, state: 'pending', pendingId: request.pendingId, requestedAt: new Date().toISOString() }, { status: 202 })
    },
  })
  await run()
  await run()
  assert.equal(requests, 1)
  assert.equal(f.keys.size, 1)
  assert.deepEqual(output, ['{"version":1,"state":"pending"}\n', '{"version":1,"state":"pending"}\n'])
  const reference = await readFile(join(f.dataDir, 'credentials', 'device-credential.v1.json'), 'utf8')
  assert.ok(!reference.includes('123456') && !reference.includes('privateKey'))
  assert.equal(JSON.parse(reference).providerId, 'test-protected')
})

test('lost pairing response exposes stable fingerprint and recovers same credential after Main approval', async t => {
  const f = await fixture(t)
  let firstBody: Record<string, string> | undefined
  await assert.rejects(runChildPairingCli(['--config', f.configPath], f.input(), () => {}, {
    keyStore: f.keyStore, fetchPairing: async (_url, init) => {
      firstBody = JSON.parse(init?.body as string)
      throw new Error('response lost')
    },
  }), /response lost/)
  const info = JSON.parse(await readFile(join(f.dataDir, 'credentials', 'device-pairing-info.v1.json'), 'utf8'))
  assert.equal(info.fingerprint, firstBody?.deviceIdentityFingerprint)
  await runChildPairingCli(['--config', f.configPath], f.input(), () => {}, {
    keyStore: f.keyStore,
    fetchPairing: async () => { throw new Error('must not consume another offer') },
    fetchChallenge: async (_url, init) => Response.json({
      ...JSON.parse(init?.body as string), challengeId: 'challenge-1',
      audience: 'ws://main.test:43125/cluster/v1/node', nonce: 'bm9uY2U', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  })
  assert.equal(f.keys.size, 1)
  const reference = JSON.parse(await readFile(join(f.dataDir, 'credentials', 'device-credential.v1.json'), 'utf8'))
  assert.equal(reference.credentialId, firstBody?.credentialId)
  assert.equal(reference.deviceIdentityFingerprint, info.fingerprint)
})

test('pairing CLI rejects PIN argv and malformed input before reading configuration', async () => {
  await assert.rejects(runChildPairingCli(['--config', resolve('missing.json'), '--pin', '123456']), /stdin/)
  const input = async function* () { yield JSON.stringify({ offerId: 'offer-1', pin: 'bad', displayName: 'Child' }) }
  await assert.rejects(runChildPairingCli(['--config', resolve('missing.json')], input()), /input is invalid/)
})

test('compiled root child pair command uses real DPAPI under Electron Node and resumes without tsx', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async t => {
  const f = await fixture(t)
  const compiled = join(f.directory, 'backend')
  await mkdir(compiled, { recursive: true })
  await writeFile(join(compiled, 'package.json'), JSON.stringify({ type: 'module' }))
  const builtEntry = process.env.SHADOW_TEST_BUILT_PAIRING_ENTRY
  if (!builtEntry) {
    await promisify(execFile)(process.execPath, [
      fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json',
      '--outDir', join(compiled, 'dist', 'src'),
    ], { cwd: process.cwd(), timeout: 30_000 })
    const source = resolve('src')
    await cp(source, join(compiled, 'dist', 'src'), {
      recursive: true,
      filter: async path => {
        const parts = relative(source, path).split(sep)
        if (parts[0] === 'testing' || parts.includes('__snapshots__')) return false
        return (await lstat(path)).isDirectory() || !path.endsWith('.ts')
      },
    })
  }
  let requests = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests++
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ version: 1, state: 'pending', pendingId: body.pendingId, requestedAt: new Date().toISOString() }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await writeFile(f.configPath, JSON.stringify({ version: 1, mode: 'child', dataDir: f.dataDir,
    localNodeId: 'real-cli-child', mainEndpoint: `http://127.0.0.1:${address.port}`, allowInsecureLocalTransport: true }))
  async function run(executablePath: string) {
    const child = spawn(executablePath, [builtEntry ?? join(compiled, 'dist', 'src', 'index.js'), 'child', 'pair', '--config', f.configPath],
      { cwd: compiled, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', value => { output += value })
    child.stderr.setEncoding('utf8').on('data', value => { errors += value })
    child.stdin.end(JSON.stringify({ offerId: 'real-offer', pin: '123456', displayName: 'Disposable DPAPI test' }))
    const [code] = await once(child, 'close')
    assert.equal(code, 0, errors)
    assert.equal(output.trim(), '{"version":1,"state":"pending"}')
    assert.ok(!errors.includes('123456'))
  }
  const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
  await run(desktopRequire('electron') as string)
  const referencePath = join(f.dataDir, 'credentials', 'device-credential.v1.json')
  const original = await readFile(referencePath, 'utf8')
  assert.equal(JSON.parse(original).providerId, 'windows-dpapi-current-user')
  await run(process.execPath)
  assert.equal(await readFile(referencePath, 'utf8'), original)
  assert.equal(requests, 1)
})
