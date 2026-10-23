import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createBackendPairingCommand, FileChildBootstrap, parseChildPairInput, type ChildPairInput } from './child.js'
import { AtomicLaunchProfileStore } from './launch-profile.js'
import { AtomicFileBootstrapStateStorage } from './storage.js'
import { BootstrapCoordinator } from './coordinator.js'
import { handlePairChild } from '../ipc-main-handlers.js'

const root = resolve('.test-child-bootstrap')
function input(path = root): ChildPairInput {
  return { endpoint: 'http://192.168.1.10:43125', offerId: 'offer-1', pin: '123456',
    displayName: 'Child laptop', dataDir: join(path, 'home'), workdir: join(path, 'work'),
    allowInsecureLocalTransport: true, executionConsent: true }
}
test('Child IPC validates consent, transport, PIN, fields and filesystem scope before calling coordinator', async () => {
  let calls = 0
  const coordinator = { pairChild: async () => { calls++; return { ok: true as const, state: { version: 1 as const, revision: 1, mode: 'child' as const, step: 'complete' as const } } } }
  for (const value of [null, { ...input(), pin: 'bad' }, { ...input(), allowInsecureLocalTransport: false },
    { ...input(), executionConsent: false }, { ...input(), unknown: true }, { ...input(), dataDir: 'relative' },
    { ...input(), workdir: join(root, 'home', 'private') }, { ...input(), endpoint: 'https://user:secret@main.test' }]) {
    assert.throws(() => handlePairChild(coordinator, [value]))
  }
  assert.throws(() => handlePairChild(coordinator, [input(), 'extra']))
  assert.equal(calls, 0)
  await handlePairChild(coordinator, [input()])
  assert.equal(calls, 1)
  assert.equal(parseChildPairInput({ ...input(), endpoint: 'https://main.test', allowInsecureLocalTransport: false }).endpoint, 'https://main.test')
})

test('failed pairing retains identity without PIN and allows endpoint correction but not a new home', async t => {
  const directory = join(root, randomUUID())
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, 'bootstrap.json')
  let attempts = 0
  const bootstrap = new FileChildBootstrap(configPath, async () => { if (++attempts === 1) throw new Error('offline') })
  await assert.rejects(bootstrap.pair(input(directory)), /offline/)
  const first = await bootstrap.readConfig()
  assert.equal((await bootstrap.info()).saved, true)
  const restarted = new FileChildBootstrap(configPath, async () => { attempts++ })
  await restarted.pair(input(directory))
  assert.equal((await restarted.readConfig()).localNodeId, first.localNodeId)
  assert.equal(attempts, 2)
  const text = await readFile(configPath, 'utf8')
  assert.ok(!text.includes('123456') && !text.includes('offer-1') && !text.includes('executionConsent'))
  await assert.rejects(restarted.pair({ ...input(directory), dataDir: join(directory, 'new-home') }), /existing device identity/)
  await restarted.pair({ ...input(directory), endpoint: 'https://corrected.test' })
  assert.equal((await restarted.readConfig()).localNodeId, first.localNodeId)
  const credentials = join(directory, 'home', 'credentials')
  await mkdir(credentials, { recursive: true })
  await writeFile(join(credentials, 'device-credential.v1.json'), JSON.stringify({ version: 1,
    nodeId: first.localNodeId, deviceIdentityFingerprint: 'sha256:test' }))
  await assert.rejects(restarted.pair(input(directory)), /already paired/)
  await assert.rejects(restarted.pair({ ...input(directory), endpoint: 'https://corrected.test', workdir: join(directory, 'other-work') }), /already paired/)
  assert.equal((await restarted.readConfig()).mainEndpoint, 'https://corrected.test')
})

test('pairing is privileged, persists Child role and resumes local runtime without claiming remote connection', async t => {
  const directory = join(root, randomUUID())
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = new AtomicFileBootstrapStateStorage(join(directory, 'wizard.json'))
  const profiles = new AtomicLaunchProfileStore(join(directory, 'launch.json'))
  const child = new FileChildBootstrap(join(directory, 'config.json'), async () => {})
  const launches: unknown[] = []
  const create = () => new BootstrapCoordinator(storage, { writeMain: async () => {} }, { initialize: async () => {} },
    { start: async options => { launches.push(options); return { phase: 'ready', role: 'child', apiBase: 'http://127.0.0.1:43124' } } },
    profiles, { readMain: async () => { throw new Error('must not read Main config') } }, undefined, child)
  const coordinator = create()
  await coordinator.dispatch({ type: 'select-role', mode: 'child' })
  for (const type of ['pairing-offer-entered', 'fingerprint-verified', 'device-named', 'child-capabilities-selected', 'sidecar-ready'] as const) {
    await assert.rejects(coordinator.dispatch({ type }), /dedicated bootstrap command/)
  }
  assert.equal((await coordinator.pairChild(input(directory))).ok, true)
  assert.equal((await storage.load())?.step, 'complete')
  const result = await create().ensureRuntime()
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.context.mode, 'child')
  assert.equal(result.context.mainConnection, 'connecting')
  assert.equal('uiScopes' in result.context, false)
  assert.deepEqual(launches, [{ version: 1, role: 'child', port: 43124 }])
  await assert.rejects(coordinator.clear(), /identity is retained/)
  assert.equal((await coordinator.pairChild(input(directory))).ok, false)
})

