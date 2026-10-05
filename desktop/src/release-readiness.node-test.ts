import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { desktopReleaseReadiness } from './release-readiness.js'

const manifest = { buildId: randomUUID(), sourceHash: 'a'.repeat(64) }
const identity = { pid: 123, executablePath: '/Shadow.app/Contents/MacOS/Shadow' }

test('first release reports setup required without creating a role or starting a backend', async () => {
  const result = await desktopReleaseReadiness(manifest, identity, { step: 'choose-role', mode: null },
    async () => { throw new Error('Must not run before setup') })
  assert.equal(result.state, 'setup-required')
  assert.equal(result.role, null)
  assert.equal(result.buildId, manifest.buildId)
  assert.equal(result.pid, identity.pid)
})

test('configured Main and Child releases report the actual runtime result', async () => {
  for (const mode of ['main', 'child'] as const) {
    for (const ok of [true, false]) {
      const result = await desktopReleaseReadiness(manifest, identity, { step: 'complete', mode }, async () => ({ ok }))
      assert.equal(result.state, ok ? 'ready' : 'failed')
      assert.equal(result.role, mode)
    }
  }
})

test('daily Main setup reports its selected role without inventing a ready runtime', async () => {
  const result = await desktopReleaseReadiness(manifest, identity, { step: 'choose-data-directory', mode: 'main' },
    async () => { throw new Error('Setup has not configured a runtime yet') })
  assert.equal(result.state, 'setup-required')
  assert.equal(result.role, 'main')
})

test('release readiness does not invent success for invalid identities or startup errors', async () => {
  await assert.rejects(desktopReleaseReadiness({}, identity, { step: 'complete', mode: 'main' }, async () => ({ ok: true })), /Invalid/)
  await assert.rejects(desktopReleaseReadiness(manifest, identity, { step: 'complete', mode: 'child' },
    async () => { throw new Error('Startup failed') }), /Startup failed/)
})
