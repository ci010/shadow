import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { prepareDevelopment } from './dev.ts'

for (const missing of [true, false]) {
  test(`prepares official assets ${missing ? 'after installing missing dependencies' : 'without reinstalling dependencies'}`, async () => {
    const root = resolve('synthetic-dev-root')
    const calls: unknown[] = []
    let installed = !missing
    await prepareDevelopment(root, {
      exists: path => installed || path !== resolve(root, 'desktop/node_modules/electron/package.json'),
      install: async args => { calls.push(args); installed = true },
      prepareDesktop: async dir => { calls.push(dir) },
    })
    assert.deepEqual(calls, missing ? [['install', '--frozen-lockfile', '--prod=false'], root] : [root])
  })
}

test('does not prepare assets when dependency installation fails', async () => {
  await assert.rejects(prepareDevelopment('.', {
    exists: () => false,
    install: async () => { throw new Error('install failed') },
    prepareDesktop: async () => { assert.fail('installer must not run') },
  }), /install failed/)
})


test('does not prepare assets when install succeeds but required modules remain missing', async () => {
  let installs = 0
  await assert.rejects(prepareDevelopment('.', {
    exists: path => path !== resolve('node_modules/tsx/package.json'),
    install: async () => { installs++ },
    prepareDesktop: async () => { assert.fail('asset preparation must not run') },
  }), /still missing after pnpm install: node_modules\/tsx\/package\.json/)
  assert.equal(installs, 1)
})
