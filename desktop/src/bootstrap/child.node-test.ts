import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createBackendPairingCommand, FileChildBootstrap, parseChildPairInput, type ChildPairInput } from './child.js'
import { AtomicLaunchProfileStore } from './launch-profile.js'
import { AtomicFileBootstrapStateStorage } from './storage.js'
import { BootstrapCoordinator } from './coordinator.js'
import { handlePairChild } from '../ipc-contract.js'

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
  await writeFile(join(credentials, 'device-credential.v1.json'), '{}')
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
  assert.deepEqual(result.context.uiScopes, [])
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
