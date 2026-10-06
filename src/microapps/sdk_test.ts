import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

interface Sdk {
  request(path: string, options?: RequestInit): Promise<Response>
  loadState(signal?: AbortSignal): Promise<unknown>
  saveState(values: unknown, version: number, signal?: AbortSignal): Promise<unknown>
}
async function sdk(fetcher: (path: string, options: RequestInit) => Promise<Response>, ticket = false): Promise<Sdk> {
  const source = await readFile(new URL('./sdk.js', import.meta.url), 'utf8')
  return runInNewContext(source.replace(/^export /gm, '') + '\n({ request, loadState, saveState })', {
    fetch: fetcher, Headers, URLSearchParams, JSON, SyntaxError,
    location: { hash: ticket ? '#shadow_ticket=synthetic-ticket' : '' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => 'synthetic-app-token', setItem() {} },
  })
}

test('SDK state helpers use the authenticated gateway with version and cancellation signal', async () => {
  const controller = new AbortController(), calls: { path: string; options: RequestInit }[] = []
  const client = await sdk(async (path, options) => {
    calls.push({ path, options })
    return Response.json({ version: 1, values: { language: 'ja' } })
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await client.loadState(controller.signal))), { version: 1, values: { language: 'ja' } })
  await client.saveState({ language: 'en' }, 1, controller.signal)
  assert.equal(calls[0].path, '/_shadow/state')
  assert.equal(calls[1].options.method, 'PUT')
  assert.deepEqual(JSON.parse(String(calls[1].options.body)), { version: 1, values: { language: 'en' } })
  assert.equal(calls[1].options.signal, controller.signal)
  assert.equal(new Headers(calls[1].options.headers).get('authorization'), 'Bearer synthetic-app-token')
  await assert.rejects(client.request('https://other.invalid/'), /Use \/_shadow/)
  assert.equal(calls.length, 2)
})

test('SDK HTTP failures preserve status and code, including connection, malformed and non-JSON failures', async () => {
  for (const input of [
    { response: Response.json({ error: 'app_state_conflict', message: 'Reload first' }, { status: 409 }), code: 'app_state_conflict', status: 409, message: 'Reload first' },
    { response: new Response('{bad', { status: 502, headers: { 'Content-Type': 'application/json' } }), code: 'app_http_error', status: 502, message: 'App request failed (502)' },
    { response: new Response('sensitive internal HTML', { status: 503 }), code: 'app_http_error', status: 503, message: 'App request failed (503)' },
    { response: Response.json({ error: 'invalid_ticket', message: 'Reopen the app' }, { status: 401 }), code: 'invalid_ticket', status: 401, message: 'Reopen the app' },
  ]) {
    const client = await sdk(async () => input.response, input.status === 401)
    await assert.rejects(client.loadState(), {
      name: 'AppRequestError', status: input.status, code: input.code, message: input.message,
    })
  }
})

test('SDK request preserves custom application headers and binary uploads while replacing caller authorization', async () => {
  const body = new Uint8Array([82, 73, 70, 70, 0, 255])
  const client = await sdk(async (path, options) => {
    const headers = new Headers(options.headers)
    assert.equal(path, '/backend/recognize')
    assert.equal(headers.get('x-language'), 'ja')
    assert.equal(headers.get('content-type'), 'audio/wav')
    assert.equal(headers.get('authorization'), 'Bearer synthetic-app-token')
    assert.equal(options.body, body)
    assert.equal(options.credentials, 'omit')
    return Response.json({ text: 'fixture' })
  })
  await client.request('/backend/recognize', { method: 'POST',
    headers: { 'X-Language': 'ja', 'Content-Type': 'audio/wav', Authorization: 'untrusted override' }, body })
})
