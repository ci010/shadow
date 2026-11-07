import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageFromBytes, imageFromDataUrlForModel, readImage, MAX_IMAGE_BYTES } from './image-input.ts'
import { buildMediaParts } from '../agent/message-builder.ts'
import { MIN_OPTIMIZE_IMAGE_BYTES } from './image-optimization.ts'

function chunk(type: string, data: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const result = Buffer.alloc(payload.length + 8)
  result.writeUInt32BE(data.length)
  payload.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
function png(width = 512, height = 512, compressed = false): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height, 255)
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: compressed ? 6 : 0 })), chunk('IEND', Buffer.alloc(0))])
}
const large = png()
const url = (bytes: Uint8Array) => imageFromBytes(bytes).part.image_url.url

test('actual WASM PNG conversion is smaller lossless WebP with matching MIME and dimensions', async () => {
  const part = await imageFromDataUrlForModel(url(large))
  assert.match(part.image_url.url, /^data:image\/webp;base64,/)
  const converted = imageFromBytes(Buffer.from(part.image_url.url.split(',')[1], 'base64'))
  assert.equal(converted.mime, 'image/webp')
  assert.equal(converted.width, 512); assert.equal(converted.height, 512)
  assert.ok(part.image_url.url.length < url(large).length)
  // Decode WebP through the same WASM library to verify pixels, not just a header.
  const { default: decode, init } = await import('@jsquash/webp/decode.js')
  await init({ wasmBinary: await readFile(new URL(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'))) })
  const bytes = Buffer.from(part.image_url.url.split(',')[1], 'base64')
  const decoded = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  assert.ok(decoded.data.every(value => value === 255))
})

test('eligible PNG above 16 million pixels is converted within the existing input limit', async () => {
  const image = png(4001, 4000, true)
  // Valid ancillary metadata keeps this compressible fixture above the byte threshold.
  const source = Buffer.concat([image.subarray(0, 33),
    chunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(256 * 1024, 97)])),
    image.subarray(33)])
  const part = await imageFromDataUrlForModel(url(source))
  assert.match(part.image_url.url, /^data:image\/webp;base64,/)
  const converted = imageFromBytes(Buffer.from(part.image_url.url.split(',')[1], 'base64'))
  assert.equal(converted.width, 4001)
  assert.equal(converted.height, 4000)
  assert.ok(part.image_url.url.length < url(source).length)
})

test('8 KiB threshold includes small screenshots and has an exact binary-byte boundary', async () => {
  assert.equal(MIN_OPTIMIZE_IMAGE_BYTES, 8 * 1024)
  const screenshot = png(64, 64)
  assert(screenshot.length > MIN_OPTIMIZE_IMAGE_BYTES && screenshot.length < 256 * 1024)
  const optimized = await imageFromDataUrlForModel(url(screenshot))
  assert.match(optimized.image_url.url, /^data:image\/webp/)
  const converted = imageFromBytes(Buffer.from(optimized.image_url.url.split(',')[1], 'base64'))
  assert.equal(converted.width, 64); assert.equal(converted.height, 64)
  assert(Buffer.from(optimized.image_url.url.split(',')[1], 'base64').length < screenshot.length)
  const tiny = png(8, 8, true)
  for (const size of [MIN_OPTIMIZE_IMAGE_BYTES - 1, MIN_OPTIMIZE_IMAGE_BYTES]) {
    const metadata = Buffer.alloc(size - tiny.length - 12, 97)
    metadata.write('Comment\0')
    const source = Buffer.concat([tiny.subarray(0, 33), chunk('tEXt', metadata), tiny.subarray(33)])
    assert.equal(source.length, size)
    const result = await imageFromDataUrlForModel(url(source))
    if (size < MIN_OPTIMIZE_IMAGE_BYTES) assert.equal(result.image_url.url, url(source))
    else assert.match(result.image_url.url, /^data:image\/webp/)
  }
})

test('tiny PNG and non-PNG remain unchanged', async () => {
  const small = url(png(8, 8))
  assert.equal((await imageFromDataUrlForModel(small)).image_url.url, small)
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  assert.equal((await imageFromDataUrlForModel(gif)).image_url.url, gif)
})

test('codec failures safely preserve valid-header input', async () => {
  const invalid = Buffer.from(large)
  invalid.fill(0, 50, invalid.length - 12)
  assert.equal((await imageFromDataUrlForModel(url(invalid))).image_url.url, url(invalid))
})

test('validation limits and MIME mismatches are not bypassed by conversion', async () => {
  await assert.rejects(imageFromDataUrlForModel(url(large).replace('image/png', 'image/jpeg')), /MIME/)
  assert.throws(() => imageFromBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /5 MiB/)
  const oversizedPixels = Buffer.from(large)
  oversizedPixels.writeUInt32BE(5001, 16)
  oversizedPixels.writeUInt32BE(5000, 20)
  await assert.rejects(imageFromDataUrlForModel('data:image/png;base64,' + oversizedPixels.toString('base64')), /25 million pixels/)
})

test('abort before and during worker conversion propagates, releases worker slot', async () => {
  const before = new AbortController(); before.abort()
  await assert.rejects(imageFromDataUrlForModel(url(large), before.signal), { name: 'AbortError' })
  const during = new AbortController()
  const pending = imageFromDataUrlForModel(url(large), during.signal)
  during.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.match((await imageFromDataUrlForModel(url(large))).image_url.url, /^data:image\/webp/)
})

test('explicit optimization preserves source files; user ingress defers to the session guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-image-'))
  const path = join(dir, 'source.png')
  try {
    await writeFile(path, large)
    assert.equal((await readImage(path)).mime, 'image/png')
    assert.equal((await readImage(path, undefined, { optimizeForModel: true })).mime, 'image/webp')
    const parts = await buildMediaParts([path, url(large)], dir, dir)
    // Ingress validates only. The session's new-message guard owns optimization.
    for (const part of parts) {
      assert.equal(part.type, 'image_url')
      if (part.type === 'image_url') assert.match(part.image_url.url, /^data:image\/png/)
    }
    assert.deepEqual(await readFile(path), large)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('animated, high-bit-depth and color/orientation-sensitive PNGs are preserved', async () => {
  for (const type of ['acTL', 'iCCP', 'eXIf', 'cHRM']) {
    const source = Buffer.concat([large.subarray(0, 33), chunk(type, Buffer.alloc(8)), large.subarray(33)])
    assert.equal((await imageFromDataUrlForModel(url(source))).image_url.url, url(source))
  }
  const deep = Buffer.from(large); deep[24] = 16
  assert.equal((await imageFromDataUrlForModel(url(deep))).image_url.url, url(deep))
})

test('busy codec queues concurrent images with one decoded allocation at a time', async () => {
  const results = await Promise.all([imageFromDataUrlForModel(url(large)), imageFromDataUrlForModel(url(large))])
  for (const result of results) assert.match(result.image_url.url, /^data:image\/webp/)
  assert.equal(results[0].image_url.url, results[1].image_url.url)
})

test('cancelling a queued image does not cancel the active image or block later images', async () => {
  const active = imageFromDataUrlForModel(url(large))
  const controller = new AbortController()
  const queued = imageFromDataUrlForModel(url(large), controller.signal)
  const reason = new Error('Cancel only the queued image')
  controller.abort(reason)
  await assert.rejects(queued, error => error === reason)
  assert.match((await active).image_url.url, /^data:image\/webp/)
  assert.match((await imageFromDataUrlForModel(url(large))).image_url.url, /^data:image\/webp/)
})

test('incompressible RGBA input is never replaced by larger model bytes', async () => {
  // Deterministic RGBA noise exercises exact transparent-color preservation.
  const header = Buffer.alloc(13)
  header.writeUInt32BE(600); header.writeUInt32BE(600, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc(2401 * 600)
  let state = 123456789
  for (let y = 0; y < 600; y++) for (let x = 1; x <= 2400; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    pixels[y * 2401 + x] = state & 255
  }
  const source = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
  assert.ok(source.length > 256 * 1024)
  const output = (await imageFromDataUrlForModel(url(source))).image_url.url
  const outputBytes = Buffer.from(output.split(',')[1], 'base64')
  assert.ok(output === url(source) || outputBytes.length < source.length)
  assert.equal(imageFromBytes(outputBytes).mime, output.startsWith('data:image/webp') ? 'image/webp' : 'image/png')
  if (output.startsWith('data:image/webp')) {
    const { default: decode, init } = await import('@jsquash/webp/decode.js')
    await init({ wasmBinary: await readFile(new URL(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'))) })
    const decoded = await decode(outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength))
    const expected = Buffer.concat(Array.from({ length: 600 }, (_, row) => pixels.subarray(row * 2401 + 1, (row + 1) * 2401)))
    assert.deepEqual(Buffer.from(decoded.data), expected)
  }
})
