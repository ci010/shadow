import { PlaygroundError } from './errors.ts';

export const MAX_GLB_BYTES = 16 * 1024 * 1024;
type Dict = Record<string, unknown>;
const record = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const invalid = (message: string): never => { throw new PlaygroundError('validation', `GLB: ${message}`); };
const PUNCTUAL = 'KHR_lights_punctual';
const MAX_LIGHTS = 16;
const inRange = (v: unknown, min: number, max = Number.MAX_VALUE): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const pbrExtensions = new Set([
  'KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_transmission',
  'KHR_materials_volume', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_iridescence',
  'KHR_materials_sheen', 'KHR_materials_anisotropy', 'KHR_materials_emissive_strength', 'KHR_materials_dispersion',
  'KHR_mesh_quantization',
]);

/** Validate the binary envelope, resource policy and core scene references on the host. */
export function validateGlb(glb: ArrayBuffer): number {
  const size = glb.byteLength;
  if (size < 28 || size > MAX_GLB_BYTES || size % 4) invalid(`invalid length (${size} bytes)`);
  const view = new DataView(glb);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (u32(0) !== 0x46546c67 || u32(4) !== 2 || u32(8) !== size) invalid('invalid GLB 2 header');
  const jsonSize = u32(12);
  const binStart = 20 + jsonSize;
  if (u32(16) !== 0x4e4f534a || jsonSize % 4 || binStart + 8 > size || u32(binStart + 4) !== 0x004e4942) invalid('invalid chunk headers');
  const binSize = u32(binStart);
  if (binSize !== size - binStart - 8) invalid('invalid binary chunk length');
  const json: unknown = (() => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(glb, 20, jsonSize))); }
    catch { return invalid('invalid UTF-8 or JSON'); }
  })();
  if (!record(json) || !record(json.asset) || json.asset.version !== '2.0') return invalid('missing glTF 2.0 asset metadata');
  if (Array.isArray(json.nodes) && json.nodes.length > 4096) invalid('scene limit exceeded');
  const nodeOwners = new Set(Array.isArray(json.nodes) ? json.nodes : []);
  const check = (v: unknown, depth: number) => {
    if (depth > 96) invalid('JSON nesting limit exceeded');
    if (Array.isArray(v)) for (const item of v) check(item, depth + 1);
    else if (record(v)) for (const k in v) {
      if (['uri', 'url', '__proto__', 'constructor', 'prototype'].includes(k)) invalid(`unsupported JSON key: ${k}`);
      if (k === 'extensions') {
        const ext = v[k];
        if (!record(ext) || Object.keys(ext).some(name => !(pbrExtensions.has(name) || (name === PUNCTUAL && (v === json || nodeOwners.has(v)))))) invalid('unsupported extension');
      }
      check(v[k], depth + 1);
    } else if (typeof v === 'number' && !Number.isFinite(v)) invalid('non-finite JSON number');
  };
  check(json, 0);
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const list = json[key];
    if (list !== undefined && (!Array.isArray(list) || list.some(x => x !== PUNCTUAL && !pbrExtensions.has(x)))) invalid('unsupported extension declaration');
  }
  const list = (key: string): Dict[] => {
    const value = json[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(record)) return invalid(`invalid ${key} table`);
    return value;
  };
  const ref = (index: unknown, length: number, label: string) => {
    if (!uint(index) || index >= length) return invalid(`invalid ${label} reference`);
    return index;
  };
  const extension = (owner: Dict) => record(owner.extensions) ? owner.extensions[PUNCTUAL] : undefined;
  const punctual = extension(json);
  const declaredUsed = Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes(PUNCTUAL);
  const declaredRequired = Array.isArray(json.extensionsRequired) && json.extensionsRequired.includes(PUNCTUAL);
  if (declaredUsed !== (punctual !== undefined) || (declaredRequired && !declaredUsed)) invalid('inconsistent punctual light declaration');
  let lightCount = 0;
  if (punctual !== undefined) {
    if (!record(punctual) || !Array.isArray(punctual.lights) || !punctual.lights.length || punctual.lights.length > MAX_LIGHTS) {
      return invalid('invalid punctual light definitions (limit 16)');
    }
    lightCount = punctual.lights.length;
    for (const light of punctual.lights) {
      if (!record(light) || !['point', 'spot', 'directional'].includes(light.type as string)) return invalid('unsupported punctual light type');
      if (light.color !== undefined && (!Array.isArray(light.color) || light.color.length !== 3 || !light.color.every(v => inRange(v, 0, 1)))) {
        invalid('invalid punctual light color');
      }
      if (light.intensity !== undefined && !inRange(light.intensity, 0)) invalid('invalid punctual light intensity');
      if (light.range !== undefined && (light.type === 'directional' || !inRange(light.range, Number.MIN_VALUE))) invalid('invalid punctual light range');
      if (light.type === 'spot') {
        if (light.spot !== undefined && !record(light.spot)) return invalid('invalid spotlight definition');
        const inner = light.spot?.innerConeAngle === undefined ? 0 : light.spot.innerConeAngle;
        const outer = light.spot?.outerConeAngle === undefined ? Math.PI / 4 : light.spot.outerConeAngle;
        if (!inRange(inner, 0, Math.PI / 2) || !inRange(outer, 0, Math.PI / 2) || inner >= outer) invalid('invalid spotlight cone angles');
      } else if (light.spot !== undefined) invalid('spot parameters require a spotlight');
    }
  }
  if (list('cameras').length) invalid('cameras are not model output');
  if (list('images').length || list('textures').length || list('skins').length || list('animations').length) {
    invalid('images, textures, skins and animations are unsupported');
  }
  const buffers = list('buffers');
  const declared = buffers[0]?.byteLength ?? 0;
  if (buffers.length > 1 || !uint(declared) || declared > binSize || binSize - declared > 3) return invalid('invalid embedded buffer');
  const views = list('bufferViews');
  for (const range of views) {
    const offset = range.byteOffset ?? 0;
    if (range.buffer !== 0 || !buffers.length || !uint(offset) || !uint(range.byteLength) || offset + range.byteLength > declared) invalid('bufferView outside embedded buffer');
  }
  const accessors = list('accessors');
  const scales: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const widths: Record<string, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let accessorBytes = 0;
  if (accessors.length > 16384) invalid('accessor limit exceeded');
  for (const a of accessors) {
    const range = views[ref(a.bufferView, views.length, 'accessor bufferView')];
    const components = typeof a.type === 'string' && Object.hasOwn(scales, a.type) ? scales[a.type] : 0;
    const width = typeof a.componentType === 'number' ? widths[a.componentType] : 0;
    const size = components * width;
    const offset = a.byteOffset ?? 0;
    const stride = range.byteStride ?? size;
    if (!size || !uint(offset) || !uint(stride) || stride < size || !uint(a.count) || !a.count || a.sparse !== undefined ||
      !uint(range.byteLength) || offset + (a.count - 1) * stride + size > range.byteLength) return invalid('invalid accessor layout');
    if ((accessorBytes += a.count * size) > 32 * 1024 * 1024) invalid('accessor data limit exceeded');
    for (const bound of [a.min, a.max]) if (bound !== undefined &&
      (!Array.isArray(bound) || bound.length !== components || bound.some(value => typeof value !== 'number'))) invalid('invalid accessor bounds');
  }
  const materials = list('materials');
  const meshes = list('meshes');
  for (const mesh of meshes) {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) return invalid('missing mesh primitives');
    for (const primitive of mesh.primitives) {
      if (!record(primitive) || !record(primitive.attributes)) return invalid('invalid primitive attributes');
      if (primitive.indices !== undefined) ref(primitive.indices, accessors.length, 'indices');
      if (primitive.material !== undefined) ref(primitive.material, materials.length, 'material');
      for (const a of Object.values(primitive.attributes)) ref(a, accessors.length, 'attribute');
    }
  }
  const nodes = list('nodes');
  const scenes = list('scenes');
  const scene = scenes[ref(json.scene, scenes.length, 'default scene')];
  if (nodes.length > 4096 || scenes.length !== 1) invalid('scene limit exceeded');
  const ids = new Set<string>();
  const seen = new Set<number>();
  let lightInstances = 0;
  const visit = (links: unknown, depth: number) => {
    if (links === undefined) return;
    if (!Array.isArray(links) || depth > 64) return invalid('invalid scene links');
    for (const link of links) {
      const index = ref(link, nodes.length, 'node');
      if (seen.has(index)) invalid('cyclic or multiply parented scene');
      seen.add(index);
      const node = nodes[index];
      const attachment = extension(node);
      if (attachment !== undefined) {
        if (!record(attachment)) return invalid(`node ${index}: invalid punctual light attachment`);
        ref(attachment.light, lightCount, 'punctual light');
        if (++lightInstances > MAX_LIGHTS) invalid('active punctual light limit exceeded (16)');
      }
      const id = record(node.extras) ? node.extras.objectId : undefined;
      if (node.mesh !== undefined && id === undefined) invalid(`node ${index}: missing objectId for mesh`);
      if (id !== undefined) {
        if (typeof id !== 'string' || !id.trim() || id.length > 256 || ids.has(id)) return invalid(`node ${index}: invalid or duplicate objectId`);
        ids.add(id);
      }
      const slots = record(node.extras) ? node.extras.shadowMaterialSlots : undefined;
      if (node.mesh !== undefined) {
        const mesh = meshes[ref(node.mesh, meshes.length, 'mesh')];
        const primitives = mesh.primitives as unknown[];
        if ((slots !== undefined || primitives.length > 1) &&
            (!Array.isArray(slots) || slots.length !== primitives.length || !slots.every(uint))) {
          invalid(`node ${index}: invalid shadowMaterialSlots; expected one non-negative integer per primitive`);
        }
      } else if (slots !== undefined) invalid(`node ${index}: shadowMaterialSlots requires a mesh`);
      if (node.camera !== undefined) invalid(`node ${index}: cameras are not model output`);
      if (node.skin !== undefined) ref(node.skin, list('skins').length, 'skin');
      for (const [key, length] of [['matrix',16], ['translation',3], ['rotation',4], ['scale',3]] as const) {
        const value = node[key];
        if (value !== undefined && (!Array.isArray(value) || value.length !== length || value.some(x => typeof x !== 'number'))) invalid(`invalid node ${key}`);
      }
      visit(node.children, depth + 1);
    }
  };
  visit(scene.nodes, 1);
  if (seen.size !== nodes.length) invalid('unreachable nodes');
  return nodes.length;
}
