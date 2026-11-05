import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolImages } from './tool-images.ts'

const image = (url: string) => ({ type: 'image_url', image_url: { url } })
const accepted = (url: string) => toolImages([image(url)]).length === 1

test('tool images preserve allowlist, original strings, order and permissive padding', () => {
  const urls = ['data:image/png;base64,A', 'DATA:IMAGE/JPEG;BASE64,aZ09+/',
    'data:image/gif;base64,A=', 'data:image/webp;base64,abc======']
  assert.deepEqual(toolImages(urls.map(image)), urls)
  for (const value of [null, {}, 'text', 1]) assert.deepEqual(toolImages(value), [])
  assert.deepEqual(toolImages([null, {}, { type: 'image_url' },
    { type: 'image_url', image_url: { url: 1 } }, { type: 'text', image_url: { url: urls[0] } }]), [])
  assert.deepEqual(toolImages([image(urls[0]), image(urls[0])]), [urls[0], urls[0]])
})

test('tool images reject unsafe MIME, malformed payloads and controls including final newlines', () => {
  for (const url of ['data:image/svg+xml;base64,A', 'data:image/jpg;base64,A',
    'data:text/html;base64,A', 'https://example.com/a.png', ' data:image/png;base64,A',
    'data:image/png;name=x;base64,A', 'data:image/png;base64,', 'data:image/png;base64,=',
    'data:image/png;base64,A=A', 'data:image/png;base64,A-', 'data:image/png;base64,A_',
    'data:image/png;base64,é', 'data:image/png;base64,Ａ']) assert.equal(accepted(url), false, url)
  for (let code = 0; code <= 32; code++) {
    for (const suffix of [String.fromCharCode(code), `${String.fromCharCode(code)}A`]) {
      assert.equal(accepted(`data:image/png;base64,A${suffix}`), false, `control ${code}`)
    }
  }
  for (const suffix of ['\u007f', '\u2028', '\u2029']) assert.equal(accepted(`data:image/png;base64,A${suffix}`), false)
})

test('payload validation matches legacy grammar over short exhaustive samples', () => {
  const legacy = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i
  const alphabet = ['A', 'z', '0', '+', '/', '=', '-', ' ', '\u0000']
  function visit(payload: string, remaining: number) {
    const url = `data:image/png;base64,${payload}`
    assert.equal(accepted(url), legacy.test(url), JSON.stringify(payload))
    if (remaining) for (const char of alphabet) visit(payload + char, remaining - 1)
  }
  visit('', 4)
})

test('multi-megabyte payloads are not capped and trailing invalid characters are checked', () => {
  const url = `data:image/png;base64,${'Ab09+/'.repeat(3 * 1024 * 1024)}`
  assert.deepEqual(toolImages([image(url)]), [url])
  assert.equal(accepted(`${url}!`), false)
  assert.equal(accepted(`${url}=A`), false)
  assert.equal(accepted(`${url}\n`), false)
  assert.equal(accepted(`${url}===`), true)
  // Repeated calls and changed payloads cannot reuse stale validation state.
  for (let i = 0; i < 3; i++) {
    assert.equal(accepted(url), true)
    assert.equal(accepted(`${url}!`), false)
    assert.equal(accepted('data:image/png;base64,A'), true)
  }
})