test('packaged pairing subprocess receives PIN only on stdin and can be stopped on desktop quit', async t => {
  const directory = join(root, randomUUID())
  const backend = join(directory, 'resources', 'backend', 'dist', 'src')
  await mkdir(backend, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(backend, 'index.js'), `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (process.argv.includes(input.pin) || process.argv[2] !== 'child' || process.argv[3] !== 'pair'
      || process.argv[4] !== '--config') process.exit(2);
    if (input.offerId === 'wait') await new Promise(() => setInterval(() => {}, 1000));
    process.stdout.write(JSON.stringify({version:1,state:'pending'}) + String.fromCharCode(10));
  `)
  const command = createBackendPairingCommand({ executablePath: process.execPath, appPath: directory,
    resourcesPath: join(directory, 'resources'), userDataPath: join(directory, 'profile'), packaged: true })
  await command({ offerId: 'offer-1', pin: '123456', displayName: 'Child' })
  const pending = command({ offerId: 'wait', pin: '123456', displayName: 'Child' })
  const failed = assert.rejects(pending, /Pairing failed/)
  await new Promise(resolve => setTimeout(resolve, 50))
  await command.stop()
  await failed
  await assert.rejects(command({ offerId: 'offer-1', pin: '123456', displayName: 'Child' }), /shutting down/)
})


test('identity conflict loads saved settings but blocks pairing without writing or exposing credentials', async t => {
  const directory = join(root, randomUUID())
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, 'config.json')
  let calls = 0
  const bootstrap = new FileChildBootstrap(configPath, async () => { calls++ })
  await bootstrap.pair(input(directory))
  calls = 0
  const config = await bootstrap.readConfig()
  const original = await readFile(configPath, 'utf8')
  const credentials = join(config.dataDir, 'credentials')
  await mkdir(credentials, { recursive: true })
  const infoPath = join(credentials, 'device-pairing-info.v1.json')
  const credentialPath = join(credentials, 'device-credential.v1.json')
  const info = JSON.stringify({ version: 1, nodeId: 'other-node', fingerprint: 'sha256:other' })
  const credential = JSON.stringify({ version: 1, nodeId: 'other-node', deviceIdentityFingerprint: 'sha256:other', secret: 'never-export-this' })
  await writeFile(infoPath, info)
  await writeFile(credentialPath, credential)
  const result = await bootstrap.info()
  assert.equal(result.identityIssue, 'identity-conflict')
  assert.equal(result.saved, true)
  assert.equal(result.dataDir, config.dataDir)
  assert.equal(result.endpoint, config.mainEndpoint)
  assert.equal(result.fingerprint, undefined)
  assert.ok(!JSON.stringify(result).includes('never-export-this'))
  await assert.rejects(bootstrap.pair(input(directory)), /identity conflicts/)
  assert.equal(calls, 0)
  assert.equal(await readFile(configPath, 'utf8'), original)
  assert.equal(await readFile(infoPath, 'utf8'), info)
  assert.equal(await readFile(credentialPath, 'utf8'), credential)
  // The credential alone must also block mismatched identities.
  await rm(infoPath)
  assert.equal((await bootstrap.info()).identityIssue, 'identity-conflict')
  // An old home must not receive a randomly generated replacement config.
  const missingPath = join(directory, 'missing-config.json')
  const missing = new FileChildBootstrap(missingPath, async () => { calls++ }, config.dataDir, input(directory).workdir)
  assert.equal((await missing.info()).identityIssue, 'identity-conflict')
  await assert.rejects(missing.pair(input(directory)), /identity conflicts/)
  await assert.rejects(readFile(missingPath), { code: 'ENOENT' })
  assert.equal(calls, 0)
})

test('matching, missing and malformed identity metadata produce safe setup results', async t => {
  const directory = join(root, randomUUID())
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bootstrap = new FileChildBootstrap(join(directory, 'config.json'), async () => {})
  await bootstrap.pair(input(directory))
  const config = await bootstrap.readConfig()
  assert.equal((await bootstrap.info()).identityIssue, undefined)
  const credentials = join(config.dataDir, 'credentials')
  await mkdir(credentials, { recursive: true })
  const path = join(credentials, 'device-pairing-info.v1.json')
  await writeFile(path, JSON.stringify({ version: 1, nodeId: config.localNodeId, fingerprint: 'sha256:matching' }))
  assert.equal((await bootstrap.info()).fingerprint, 'sha256:matching')
  await writeFile(join(credentials, 'device-credential.v1.json'), JSON.stringify({ version: 1, nodeId: config.localNodeId, deviceIdentityFingerprint: 'sha256:different' }))
  assert.equal((await bootstrap.info()).identityIssue, 'identity-conflict')
  await writeFile(path, 'not-json-secret')
  const result = await bootstrap.info()
  assert.equal(result.identityIssue, 'identity-unreadable')
  assert.equal(result.fingerprint, undefined)
  await assert.rejects(bootstrap.pair(input(directory)), /identity conflicts/)
})
