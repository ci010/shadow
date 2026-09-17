import assert from 'node:assert/strict'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { folderFixture } from '../folders/test-fixtures.ts'
import { serveLocalFiles } from './local-files.ts'

test('local file HTTP adapters retain validation and cancellation status precedence', async t => {
  const { folders } = await folderFixture(t)
  const app = new Hono()
  app.get('/preview', c => serveLocalFiles(c, folders, { key: 'fixture' }, 'preview', c.req.query('path') ?? ''))
  for (const [path, status, body] of [
    ['../outside', 400, { error: 'invalid_path' }],
    ['.', 400, { error: 'not_a_file' }],
    ['missing', 404, { error: 'not_found', path: 'missing' }],
  ] as const) {
    const response = await app.request(`/preview?path=${encodeURIComponent(path)}`)
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), body)
  }
  const controller = new AbortController()
  controller.abort()
  const cancelled = await app.request('/preview?path=missing', { signal: controller.signal })
  assert.equal(cancelled.status, 409)
  assert.deepEqual(await cancelled.json(), { error: 'request_cancelled' })
  const invalid = await app.request('/preview?encoding=unknown', { signal: controller.signal })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'invalid_text_encoding' })
})

test('local file HTTP adapters retain raw headers and Home-only preview source paths', async t => {
  const { folders } = await folderFixture(t)
  await writeFile(join(folders, 'image.png'), 'image bytes')
  const target = join(await realpath(folders), 'image.png')
  const app = new Hono()
  app.get('/raw', c => serveLocalFiles(c, folders, { folderId: 'fixture' }, 'raw', 'image.png'))
  app.get('/preview', c => serveLocalFiles(c, folders, { key: 'fixture' }, 'preview', 'image.png'))
  app.get('/home', c => serveLocalFiles(c, folders, { key: 'fixture' }, 'preview', 'image.png', undefined, 'home'))
  const raw = await app.request('/raw')
  assert.equal(await raw.text(), 'image bytes')
  assert.equal(raw.headers.get('content-type'), 'image/png')
  assert.equal(raw.headers.get('content-length'), '11')
  assert.equal(raw.headers.get('cache-control'), 'no-cache')
  assert.equal(raw.headers.get('access-control-allow-origin'), '*')
  assert.equal(raw.headers.get('x-shadow-source-path'), encodeURIComponent(target))
  assert.equal(raw.headers.get('access-control-expose-headers'), 'X-Shadow-Source-Path')
  const preview = await (await app.request('/preview')).json()
  assert.equal(preview.sourcePath, undefined)
  assert.deepEqual(await (await app.request('/home')).json(), { ...preview, sourcePath: target })
})
