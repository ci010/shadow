import assert from 'node:assert/strict'
import { test } from 'node:test'
import { open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import { createTempWorkspace } from '../testing/workspace.ts'
import { isMissingMediaFile, mediaFileResponse } from './media-response.ts'

test('media file responses support single byte ranges, HEAD, empty files and safe downloads', async () => {
  const workspace = await createTempWorkspace()
  const path = join(workspace, "视频 '片段'.MP4")
  await writeFile(path, '0123456789')
  const serve = (headers?: HeadersInit, method = 'GET', download = false) =>
    mediaFileResponse(path, new Request('http://localhost/media', { headers, method }), download)
  try {
    for (const [range, expected, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=-99', '0123456789', 'bytes 0-9/10'],
      ['bytes=8-99', '89', 'bytes 8-9/10'],
      ['bytes=8-999999999999999999999', '89', 'bytes 8-9/10'],
      ['bytes=-999999999999999999999', '0123456789', 'bytes 0-9/10'],
    ]) {
      const response = await serve({ Range: range })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('Content-Range'), contentRange)
      assert.equal(response.headers.get('Content-Length'), String(expected.length))
      assert.equal(await response.text(), expected)
    }
    for (const range of ['bytes=10-', 'bytes=-0', 'bytes=999999999999999999999-']) {
      const response = await serve({ Range: range })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('Content-Range'), 'bytes */10')
      assert.equal(response.headers.get('Content-Length'), '0')
      assert.equal(await response.text(), '')
    }
    for (const range of ['bytes=5-2', 'bytes=0-1,5-7', 'bytes=bad', 'items=0-1']) {
      const response = await serve({ Range: range })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '0123456789')
    }
    const ifRange = await serve({ Range: 'bytes=0-1', 'If-Range': '"unknown"' })
    assert.equal(ifRange.status, 200)
    assert.equal(await ifRange.text(), '0123456789')
    const head = await serve({ Range: 'bytes=0-1' }, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('Content-Length'), '10')
    assert.equal(head.headers.get('Content-Type'), 'video/mp4')
    assert.equal(head.body, null)
    const download = await serve(undefined, 'GET', true)
    assert.match(download.headers.get('Content-Disposition')!, /^attachment; filename="__ '__'\.MP4"; filename\*=UTF-8''/)
    assert.match(download.headers.get('Content-Disposition')!, /%E8%A7%86%E9%A2%91%20%27%E7%89%87%E6%AE%B5%27.MP4$/)
    assert.equal(download.headers.get('Cache-Control'), 'private, max-age=3600')
    assert.equal(download.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(download.headers.get('Accept-Ranges'), 'bytes')
    assert.equal(download.headers.get('Access-Control-Allow-Origin'), null)
    await download.body!.cancel()
    await writeFile(path, '')
    const empty = await serve()
    assert.equal(empty.headers.get('Content-Length'), '0')
    assert.equal(empty.body, null)
    assert.equal((await serve({ Range: 'bytes=0-' })).status, 416)
    assert.equal((await mediaFileResponse(workspace, new Request('http://localhost'))).status, 404)
    assert.equal((await mediaFileResponse(join(workspace, 'missing'), new Request('http://localhost'))).status, 404)
    assert.equal(isMissingMediaFile(Object.assign(new Error('denied'), { code: 'EACCES' })), false)
    await assert.rejects(() => mediaFileResponse(`${path}\0`, new Request('http://localhost')), { code: 'ERR_INVALID_ARG_VALUE' })
  } finally {
    await rm(workspace, { recursive: true })
  }
})

test('media MIME types cover video, audio, images and unknown files', async () => {
  const workspace = await createTempWorkspace()
  try {
    for (const [ext, mime] of Object.entries({
      mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
      m4v: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
      ogg: 'audio/ogg', png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf',
      unknown: 'application/octet-stream',
    })) {
      const path = join(workspace, `file.${ext}`)
      await writeFile(path, 'file')
      const response = await mediaFileResponse(path, new Request('http://localhost', { method: 'HEAD' }))
      assert.equal(response.headers.get('Content-Type'), mime)
    }
  } finally {
    await rm(workspace, { recursive: true })
  }
})

test('large media streams close on cancellation and request abort without buffering the file', async () => {
  const workspace = await createTempWorkspace()
  const path = join(workspace, 'large.mp4')
  const file = await open(path, 'w')
  await file.truncate(128 * 1024 * 1024)
  await file.close()
  try {
    for (const abort of [false, true]) {
      const controller = new AbortController()
      const request = new Request('http://localhost', { signal: controller.signal })
      const response = await mediaFileResponse(path, request)
      assert.equal(response.headers.get('Content-Length'), String(128 * 1024 * 1024))
      const reader = response.body!.getReader()
      const first = await reader.read()
      assert(first.value && first.value.byteLength <= 64 * 1024)
      if (abort) {
        controller.abort()
        await assert.rejects(async () => { while (!(await reader.read()).done) { /* Drain queued chunks. */ } }, { name: 'AbortError' })
      } else {
        await reader.cancel()
      }
      for (let attempts = 0; attempts < 100 && getEventListeners(request.signal, 'abort').length; attempts++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(getEventListeners(request.signal, 'abort').length, 0)
    }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => mediaFileResponse(path, new Request('http://localhost', { signal: controller.signal })), { name: 'AbortError' })
  } finally {
    await rm(workspace, { recursive: true })
  }
})
