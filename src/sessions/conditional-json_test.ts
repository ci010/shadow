import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { conditionalSessionJson } from './conditional-json.ts'

test('conditional JSON accepts strong, weak, list and wildcard validators; misses preserve JSON', async () => {
  const app = new Hono()
  const value = { text: 'quoted "value"\nwith newline', rows: [1, 2] }
  app.get('/snapshot', c => conditionalSessionJson(c, 'project', value))
  const first = await app.request('/snapshot')
  const etag = first.headers.get('ETag')!
  assert.ok(etag)
  for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
    const response = await app.request('/snapshot', { headers: { 'If-None-Match': validator } })
    assert.equal(response.status, 304)
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('ETag'), etag)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  const miss = await app.request('/snapshot', { headers: { 'If-None-Match': '"other"' } })
  assert.equal(miss.status, 200)
  assert.deepEqual(await miss.json(), value)
})
