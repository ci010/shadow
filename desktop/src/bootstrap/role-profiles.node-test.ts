import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DesktopRoleProfiles, parseRoleSwitchArguments } from './role-profiles.js'
import { AtomicFileBootstrapStateStorage, bootstrapStatePath } from './storage.js'
import { assertRoleDataIsolation } from './role-data-isolation.js'
import { childTransportError } from './pairing-transport.js'
import { pairingDiagnostic } from './child.js'

async function fixture(t: TestContext) {
  const root = resolve('.test-role-profiles', randomUUID())
  await mkdir(root, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

for (const legacy of ['main', 'child'] as const) test(`legacy ${legacy} retains original files; alternate role round-trips without copying data`, async t => {
  const root = await fixture(t)
  const storage = new AtomicFileBootstrapStateStorage(bootstrapStatePath(root))
  await storage.save({ version: 1, revision: 7, mode: legacy, step: 'complete' })
  const config = join(root, 'bootstrap', 'runtime-config.v1.json')
  await writeFile(config, JSON.stringify({ mode: legacy, localNodeId: 'retained-id', dataDir: join(root, 'original-home') }))
  const originalConfig = await readFile(config, 'utf8')
  const originalWizard = await readFile(bootstrapStatePath(root), 'utf8')
  const roles = await DesktopRoleProfiles.load(root)
  assert.equal(roles.explicit, false)
  assert.equal(roles.userDataPath, root)
  await assert.rejects(readFile(join(root, 'bootstrap', 'role-selection.v1.json')), { code: 'ENOENT' })
  const alternate = legacy === 'main' ? 'child' : 'main'
  await roles.select(alternate, legacy)
  const restarted = await DesktopRoleProfiles.load(root)
  assert.equal(restarted.role, alternate)
  assert.equal(restarted.userDataPath, join(root, 'roles', alternate))
  assert.equal(await new AtomicFileBootstrapStateStorage(bootstrapStatePath(restarted.userDataPath)).load(), null)
  await new AtomicFileBootstrapStateStorage(bootstrapStatePath(restarted.userDataPath)).save({ version: 1, revision: 2, mode: alternate, step: 'complete' })
  await restarted.select(legacy, alternate)
  assert.equal((await DesktopRoleProfiles.load(root)).userDataPath, root)
  await restarted.select(alternate, legacy)
  assert.equal((await new AtomicFileBootstrapStateStorage(bootstrapStatePath((await DesktopRoleProfiles.load(root)).userDataPath)).load())?.step, 'complete')
  assert.equal(await readFile(config, 'utf8'), originalConfig)
  assert.equal(await readFile(bootstrapStatePath(root), 'utf8'), originalWizard)
})

test('fresh setup choosing Child reserves original paths for Child; corrupt/mismatched metadata fails closed', async t => {
  const root = await fixture(t)
  const roles = await DesktopRoleProfiles.load(root)
  await roles.select('main', 'child')
  assert.equal((await DesktopRoleProfiles.load(root)).userDataPath, join(root, 'roles', 'main'))
  await writeFile(join(root, 'bootstrap', 'role-selection.v1.json'), '{broken')
  await assert.rejects(DesktopRoleProfiles.load(root))
  await rm(join(root, 'bootstrap', 'role-selection.v1.json'))
  await new AtomicFileBootstrapStateStorage(bootstrapStatePath(root)).save({ version: 1, revision: 1, mode: 'main', step: 'complete' })
  await writeFile(join(root, 'bootstrap', 'runtime-config.v1.json'), '{"mode":"child"}')
  await assert.rejects(DesktopRoleProfiles.load(root), /do not match/)
})

test('role data protection rejects nested and symlink-aliased folders before writes, but allows separate roots', async t => {
  const root = await fixture(t)
  const mainHome = join(root, 'main')
  await mkdir(mainHome)
  const config = join(root, 'main.json')
  await writeFile(config, JSON.stringify({ mode: 'main', dataDir: mainHome }))
  await assert.rejects(assertRoleDataIsolation([join(mainHome, 'nested')], config, 'main'), /non-overlapping/)
  await assert.rejects(assertRoleDataIsolation([root], config, 'main'), /non-overlapping/)
  await assertRoleDataIsolation([join(root, 'child')], config, 'main')
  const alias = join(root, 'alias')
  await symlink(mainHome, alias, 'junction')
  await assert.rejects(assertRoleDataIsolation([join(alias, 'new-home')], config, 'main'), /non-overlapping/)
  await writeFile(config, JSON.stringify({ mode: 'child', dataDir: join(root, 'child-home'), workdirs: [{ rootPath: mainHome }] }))
  await assert.rejects(assertRoleDataIsolation([mainHome], config, 'child'), /non-overlapping/)
})

test('desktop HTTP requires explicit local consent and never opts public plaintext in', () => {
  for (const host of ['192.168.1.5', '10.1.2.3', '172.31.1.2', '100.100.1.2', 'localhost', '[::1]', '[fd00::1]']) {
    assert.equal(childTransportError(`http://${host}:1234`, true), null)
    assert.match(childTransportError(`http://${host}:1234`, false)!, /Explicitly/)
  }
  for (const host of ['8.8.8.8', '172.32.0.1', 'main.example.com', '192.168.1.2.evil.test']) assert.match(childTransportError(`http://${host}`, true)!, /not allowed/)
  assert.equal(childTransportError('https://main.example.com', false), null)
})

test('pairing diagnostics display only known categories, never subprocess output or invitation material', () => {
  const secret = 'PIN=123456 invitation=secret-key'
  for (const output of [secret, JSON.stringify({ version: 1, state: 'failed', code: secret }), JSON.stringify({ version: 1, state: 'failed', code: 'network', message: secret })]) {
    const message = pairingDiagnostic(output)
    assert.ok(!message.includes(secret) && !message.includes('123456'))
  }
  assert.match(pairingDiagnostic('{"version":1,"state":"failed","code":"key-store"}'), /protected OS key store/)
  assert.match(pairingDiagnostic('{"version":1,"state":"failed","code":"offer-rejected"}'), /fresh invitation/)
})

test('role-switch IPC payload cannot bypass OS execution consent or add hidden options', () => {
  for (const args of [[], ['child'], ['child', false], ['child', 'true'], ['main', true, 'extra'], ['master', true], [{ role: 'child' }, true]]) assert.throws(() => parseRoleSwitchArguments(args))
  assert.equal(parseRoleSwitchArguments(['child', true]), 'child')
  assert.equal(parseRoleSwitchArguments(['main', false]), 'main')
})
