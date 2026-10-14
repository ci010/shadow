import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { createStartupProfileEnvironmentResolver } from './startup-profile-arm.js'
import { RuntimeHost } from './runtime-host.js'
import { NodeSidecarSupervisor } from './supervisor.js'

function fixture(t: test.TestContext) {
  const temporary = resolve('.tmp')
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(join(temporary, 'desktop-profile-arm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.logs'))
  const marker = join(root, '.logs', 'startup-profile.arm')
  writeFileSync(marker, '')
  const paths = {
    appPath: join(root, 'desktop'), packaged: false,
    executablePath: process.execPath, resourcesPath: root, userDataPath: root,
  }
  return { root, marker, paths }
}

const dev = { SHADOW_DESKTOP_DEV_IPC: '1' }

test('old launcher without profile env: Electron consumes marker once and failed sidecar retries retain capture', async t => {
  const { root, marker, paths } = fixture(t)
  const resolver = createStartupProfileEnvironmentResolver()
  const environment = resolver(paths, dev)
  const directory = join(root, '.logs', 'startup-profiles')
  assert.equal(environment.SHADOW_STARTUP_PROFILE_DIR, directory)
  assert.equal(existsSync(marker), false)
  assert.equal('SHADOW_STARTUP_PROFILE_DIR' in dev, false)
  const spawns: NodeJS.ProcessEnv[] = []
  const host = new RuntimeHost({
    paths, environment,
    supervisorFactory: () => new NodeSidecarSupervisor({
      environment,
      spawn: (_executable, args, options) => {
        assert.equal(args[0], '--import')
        spawns.push(options.env!)
        throw new Error('synthetic startup failure; no real process launched')
      },
      readinessProbe: async () => ({ ready: false }),
    }),
  })
  assert.equal((await host.start({ role: 'main', port: 43124 })).phase, 'failed')
  assert.equal((await host.start({ role: 'main', port: 43124 })).phase, 'failed')
  assert.deepEqual(spawns.map(env => env.SHADOW_STARTUP_PROFILE_DIR), [directory, directory])
  await host.stop()
  // Rearming while this Electron generation lives must target the next one.
  writeFileSync(marker, '')
  assert.equal(resolver(paths, dev).SHADOW_STARTUP_PROFILE_DIR, directory)
  assert.equal(existsSync(marker), true)
  assert.equal(createStartupProfileEnvironmentResolver()(paths, dev).SHADOW_STARTUP_PROFILE_DIR, directory)
  assert.equal(existsSync(marker), false)
  assert.equal(createStartupProfileEnvironmentResolver()(paths, dev).SHADOW_STARTUP_PROFILE_DIR, undefined)
})

test('fresh pnpm launcher capture directory remains supported without a marker', t => {
  const { marker, paths } = fixture(t)
  rmSync(marker)
  const environment = createStartupProfileEnvironmentResolver()(paths, {
    ...dev, SHADOW_STARTUP_PROFILE_DIR: 'launcher-owned-directory',
  })
  assert.equal(environment.SHADOW_STARTUP_PROFILE_DIR, 'launcher-owned-directory')
})

test('explicit opt-out preserves marker and strips even inherited capture directory', t => {
  const { marker, paths } = fixture(t)
  const resolver = createStartupProfileEnvironmentResolver()
  const environment = resolver(paths, {
    ...dev, SHADOW_STARTUP_PROFILE: '0', SHADOW_STARTUP_PROFILE_DIR: 'inherited',
  })
  assert.equal(environment.SHADOW_STARTUP_PROFILE_DIR, undefined)
  assert.equal(resolver(paths, dev).SHADOW_STARTUP_PROFILE_DIR, undefined)
  assert.equal(existsSync(marker), true)
})

test('packaged and non-development launches never consume repository markers', t => {
  const { marker, paths } = fixture(t)
  const resolver = createStartupProfileEnvironmentResolver()
  assert.equal(resolver({ ...paths, packaged: true }, {
    ...dev, SHADOW_STARTUP_PROFILE_DIR: 'inherited',
  }).SHADOW_STARTUP_PROFILE_DIR, undefined)
  assert.equal(resolver(paths, { SHADOW_STARTUP_PROFILE_DIR: 'inherited' }).SHADOW_STARTUP_PROFILE_DIR, undefined)
  assert.equal(existsSync(marker), true)
})

test('unarmed Electron only checks once; new marker waits for next restart', t => {
  const { marker, paths } = fixture(t)
  rmSync(marker)
  const resolver = createStartupProfileEnvironmentResolver()
  assert.equal(resolver(paths, dev).SHADOW_STARTUP_PROFILE_DIR, undefined)
  writeFileSync(marker, '')
  assert.equal(resolver(paths, dev).SHADOW_STARTUP_PROFILE_DIR, undefined)
  assert.equal(existsSync(marker), true)
})
