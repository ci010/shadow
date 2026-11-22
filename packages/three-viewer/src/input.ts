export interface ShaderBinding { objectId: string; slot: number; vertex: string; fragment: string }
export interface ModelPreview {
  toneMapping?: 'none' | 'aces';
  exposure?: number;
}
export interface ModelInput {
  preview?: ModelPreview;
  version: string;
  signal?: AbortSignal;
  shaders?: readonly ShaderBinding[];
  identityScope?: string;
  bytes: ArrayBuffer | Uint8Array;
  resources?: ReadonlyMap<string, Uint8Array>;
  identity?: 'playground' | 'gltf';
}

const MiB = 1024 * 1024;
const punctual = 'KHR_lights_punctual';
const lightLimit = 16;
export interface PunctualLight {
  type: 'directional' | 'point' | 'spot';
  color: [number, number, number];
  intensity: number;
  range: number;
  inner: number;
  outer: number;
}

function lightDefinition(def: Json): PunctualLight {
  const { type, color = [1, 1, 1], intensity = 1, range, spot } = def;
  check(type === 'point' || type === 'spot' || type === 'directional', 'punctual light type');
  check(def.name === undefined || typeof def.name === 'string', 'punctual light name');
  check(Array.isArray(color) && color.length === 3 && color.every(c => Number.isFinite(c) && c >= 0 && c <= 1), 'punctual light RGB');
  check(Number.isFinite(intensity) && intensity >= 0, 'punctual light intensity');
  check(range === undefined || (type !== 'directional' && Number.isFinite(range) && range > 0), 'punctual light range');
  check(type === 'spot' ? spot && typeof spot === 'object' && !Array.isArray(spot) : spot === undefined, 'punctual light spot');
  const { innerConeAngle: inner = 0, outerConeAngle: outer = Math.PI / 4 } = spot ?? {};
  check(Number.isFinite(inner) && Number.isFinite(outer) && inner >= 0 && inner < outer && outer <= Math.PI / 2, 'punctual light cone angles');
  return { type, color: color as PunctualLight['color'], intensity, range: range ?? 0, inner, outer };
}
export const limits = Object.freeze({ document: 32 * MiB, json: 2 * MiB, total: 64 * MiB,
  resources: 128, imagePixels: 4096 * 4096, totalPixels: 24 * 1024 * 1024,
  nodes: 4096, primitives: 1024, scenePrimitives: 4096, drawElements: 3_000_000 });

// Dynamic JSON is validated before passing it on to GLTFLoader.
type Json = Record<string, any>;
function check(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(`Unsupported or invalid glTF: ${detail}`);
}
function integer(x: unknown, max: number, min = 0): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
}
function list(x: unknown, path: string, max = 4096): Json[] {
  if (x === undefined) return [];
  check(Array.isArray(x), `${path}: expected an array (limit ${max} entries)`);
  check(x.length <= max, `${path}: ${x.length} entries exceeds limit ${max}`);
  x.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      check(false, `${path}[${i}]: expected an object (${x.length} entries, limit ${max})`);
    }
  });
  return x;
}
function at<T>(xs: T[], i: unknown): T {
  check(integer(i, xs.length - 1), 'reference out of range');
  return xs[i];
}
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

