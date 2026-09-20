import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWebSearchSettingsClient, emptySearchKeys, parseWebSearchStatus, webSearchPatch,
} from './web-search-settings.ts'

const state = {
  provider: 'auto' as const, effectiveProvider: 'firecrawl' as const, ready: true,
  keys: { firecrawl: true, brave: false, exa: false, tavily: false },
}

test('web search settings always use the App endpoint, including when given a Project base', async () => {
  for (const base of ['http://fixture', 'http://fixture/projects/one/']) {
    const client = createWebSearchSettingsClient(base, async (url, init) => {
      assert.equal(String(url), 'http://fixture/api/app/web-search')
      assert.ok(init?.signal)
      if (init?.method === 'PATCH') assert.deepEqual(JSON.parse(String(init.body)), { apiKeys: { exa: 'synthetic-key' } })
      return Response.json(state)
    })
    assert.deepEqual(await client.load(), state)
    assert.deepEqual(await client.save({ apiKeys: { exa: 'synthetic-key' } }), state)
  }
})

test('blank keys are unchanged; replacement, explicit removal and provider choice have distinct patches', () => {
  const keys = emptySearchKeys()
  assert.deepEqual(webSearchPatch(state, 'auto', keys), {})
  keys.firecrawl.value = '   '
  keys.exa.value = ' synthetic-replacement '
  keys.brave.remove = true
  assert.deepEqual(webSearchPatch(state, 'exa', keys),
    { provider: 'exa', apiKeys: { exa: 'synthetic-replacement', brave: null } })
  keys.exa.remove = true
  assert.deepEqual(webSearchPatch(state, 'auto', keys), { apiKeys: { exa: null, brave: null } })
})

test('status rejects malformed or secret-bearing data rather than exposing it to the form', () => {
  for (const value of [{}, { ...state, provider: 'invalid' }, { ...state, keys: { exa: 'synthetic-secret' } },
    { ...state, apiKey: 'synthetic-leak' }, { ...state, keys: { ...state.keys, unexpected: true } },
    { ...state, ready: false }, { ...state, effectiveProvider: 'exa' }]) {
    assert.throws(() => parseWebSearchStatus(value), /invalid|inconsistent/)
  }
  assert.deepEqual(parseWebSearchStatus(state), state)
  assert.equal(parseWebSearchStatus({
    ...state, provider: 'tavily', effectiveProvider: 'tavily', ready: false,
  }).ready, false)
})

test('client gives actionable errors without reflecting backend bodies or saved secrets', async () => {
  for (const code of [400, 401, 403, 500]) {
    const client = createWebSearchSettingsClient('http://fixture', async () =>
      Response.json({ error: 'synthetic-secret' }, { status: code }))
    await assert.rejects(client.save({}), error => {
      assert(error instanceof Error)
      assert.doesNotMatch(error.message, /synthetic-secret/)
      assert.match(error.message, code === 401 || code === 403 ? /administrator/ : /retry/i)
      return true
    })
  }
  await assert.rejects(createWebSearchSettingsClient('http://fixture', async () =>
    new Response('not-json')).load(), /invalid web search settings/)
  await assert.rejects(createWebSearchSettingsClient('http://fixture', async () => {
    throw new Error('synthetic-secret')
  }).load(), /Could not reach Main/)
})
