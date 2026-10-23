import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { assertHeadlessServiceMode, resolveServiceEnvironment } from './service-mode.ts'

const environment = {
  ELECTRON_RUN_AS_NODE: '1', WINDOWS_USE_LAUNCH_TOKEN: 'synthetic-credential',
  GATEWAY_PORT: '3123', GATEWAY_HOST: '127.0.0.1',
}

test('service mode permits authenticated headless Electron Node and standalone Node runtimes', () => {
  assertHeadlessServiceMode(environment, { electronVersion: '44.1.1' })
  assertHeadlessServiceMode(environment, {})
})

test('service mode rejects Electron browser, renderer and missing Node mode before startup', () => {
  for (const processType of ['browser', 'renderer', 'utility']) {
    assert.throws(() => assertHeadlessServiceMode(environment, { electronVersion: '44.1.1', processType }), /Node mode/)
  }
  assert.throws(() => assertHeadlessServiceMode({ ...environment, ELECTRON_RUN_AS_NODE: undefined }, { electronVersion: '44.1.1' }), /Node mode/)
})

test('service mode requires fixed authenticated loopback control', () => {
  for (const invalid of [
    { WINDOWS_USE_LAUNCH_TOKEN: '' }, { WINDOWS_USE_LAUNCH_TOKEN: '   ' },
    { GATEWAY_PORT: '0' }, { GATEWAY_PORT: '-1' }, { GATEWAY_PORT: '65536' },
    { GATEWAY_PORT: 'NaN' }, { GATEWAY_HOST: '0.0.0.0' },
  ]) {
    assert.throws(() => assertHeadlessServiceMode({ ...environment, ...invalid }, {}))
  }
})

test('service startup resolves file credentials without changing the process environment', async () => {
  await withTempWorkspace(async root => {
    const path = join(root, 'credential')
    await writeFile(path, 'synthetic-service-credential\n')
    const env = { WINDOWS_USE_LAUNCH_TOKEN_FILE: path, GATEWAY_PORT: '18800' }
    const resolved = await resolveServiceEnvironment(['server', 'start', '--service'], env)
    assert.equal(resolved.WINDOWS_USE_LAUNCH_TOKEN, 'synthetic-service-credential')
    assert.equal('WINDOWS_USE_LAUNCH_TOKEN' in env, false)
    assertHeadlessServiceMode(resolved, {})
  })
})

test('service credential loading rejects conflicting, oversized and malformed inputs without disclosing them', async () => {
  await withTempWorkspace(async root => {
    const path = join(root, 'credential')
    const args = ['server', 'start', '--service']
    await assert.rejects(resolveServiceEnvironment(args, { WINDOWS_USE_LAUNCH_TOKEN_FILE: 'relative' }), /absolute/)
    await assert.rejects(resolveServiceEnvironment(['server', 'start'], { WINDOWS_USE_LAUNCH_TOKEN_FILE: path }), /only supported/)
    await assert.rejects(resolveServiceEnvironment(args, { WINDOWS_USE_LAUNCH_TOKEN_FILE: path, WINDOWS_USE_LAUNCH_TOKEN: 'conflicting' }), /cannot be combined/)
    for (const value of ['', ' ', 'secret with whitespace', 'x'.repeat(4097)]) {
      await writeFile(path, value)
      await assert.rejects(resolveServiceEnvironment(args, { WINDOWS_USE_LAUNCH_TOKEN_FILE: path }), /Unable to read a valid service credential file/)
    }
  })
})
