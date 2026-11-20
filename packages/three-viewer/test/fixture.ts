export function fixture(ids: (string | undefined)[] = ['left', 'right']) {
  const data = new Uint8Array(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]).buffer);
  return {
    data,
    json: {
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: ids.map((_, i) => i) }],
      nodes: ids.map((id, i) => ({ mesh: 0, name: `Triangle ${i + 1}`, translation: [i * 3, 0, 0], extras: { objectId: id } })),
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: data.length, uri: 'mesh.bin' }],
      bufferViews: [{ buffer: 0, byteLength: data.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }],
    },
  };
}

export function glb(ids?: (string | undefined)[]): Uint8Array {
  const { json, data } = fixture(ids);
  return packGlb(json, data);
}

export function packGlb(json: { buffers: { uri?: string; byteLength: number }[] }, data: Uint8Array) {
  const { uri: _, ...bin } = json.buffers[0];
  const jsonBytes = new TextEncoder().encode(JSON.stringify({ ...json, buffers: [bin] }));
  const jsonSize = (jsonBytes.length + 3) & ~3;
  const bytes = new Uint8Array(28 + jsonSize + data.length);
  const d = new DataView(bytes.buffer);
  const put = (offset: number, value: number) => d.setUint32(offset, value, true);
  put(0, 0x46546c67); put(4, 2); put(8, bytes.length); put(12, jsonSize); put(16, 0x4e4f534a);
  bytes.fill(32, 20, 20 + jsonSize); bytes.set(jsonBytes, 20);
  put(20 + jsonSize, data.length); put(24 + jsonSize, 0x004e4942); bytes.set(data, 28 + jsonSize);
  return bytes;
}