export function snapshot(input: ModelInput): ModelInput {
  check(input.identity === undefined || input.identity === 'gltf' || input.identity === 'playground', 'identity mode');
  check(input.bytes instanceof Uint8Array || input.bytes instanceof ArrayBuffer, 'expected model bytes');
  const source = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  check(source.length > 0 && source.length <= limits.document, 'document size');
  check(!input.resources || input.resources.size <= limits.resources, 'resource count');
  let total = source.length;
  const resources = new Map<string, Uint8Array>();
  for (const [name, data] of input.resources ?? []) {
    check(typeof name === 'string' && name.length <= 2048 && data instanceof Uint8Array && resources.size < limits.resources, 'resource entry');
    total += data.length;
    check(total <= limits.total, 'input byte budget');
    resources.set(name, new Uint8Array(data));
  }
  check(typeof input.version === 'string' && input.version.length > 0 && input.version.length <= 256, 'snapshot version');
  check(input.identityScope === undefined || (typeof input.identityScope === 'string' && input.identityScope.length > 0 && input.identityScope.length <= 512), 'identity scope');
  const { preview } = input;
  check(preview === undefined || (preview && typeof preview === 'object' && !Array.isArray(preview)), 'preview settings');
  const { toneMapping, exposure } = preview ?? {};
  check(toneMapping === undefined || toneMapping === 'none' || toneMapping === 'aces', 'preview tone mapping');
  check(exposure === undefined || (Number.isFinite(exposure) && exposure >= 0.1 && exposure <= 4), 'preview exposure');
  let shaderSize = 0;
  check(!input.shaders || input.shaders.length <= 32, 'shader count');
  const shaders = input.shaders?.map(({ objectId, slot, vertex, fragment }) => {
    check(input.identity === 'playground' && typeof objectId === 'string' && objectId.length <= 256 && integer(slot, 4095), 'shader binding');
    check(typeof vertex === 'string' && typeof fragment === 'string' && vertex.length <= 32768 && fragment.length <= 32768, 'shader size');
    shaderSize += vertex.length + fragment.length;
    check(shaderSize <= 256 * 1024, 'shader source budget');
    return { objectId, slot, vertex, fragment };
  });
  return { version: input.version, signal: input.signal, shaders, identityScope: input.identityScope,
    preview: { toneMapping: toneMapping ?? 'none', exposure: exposure ?? 1 },
    bytes: new Uint8Array(source), resources, identity: input.identity ?? 'gltf' };
}

function imageSize(bytes: Uint8Array): { width: number; height: number; type: string; data: Uint8Array } {
  const d = view(bytes);
  if (bytes.length >= 33 && d.getUint32(0) === 0x89504e47 && d.getUint32(4) === 0x0d0a1a0a) {
    check(d.getUint32(8) === 13 && d.getUint32(12) === 0x49484452 && [1, 2, 4, 8, 16].includes(bytes[24]), 'PNG header');
    // Accept ancillary chunks, but drop non-pixel metadata (including compressed profiles/text).
    // Reject APNG rather than decoding frames outside the per-image pixel budget.
    const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
    let i = 8, count = 0, size = 8;
    while (i + 12 <= bytes.length) {
      const n = d.getUint32(i), tag = d.getUint32(i + 4);
      const end = i + n + 12;
      check(end <= bytes.length && ++count <= 16384, 'PNG chunk');
      check(![0x6163544c, 0x6663544c, 0x66644154].includes(tag), 'animated PNG');
      const retain = [0x49484452, 0x504c5445, 0x49444154, 0x49454e44, 0x74524e53, 0x73524742, 0x67414d41, 0x6348524d].includes(tag);
      check(retain || (bytes[i + 4] & 32), 'unsupported critical PNG chunk');
      check(tag !== 0x49484452 || i === 8, 'duplicate PNG header');
      if (retain) { chunks.push(bytes.subarray(i, end)); size += end - i; }
      i = end;
      if (tag === 0x49454e44) {
        check(i === bytes.length && n === 0, 'PNG ending');
        let data = bytes;
        if (size !== bytes.length) {
          data = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        }
        return { width: d.getUint32(16), height: d.getUint32(20), type: 'image/png', data };
      }
    }
  }
  // Inspect every JPEG frame/scan marker before allowing the browser decoder to run.
  if (bytes.length >= 4 && d.getUint16(0) === 0xffd8) {
    let i = 2, segments = 0, scans = 0, width = 0, height = 0, frame = false;
    while (i < bytes.length) {
      check(bytes[i++] === 0xff && ++segments <= 4096, 'JPEG marker');
      while (bytes[i] === 0xff) i++;
      const tag = bytes[i++];
      if (tag === 0xd9) {
        check(frame && scans && i === bytes.length, 'JPEG ending');
        return { width, height, type: 'image/jpeg', data: bytes };
      }
      check(i + 2 <= bytes.length, 'JPEG segment');
      const n = d.getUint16(i);
      check(n >= 2 && i + n <= bytes.length, 'JPEG segment');
      if (tag === 0xc0 || tag === 0xc2) {
        check(!frame && n >= 8 && bytes[i + 2] === 8 && [1, 3].includes(bytes[i + 7]), 'JPEG frame');
        width = d.getUint16(i + 5); height = d.getUint16(i + 3); frame = true;
      } else {
        check([0xc4, 0xda, 0xdb, 0xdd, 0xfe].includes(tag) || tag >= 0xe0 && tag <= 0xef, 'JPEG encoding');
      }
      i += n;
      if (tag === 0xda) {
        check(frame && ++scans <= 64, 'JPEG scan budget');
        while (i < bytes.length) {
          if (bytes[i++] !== 0xff) continue;
          while (bytes[i] === 0xff) i++;
          const marker = bytes[i];
          if (marker === 0 || marker >= 0xd0 && marker <= 0xd7) { i++; continue; }
          i--; break;
        }
      }
    }
  }
  throw new Error('Unsupported or invalid glTF: only bounded PNG and JPEG images are supported');
}

