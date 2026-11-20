import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepare, snapshot } from '../src/input.js';
import { fixture, glb } from './fixture.js';

const encode = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));
test('loads bounded GLB and copies explicit glTF inputs', () => {
  const doc = fixture();
  const copy = snapshot({ version: 'a', bytes: encode(doc.json), resources: new Map([['mesh.bin', doc.data]]) });
  doc.data.fill(255);
  assert.deepEqual(prepare(copy).buffers[0], fixture().data);
  assert.deepEqual(prepare({ version: 'a', bytes: glb() }).buffers[0], fixture().data);
});
test('never resolves a URI absent from the exact resource map', () => {
  const { json, data } = fixture();
  for (const uri of ['file:///tmp/mesh.bin', 'https://example.invalid/buf', 'data:text/plain;base64,AAAA', '../mesh.bin']) {
    json.buffers[0].uri = uri;
    assert.throws(() => prepare({ version: 'a', bytes: encode(json), resources: new Map([['mesh.bin', data]]) }), /explicitly supplied/);
    assert.equal(prepare({ version: 'a', bytes: encode(json), resources: new Map([[uri, data]]) }).buffers.length, 1);
  }
});
test('rejects unsolicited URIs, decoder extensions, oversized accessors and malformed graphs', () => {
  const { json, data } = fixture();
  const read = (input: unknown) => prepare({ version: 'a', bytes: encode(input), resources: new Map([['mesh.bin', data]]) });
  assert.throws(() => read({ ...json, extras: { uri: 'anything' } }), /URI/);
  assert.throws(() => read({ ...json, extensionsUsed: ['KHR_draco_mesh_compression'] }), /extensions/);
  assert.throws(() => read({ ...json, accessors: [{ ...json.accessors[0], count: 30000 }] }), /accessor range/);
  assert.throws(() => read({ ...json, nodes: [{ ...json.nodes[0], children: [0] }, json.nodes[1]] }), /root|cyclic/);
});
test('rejects oversized or animated PNG before decode', () => {
  const { json, data } = fixture();
  const png = new Uint8Array(45);
  const d = new DataView(png.buffer);
  d.setUint32(0, 0x89504e47); d.setUint32(4, 0x0d0a1a0a); d.setUint32(8, 13); d.setUint32(12, 0x49484452);
  d.setUint32(16, 5000); d.setUint32(20, 5000); png[24] = 8; d.setUint32(37, 0x49454e44);
  const model = { ...json, images: [{ uri: 'large.png' }] };
  const read = () => prepare({ version: 'a', bytes: encode(model), resources: new Map([['mesh.bin', data], ['large.png', png]]) });
  assert.throws(read, /decode budget/);
  d.setUint32(37, 0x6163544c);
  assert.throws(read, /animated PNG/);
});
