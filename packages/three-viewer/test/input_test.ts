import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepare, snapshot, type ModelInput } from '../src/input.js';
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
test('identifies malformed and oversized glTF tables by path', () => {
  const { json, data } = fixture();
  const read = (input: unknown) => prepare({ version: 'a', bytes: encode(input), resources: new Map([['mesh.bin', data]]) });
  assert.throws(() => read({ ...json, buffers: {} }), /buffers: expected an array \(limit 128 entries\)/);
  assert.throws(() => read({ ...json, scenes: Array(17).fill({}) }), /scenes: 17 entries exceeds limit 16/);
  for (const invalid of [null, 1, 'primitive', []]) {
    assert.throws(() => read({ ...json, meshes: [...json.meshes, { primitives: [{}, invalid] }] }),
      /meshes\[1\]\.primitives\[1\]: expected an object \(2 entries, limit 1024\)/);
  }
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

const punctual = 'KHR_lights_punctual';
const lightRef = (light: unknown) => ({ extensions: { [punctual]: { light } } });

function lightDoc(definitions: unknown[] = [{ type: 'point' }], count = 1) {
  return {
    asset: { version: '2.0' }, extensionsUsed: [punctual], extensionsRequired: [punctual],
    extensions: { [punctual]: { lights: definitions } },
    nodes: Array.from({ length: count }, () => lightRef(0)),
    scenes: [{ nodes: [0] }, { nodes: Array.from({ length: count }, (_, i) => i) }],
    scene: 1,
  };
}
const prepareLights = (json: unknown) => prepare({ version: 'lights', bytes: encode(json) });

test('validates punctual definitions and the active instance budget independently', () => {
  const max = lightDoc(Array.from({ length: 16 }, () => ({ type: 'spot', spot: {} })), 16);
  assert.equal(prepareLights(max).lights.size, 16);
  assert.deepEqual(prepareLights(max).lights.get(0), {
    type: 'spot', color: [1, 1, 1], intensity: 1, range: 0, inner: 0, outer: Math.PI / 4,
  });
  assert.throws(() => prepareLights(lightDoc(Array(17).fill({ type: 'point' }))),
    /extensions\.KHR_lights_punctual\.lights: 17 entries exceeds limit 16/);
  const many = lightDoc(undefined, 17);
  assert.throws(() => prepareLights(many), /instance budget/);
  assert.equal(prepareLights({ ...many, scene: 0 }).lights.size, 1);
  many.nodes[16] = lightRef(1);
  assert.throws(() => prepareLights({ ...many, scene: 0 }), /reference/);
});

test('rejects malformed or misplaced punctual data before rendering', () => {
  const valid = lightDoc();
  for (const def of [
    {}, { type: 'area' }, { type: 'point', color: [0, 0] }, { type: 'point', color: [0, -1, 1] },
    { type: 'point', color: [0, '0', 2] }, { type: 'point', intensity: -1 }, { type: 'point', intensity: null },
    { type: 'point', range: 0 }, { type: 'directional', range: 10 }, { type: 'point', spot: {} },
    { type: 'spot' }, { type: 'spot', spot: [] }, { type: 'spot', spot: { innerConeAngle: -0.1 } },
    { type: 'spot', spot: { outerConeAngle: 0 } }, { type: 'spot', spot: { outerConeAngle: 2 } },
    { type: 'spot', spot: { innerConeAngle: 0.3, outerConeAngle: 0.3 } },
  ]) assert.throws(() => prepareLights(lightDoc([def])), /punctual/);
  assert.throws(() => prepareLights(lightDoc([])), /definitions/);
  for (const index of [null, undefined, '0', -1, 0.5, 1]) {
    assert.throws(() => prepareLights({ ...valid, nodes: [lightRef(index)] }), /reference/);
  }
  assert.throws(() => prepareLights({ ...valid, extensions: undefined }), /reference/);
  assert.throws(() => prepareLights({ ...valid, extensions: lightRef(0).extensions }), /definitions/);
  assert.throws(() => prepareLights({ ...valid, nodes: [{ extensions: valid.extensions }] }), /reference/);
  assert.throws(() => prepareLights({ ...valid, extensionsUsed: [] }), /extension/);
  for (const bad of [
    { materials: [lightRef(0)] }, { scenes: [{ nodes: [0], ...lightRef(0) }], scene: 0 },
    { extras: lightRef(0) }, { asset: { ...valid.asset, ...lightRef(0) } },
  ]) assert.throws(() => prepareLights({ ...valid, ...bad }), /location/);
  const nonfinite = JSON.stringify(lightDoc([{ type: 'point', intensity: 12345 }])).replace('12345', '1e999');
  assert.throws(() => prepare({ version: 'lights', bytes: new TextEncoder().encode(nonfinite) }), /nonfinite/);
});

test('snapshots only valid preview settings, with independent defaults', () => {
  const input = { version: 'preview', bytes: glb() };
  assert.deepEqual(snapshot(input).preview, { toneMapping: 'none', exposure: 1 });
  for (const exposure of [0.1, 4]) {
    const preview = { toneMapping: 'aces' as const, exposure };
    const copy = snapshot({ ...input, preview });
    preview.exposure = 1;
    assert.deepEqual(copy.preview, { toneMapping: 'aces', exposure });
  }
  for (const preview of [null, [], { toneMapping: 'linear' }, ...[0, 4.1, NaN, Infinity, '1', null].map(exposure => ({ exposure }))]) {
    assert.throws(() => snapshot({ ...input, preview: preview as ModelInput['preview'] }), /preview/);
  }
});
