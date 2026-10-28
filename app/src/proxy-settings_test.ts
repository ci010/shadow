import assert from 'node:assert/strict'
import test from 'node:test'
import { createProxySettingsClient, parseProxyStatus } from './proxy-settings.ts'
const state = { enabled: false, detected: true, detectionFailed: false, source: 'environment' as const, http: 'http://proxy.example:8080/', https: '' }

test('proxy client uses Main scope and detection never sends an enable patch', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = []
  const client = createProxySettingsClient('http://fixture/projects/one/', async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body })
    assert.ok(init?.signal)
    return Response.json(state)
  })
  assert.deepEqual(await client.load(), state)
  assert.deepEqual(await client.detect(), state)
  assert.deepEqual(await client.save(false), state)
  assert.deepEqual(calls, [
    { url: 'http://fixture/api/app/proxy', method: 'GET', body: undefined },
    { url: 'http://fixture/api/app/proxy/detect', method: 'POST', body: undefined },
    { url: 'http://fixture/api/app/proxy', method: 'PATCH', body: '{"enabled":false}' },
  ])
})

test('proxy parser rejects credentials and unsupported addresses before rendering', () => {
  for (const http of ['http://user:private-password@proxy.example/', 'socks5://proxy.example/', 'http://proxy.example/path', 'invalid', 42]) {
    assert.throws(() => parseProxyStatus({ ...state, http }))
  }
  for (const value of [null, {}, { ...state, enabled: 'false' }, { ...state, source: 'other' }]) assert.throws(() => parseProxyStatus(value))
  assert.deepEqual(parseProxyStatus(state), state)
})

test('proxy client errors do not reflect private backend bodies', async () => {
  for (const status of [400, 401, 403, 500]) {
    const client = createProxySettingsClient('http://fixture', async () => new Response('private-password', { status }))
    await assert.rejects(client.save(false), error => error instanceof Error && !error.message.includes('private-password'))
  }
})

test('proxy parser accepts macOS static and unsupported automatic detection without widening detected sources', () => {
  for (const source of ['macos-static', 'macos-auto'] as const) {
    const value = { ...state, source, http: '', https: '' }
    assert.deepEqual(parseProxyStatus(value), value)
  }
  const failed = { ...state, source: 'unknown' as const, detected: false, detectionFailed: true, http: '' }
  assert.deepEqual(parseProxyStatus({ ...failed, effective: { source: 'unavailable', enabled: true, blocked: true, failureCode: 'proxy_detection_failed' } }), failed)
  assert.throws(() => parseProxyStatus({ ...state, source: 'unavailable' }))
  assert.throws(() => parseProxyStatus({ ...state, source: 'macOS-auto' }))
})