export function prepare(input: ModelInput) {
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const d = view(bytes);
  let jsonBytes = bytes, bin: Uint8Array | undefined;
  if (bytes.length >= 4 && d.getUint32(0, true) === 0x46546c67) {
    check(bytes.length >= 20 && d.getUint32(4, true) === 2 && d.getUint32(8, true) === bytes.length, 'GLB header');
    const n = d.getUint32(12, true), end = 20 + n;
    check(n % 4 === 0 && end <= bytes.length && d.getUint32(16, true) === 0x4e4f534a, 'GLB JSON chunk');
    jsonBytes = bytes.subarray(20, end);
    if (end < bytes.length) {
      check(end + 8 <= bytes.length && d.getUint32(end + 4, true) === 0x004e4942 && d.getUint32(end, true) === bytes.length - end - 8 && (bytes.length - end - 8) % 4 === 0, 'GLB BIN chunk');
      bin = bytes.subarray(end + 8);
    }
  }
  check(jsonBytes.length <= limits.json, 'JSON byte budget');
  const json: Json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
  check(json?.asset?.version === '2.0' && (!json.asset.minVersion || json.asset.minVersion === '2.0'), 'asset version');
  const buffers = list(json.buffers, 'buffers', limits.resources), images = list(json.images, 'images', limits.resources);
  const materials = list(json.materials, 'materials'), materialOwners = new Set(materials);
  const nodes = list(json.nodes, 'nodes', limits.nodes), nodeOwners = new Set(nodes), scenes = list(json.scenes, 'scenes', 16);
  const activeScene = at(scenes, json.scene === undefined ? 0 : json.scene);
  const extensions = new Set([
    punctual,
    'KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_dispersion', 'KHR_materials_ior',
    'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_iridescence',
    'KHR_materials_anisotropy', 'KHR_materials_volume', 'KHR_materials_emissive_strength', 'KHR_texture_transform',
  ]);
  const textureInfos = new Set<Json>();
  const collectTextures = (owner: Json) => {
    for (const [key, value] of Object.entries(owner)) if (key.endsWith('Texture')) {
      check(value && typeof value === 'object' && !Array.isArray(value), 'material texture');
      textureInfos.add(value);
    }
  };
  for (const m of materials) {
    collectTextures(m);
    if (m.pbrMetallicRoughness) collectTextures(m.pbrMetallicRoughness);
    if (m.extensions) for (const extension of Object.values(m.extensions)) {
      check(extension && typeof extension === 'object' && !Array.isArray(extension), 'material extension');
      collectTextures(extension as Json);
    }
  }
  const declared = json.extensionsUsed ?? [];
  check(Array.isArray(declared) && declared.length <= extensions.size && declared.every(e => extensions.has(e)), 'unsupported extensions');
  const uriOwners = new Set([...buffers, ...images]);
  let objects = 0;
  function scan(value: unknown, depth: number) {
    check(depth <= 48 && ++objects <= 200_000, 'JSON complexity');
    if (typeof value === 'number') check(Number.isFinite(value), 'nonfinite number');
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
      check(!['__proto__', 'prototype', 'constructor'].includes(k), `unsupported key ${k}`);
      if (k === 'extensionsRequired' || k === 'extensionsUsed') {
        check(value === json && Array.isArray(v) && v.length <= extensions.size && v.every(e => declared.includes(e)), 'unsupported extensions');
      }
      if (k === 'extensions') {
        check(v && typeof v === 'object' && !Array.isArray(v), 'extension dictionary');
        for (const [name, params] of Object.entries(v)) {
          check(extensions.has(name) && declared.includes(name) && params && typeof params === 'object' && !Array.isArray(params), 'unsupported extension');
          check(name === punctual ? value === json || nodeOwners.has(value as Json)
            : name === 'KHR_texture_transform' ? textureInfos.has(value as Json) : materialOwners.has(value as Json), 'extension location');
          if (name === 'KHR_texture_transform') {
            const transform = params as Json;
            check(transform.texCoord === undefined || integer(transform.texCoord, 3), 'texture transform channel');
            for (const pair of [transform.offset, transform.scale]) check(pair === undefined || Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite), 'texture transform');
          }
        }
      }
      if (k === 'uri') check(uriOwners.has(value as Json) && typeof v === 'string', 'unexpected URI');
      scan(v, depth + 1);
    }
  }
  scan(json, 0);
  check(!list(json.animations, 'animations').length && !list(json.skins, 'skins').length, 'animation and skinning are not supported');
  function resource(uri: string) {
    const data = input.resources?.get(uri);
    if (data) return data;
    // These embedded bytes are part of the bounded JSON; never pass a data URI to the loader.
    const embedded = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg));base64,/.exec(uri);
    if (embedded) {
      const encoded = uri.slice(embedded[0].length);
      check(encoded.length <= limits.json, 'embedded resource size');
      const binary = atob(encoded);
      return Uint8Array.from(binary, c => c.charCodeAt(0));
    }
    throw new Error(`Unsupported or invalid glTF: missing explicitly supplied resource ${JSON.stringify(uri.slice(0, 120))}`);
  }
  let bufferBudget = 0;
  const bufferBytes = buffers.map((b, i) => {
    const data = b.uri === undefined ? (i === 0 ? bin : undefined) : resource(b.uri);
    check(data && integer(b.byteLength, data.length, 1) && data.length - b.byteLength <= (b.uri === undefined ? 3 : 0), 'buffer length');
    bufferBudget += b.byteLength;
    check(bufferBudget <= limits.total, 'expanded buffer budget');
    return data.subarray(0, b.byteLength);
  });
  const bufferViews = list(json.bufferViews, 'bufferViews');
  let sliceBudget = 0;
  const slices = bufferViews.map(b => {
    const data = at(bufferBytes, b.buffer), offset = b.byteOffset ?? 0;
    check(integer(offset, data.length) && integer(b.byteLength, data.length - offset, 1), 'bufferView range');
    check(b.byteStride === undefined || (integer(b.byteStride, 252, 4) && b.byteStride % 4 === 0 && b.byteLength % b.byteStride === 0), 'bufferView stride');
    sliceBudget += b.byteLength;
    check(sliceBudget <= limits.total, 'expanded bufferView budget');
    return data.subarray(offset, offset + b.byteLength);
  });
  const accessors = list(json.accessors, 'accessors');
  const widths: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const componentWidths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const uploads = new Set<string>();
  let uploadBytes = 0;
  for (const [i, a] of accessors.entries()) {
    const width = widths[a.type], component = componentWidths[a.componentType];
    check(a.sparse === undefined && typeof width === 'number' && typeof component === 'number' && integer(a.count, limits.drawElements, 1), 'accessor encoding');
    const b = at(bufferViews, a.bufferView), offset = a.byteOffset ?? 0, element = width * component, stride = b.byteStride ?? element;
    check(integer(offset, b.byteLength) && offset % component === 0 && stride >= element && stride % component === 0, 'accessor alignment');
    const start = stride === element ? offset : Math.floor(offset / stride) * stride;
    const length = a.count * stride;
    check(start + length <= b.byteLength && (stride === element || offset - start + element <= stride), 'accessor range');
    const key = stride === element ? `accessor:${i}` : `${a.bufferView}:${a.componentType}:${start}:${a.count}`;
    if (!uploads.has(key)) {
      uploads.add(key); uploadBytes += length;
      check(uploadBytes <= 2 * limits.total, 'expanded vertex upload budget');
    }
  }
  let primitives = 0, meshElements = 0;
  const meshes = list(json.meshes, 'meshes');
  const meshCost = meshes.map((mesh, i) => {
    const ps = list(mesh.primitives, `meshes[${i}].primitives`, limits.primitives);
    check(ps.length > 0 && mesh.weights === undefined && (primitives += ps.length) <= limits.primitives, 'primitive budget');
    let elements = 0;
    for (const p of ps) {
      check(p.targets === undefined && (p.mode === undefined || p.mode === 4), 'only static triangle primitives are supported');
      const pos = at(accessors, p.attributes?.POSITION);
      check(pos.type === 'VEC3' && pos.componentType === 5126 && [pos.min, pos.max].every(x => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite)), 'position accessor');
      check(Object.keys(p.attributes).length <= 16, 'vertex attribute budget');
      for (const i of Object.values(p.attributes)) check(at(accessors, i).count === pos.count, 'attribute count');
      const idx = p.indices === undefined ? undefined : at(accessors, p.indices);
      if (idx) check(idx.type === 'SCALAR' && [5121, 5123, 5125].includes(idx.componentType) && at(bufferViews, idx.bufferView).byteStride === undefined, 'index accessor');
      const count = idx?.count ?? pos.count;
      check(count % 3 === 0 && (meshElements += count) <= limits.drawElements, 'triangle budget');
      if (idx) {
        const data = view(at(slices, idx.bufferView)), offset = idx.byteOffset ?? 0;
        const width = componentWidths[idx.componentType];
        for (let i = 0; i < count; i++) {
          const at = offset + i * width;
          const vertex = width === 1 ? data.getUint8(at) : width === 2 ? data.getUint16(at, true) : data.getUint32(at, true);
          check(vertex < pos.count, 'triangle index out of range');
        }
      }
      if (p.material !== undefined) at(materials, p.material);
      elements += count;
    }
    return { elements, primitives: ps.length };
  });
  const rootLights = json.extensions?.[punctual];
  const definitions = list(rootLights?.lights, `extensions.${punctual}.lights`, lightLimit).map(lightDefinition);
  check(rootLights === undefined || (definitions.length > 0 && rootLights.light === undefined), 'punctual light definitions');
  const lights = new Map<number, PunctualLight>();
  const parents = new Set<number>();
  for (const [i, n] of nodes.entries()) {
    const ref = n.extensions?.[punctual];
    if (ref !== undefined) {
      check(ref.lights === undefined && integer(ref.light, definitions.length - 1), 'punctual light reference');
      lights.set(i, definitions[ref.light]);
    }
    check(n.skin === undefined && n.weights === undefined, 'unsupported node');
    const trs = [n.translation, n.rotation, n.scale];
    check(n.matrix === undefined || trs.every(value => value === undefined), 'matrix and TRS cannot be combined');
    for (const [j, value] of [...trs, n.matrix].entries()) {
      check(value === undefined || (Array.isArray(value) && value.length === [3, 4, 3, 16][j]
        && value.every(Number.isFinite)), 'node transform');
    }
    if (n.mesh !== undefined) {
      const cost = at(meshCost, n.mesh);
      const slots = n.extras?.shadowMaterialSlots;
      if (input.identity === 'playground' && slots !== undefined) {
        check(Array.isArray(slots) && slots.length === cost.primitives && slots.every(s => integer(s, 4095)), 'shadowMaterialSlots must map each exported primitive to its authored material slot');
      }
    }
    check(n.children === undefined || Array.isArray(n.children), 'node children');
    for (const i of n.children ?? []) { at(nodes, i); check(!parents.has(i), 'node has multiple parents'); parents.add(i); }
  }
  let draws = 0, elements = 0;
  const visited = new Set<number>();
  function visit(i: number, seen: Set<number>, depth: number) {
    const n = at(nodes, i);
    check(!seen.has(i) && depth <= 64, 'cyclic/repeated node or excessive graph depth');
    seen.add(i); visited.add(i);
    if (n.mesh !== undefined) {
      const cost = at(meshCost, n.mesh);
      draws += cost.primitives; elements += cost.elements;
      check(draws <= limits.scenePrimitives && elements <= limits.drawElements, 'scene draw budget');
    }
    for (const child of n.children ?? []) visit(child, seen, depth + 1);
  }
  for (const s of scenes) {
    check(s.nodes === undefined || Array.isArray(s.nodes), 'scene nodes');
    const seen = new Set<number>();
    for (const i of s.nodes ?? []) { check(!parents.has(i), 'scene root has a parent'); visit(i, seen, 0); }
    if (s === activeScene) {
      for (const i of lights.keys()) if (!seen.has(i)) lights.delete(i);
      check(lights.size <= lightLimit, 'active punctual light instance budget');
    }
  }
  // Reject unreachable nodes (including cycles) rather than letting loader dependency resolution see them.
  check(visited.size === nodes.length, 'unreachable nodes');
  let pixels = 0, imageBytes = 0;
  const imageData = images.map(img => {
    check((img.uri !== undefined) !== (img.bufferView !== undefined), 'image source');
    const data = img.uri !== undefined ? resource(img.uri) : at(slices, img.bufferView);
    const info = imageSize(data);
    pixels += info.width * info.height; imageBytes += data.length;
    check(integer(info.width, 4096, 1) && integer(info.height, 4096, 1) && info.width * info.height <= limits.imagePixels && pixels <= limits.totalPixels && imageBytes <= limits.total, 'image decode budget');
    check(img.mimeType === undefined || img.mimeType === info.type, 'image MIME mismatch');
    return info;
  });
  const textures = list(json.textures, 'textures', limits.resources), samplers = list(json.samplers, 'samplers', limits.resources);
  for (const s of samplers) {
    check(s.magFilter === undefined || [9728, 9729].includes(s.magFilter), 'texture mag filter');
    check(s.minFilter === undefined || [9728, 9729, 9984, 9985, 9986, 9987].includes(s.minFilter), 'texture min filter');
    check([s.wrapS, s.wrapT].every(w => w === undefined || [33071, 33648, 10497].includes(w)), 'texture wrap');
  }
  let texturePixels = 0;
  const variants = new Set<string>();
  for (const t of textures) {
    const img = at(imageData, t.source);
    if (t.sampler !== undefined) at(samplers, t.sampler);
    const key = `${t.source}:${t.sampler}`;
    if (!variants.has(key)) {
      variants.add(key); texturePixels += img.width * img.height;
      check(texturePixels <= limits.totalPixels, 'texture upload budget');
    }
  }
  for (const t of textureInfos) {
    check(t.texCoord === undefined || integer(t.texCoord, 3), 'material texture channel');
    at(textures, t.index);
  }
  // Only instantiate the default scene. Other scenes can legally share roots;
  // loading them all would reparent those roots in Three's Object3D tree.
  json.scenes = [activeScene]; json.scene = 0;
  // Attach lights ourselves: GLTFLoader can replace a mesh node with a group
  // and cloned directional/spot lights can lose their in-tree target.
  if (rootLights !== undefined) delete json.extensions[punctual];
  for (const n of nodes) if (n.extensions) delete n.extensions[punctual];
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (json[key]) json[key] = json[key].filter((name: string) => name !== punctual);
  }
  return { json, buffers: bufferBytes, images: imageData, lights };
}
