import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelDefaultsClient, parseModelDefaults } from './model-defaults.ts'

const inherited = { model: 'gpt-6-astra@copilot', temperature: 0.7, reasoningEffort: 'medium' }
const state = { ...inherited, overrides: {}, inherited }

test('default clients preserve unset overrides and use the owning configuration endpoint', async () => {
  for (const scope of ['app', 'project'] as const) {
    const base = scope === 'app' ? 'http://fixture' : 'http://fixture/projects/one/'
    const path = scope === 'app' ? '/api/app/model-defaults' : '/projects/one/api/config/model-defaults'
    const client = createModelDefaultsClient(base, scope, async (url, init) => {
      assert.equal(new URL(String(url)).pathname, path)
      if (init?.method === 'PATCH') assert.deepEqual(JSON.parse(String(init.body)), { model: null, reasoningEffort: null })
      return Response.json(state)
    })
    assert.deepEqual((await client.load()).overrides, {})
    assert.deepEqual(await client.save({ model: null, reasoningEffort: null }), state)
  }
})

test('malformed inheritance metadata does not silently become a default', () => {
  for (const invalid of [{}, { ...state, overrides: null }, { ...state, inherited: {} },
    { ...state, overrides: { model: false } }, { ...state, reasoningEffort: 'invalid' }]) {
    assert.throws(() => parseModelDefaults(invalid), /invalid model defaults/)
  }
})
