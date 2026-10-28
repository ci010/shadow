import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSpatialExampleGlb, MAX_SPATIAL_GLB_BYTES, spatialPointSelector, validateSpatialGlb } from './alignment-spatial'

function mutateJson(bytes: Uint8Array, change: (json: Record<string, any>) => void): Uint8Array {
  const view = new DataView(bytes.buffer), length = view.getUint32(12,true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+length)))
  change(json)
  const encoded = new TextEncoder().encode(JSON.stringify(json)), padded = Math.ceil(encoded.length/4)*4
  const tail = bytes.subarray(20+length), result = new Uint8Array(20+padded+tail.length), out = new DataView(result.buffer)
  result.set(bytes.subarray(0,20)); out.setUint32(8,result.length,true); out.setUint32(12,padded,true)
  result.fill(32,20,20+padded); result.set(encoded,20); result.set(tail,20+padded)
  return result
}
test('generated GLB is deterministic, embedded, and contains three material meshes', () => {
  const bytes = createSpatialExampleGlb(), json = validateSpatialGlb(bytes)
  assert.deepEqual(bytes, createSpatialExampleGlb())
  assert.equal((json.meshes as unknown[]).length,3)
  assert.equal((json.materials as unknown[]).length,3)
  assert.equal((json.buffers as unknown[]).length,1)
  assert.ok(bytes.length < 10000)
})
test('offline validator rejects external resources, data URIs and extensions anywhere', () => {
  const bytes = createSpatialExampleGlb()
  for (const uri of ['https://example.com/texture.png','texture.png','data:image/svg+xml;base64,AAAA']) {
    assert.throws(() => validateSpatialGlb(mutateJson(bytes, json => { json.images = [{ uri }] })), /embedded/)
  }
  assert.throws(() => validateSpatialGlb(mutateJson(bytes, json => { json.nodes[0].extensions = { suspicious: {} } })), /embedded/)
  assert.throws(() => validateSpatialGlb(mutateJson(bytes, json => { json.buffers[0].byteLength = 999999 })), /buffer/)
  assert.throws(() => validateSpatialGlb(mutateJson(bytes, json => { json.asset.version = '1.0' })), /version/)
})
test('offline validator rejects malformed headers, chunks, JSON and oversized input', () => {
  const original = createSpatialExampleGlb()
  for (const index of [0,4,8,12,16,20]) {
    const bytes = original.slice(); bytes[index] = 0xff
    assert.throws(() => validateSpatialGlb(bytes))
  }
  assert.throws(() => validateSpatialGlb(original.subarray(0,original.length-1)))
  assert.throws(() => validateSpatialGlb(new Uint8Array(MAX_SPATIAL_GLB_BYTES+1)), /size/)
})
test('point helper preserves genuine model coordinates, surface anchor and camera', () => {
  const camera = { orbit: '1rad 2rad 3m', target: '-1m 2m 0m' }
  const selector = spatialPointSelector({ x: -2, y: .125, z: 7 }, { x: 0, y: 1, z: 0 }, '0 0 0 1 0', camera)
  assert.deepEqual(selector, { type: 'spatial', position: [-2,.125,7], normal: [0,1,0], surface: '0 0 0 1 0', camera })
  assert.equal(spatialPointSelector({ x: 0,y: 0,z: 0 }, { x: 1,y: 0,z: 0 }, null).surface, undefined)
  assert.throws(() => spatialPointSelector({ x: NaN,y: 0,z: 0 }, { x: 1,y: 0,z: 0 }))
  assert.throws(() => spatialPointSelector({ x: 0,y: 0,z: 0 }, { x: 0,y: 0,z: 0 }))
})
