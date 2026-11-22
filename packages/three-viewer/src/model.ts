import { AmbientLight, Box3, Color, DirectionalLight, HemisphereLight, LinearSRGBColorSpace, LoadingManager, Mesh, PointLight,
  Sphere, SpotLight, Texture, Vector3, type Material, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { prepare, type ModelInput } from './input.js';
import type { PreviewLight } from './preview-lights.js';

export const stale = () => new DOMException('Model load superseded, aborted, or viewer disposed', 'AbortError');
export interface Part { mesh: Mesh; material: Material; slot: number | undefined }
export interface ModelOutlineRow {
  readonly key: string;
  readonly parentKey: string | null;
  readonly label: string;
  readonly objectId?: string;
}

export interface Model {
  root: Object3D;
  hasAuthoredLights: boolean;
  outline: readonly ModelOutlineRow[];
  bounds: Box3;
  objects: Map<string, { parts: Part[]; bounds: Box3; label: string; node: number }>;
  ids: Map<Object3D, string>;
  close(): void;
}

export async function decode(input: ModelInput, current: () => boolean, previewLights?: readonly PreviewLight[]): Promise<Model> {
  const { json, buffers, images, lights } = prepare(input);
  const manager = new LoadingManager();
  const urls = new Set<string>();
  const bitmaps = new Map<string, ImageBitmap>();
  const textures = new Set<Texture>(), materials = new Set<Material>();
  const geometries = new Set<Mesh['geometry']>();
  function close() {
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    textures.forEach(t => t.dispose()); bitmaps.forEach(b => b.close()); bitmaps.clear();
  }
  function url(data: Uint8Array, type: string) {
    const u = URL.createObjectURL(new Blob([new Uint8Array(data)], { type })); urls.add(u); return u;
  }
  let failedResource = false;
  manager.onError = () => { failedResource = true; };
  manager.setURLModifier(u => {
    if (!urls.has(u)) throw new Error('Unapproved loader URL');
    return u;
  });
  try {
    buffers.forEach((b, i) => { json.buffers[i].uri = url(b, 'application/octet-stream'); });
    for (const [i, img] of images.entries()) {
      if (!current()) throw stale();
      const blob = new Blob([new Uint8Array(img.data)], { type: img.type });
      const u = URL.createObjectURL(blob); urls.add(u);
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      bitmaps.set(u, bitmap);
      if (bitmap.width !== img.width || bitmap.height !== img.height) throw new Error('Decoded image size mismatch');
      const source = json.images[i];
      delete source.bufferView;
      source.uri = u; source.mimeType = img.type;
    }
    if (!current()) throw stale();
    // GLTFLoader uses this handler for these exact image URLs. No image request is made.
    manager.addHandler(/^blob:/, {
      load(u: string, done: (t: Texture) => void, _progress: unknown, fail: (e: Error) => void) {
        const bitmap = bitmaps.get(u);
        if (!bitmap) { failedResource = true; fail(new Error('Unapproved image')); return; }
        const texture = new Texture(bitmap); texture.needsUpdate = true;
        textures.add(texture); done(texture);
      },
    } as unknown as Parameters<LoadingManager['addHandler']>[1]);
    const gltf = await new GLTFLoader(manager).parseAsync(JSON.stringify(json), '');
    const { scene: root, parser } = gltf;
    for (const scene of gltf.scenes) scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
      }
    });
    if (!current()) throw stale();
    if (failedResource) throw new Error('A glTF resource could not be loaded');
    const objects: Model['objects'] = new Map(), ids = new Map<Object3D, string>();
    const bounds = new Box3(), primitiveByNode = new Map<number, number>();
    const geometryBounds = new Map<Mesh['geometry'], Box3>(), vertex = new Vector3();
    root.updateMatrixWorld(true);
    root.traverse(object => {
      if (!(object instanceof Mesh)) return;
      let owner: Object3D | null = object, node: number | undefined;
      while (owner && node === undefined) { node = parser.associations.get(owner)?.nodes; owner = owner.parent; }
      if (node === undefined) throw new Error('Mesh without a glTF node identity');
      const association = parser.associations.get(object) as { primitives?: number } | undefined;
      const primitive = association?.primitives ?? primitiveByNode.get(node) ?? 0;
      primitiveByNode.set(node, (primitiveByNode.get(node) ?? 0) + 1);
      const geom = object.geometry;
      let local = geometryBounds.get(geom);
      if (!local) {
        const pos = geom.getAttribute('position'), index = geom.getIndex();
        local = new Box3();
        for (let i = 0, count = index?.count ?? pos.count; i < count; i++) {
          const j = index ? index.getX(i) : i;
          local.expandByPoint(vertex.set(pos.getX(j), pos.getY(j), pos.getZ(j)));
        }
        geom.boundingBox = local;
        geom.boundingSphere = local.getBoundingSphere(geom.boundingSphere ?? new Sphere());
        geometryBounds.set(geom, local);
      }
      const box = local.clone().applyMatrix4(object.matrixWorld);
      if (![...box.min.toArray(), ...box.max.toArray()].every(n => Number.isFinite(n) && Math.abs(n) <= 1e12)) throw new Error('Mesh out of scene bounds');
      bounds.union(box);
      const nodeDef = json.nodes[node];
      const explicit = nodeDef.extras?.objectId;
      const playground = input.identity === 'playground';
      if (playground && explicit === undefined) return;
      const id: unknown = playground ? explicit : `gltf:${JSON.stringify([input.identityScope ?? '', input.version])}:${node}:${primitive}`;
      if (typeof id !== 'string' || id.length === 0 || (playground && (id.length > 256 || id.trim() !== id))) {
        throw new Error('Playground mesh objectId must be a unique, nonempty string (max 256 characters)');
      }
      let logical = objects.get(id);
      if (logical && (!playground || logical.node !== node)) throw new Error(`Playground objectId must be unique: ${id}`);
      if (!logical) {
        logical = { parts: [], node, bounds: box.clone(),
          label: (typeof nodeDef.name === 'string' && nodeDef.name.trim()) || object.name || id };
        objects.set(id, logical);
      } else logical.bounds.union(box);
      if (Array.isArray(object.material)) throw new Error('Unexpected non-scalar glTF primitive material');
      const partCount = json.meshes[nodeDef.mesh].primitives.length;
      const slot = playground ? nodeDef.extras?.shadowMaterialSlots?.[primitive] ?? (partCount === 1 ? 0 : undefined) : 0;
      logical.parts.push({ mesh: object, material: object.material, slot });
      ids.set(object, id);
    });
    const outline: ModelOutlineRow[] = [];
    const playgroundIds = new Map<number, string>();
    if (input.identity === 'playground') {
      for (const [id, { node }] of objects) playgroundIds.set(node, id);
    }
    function visit(object: Object3D, parentKey: string | null, sibling: number) {
      const node = parser.associations.get(object)?.nodes;
      const objectId = node !== undefined && input.identity === 'playground' ? playgroundIds.get(node) : ids.get(object);
      let key = parentKey;
      if (node !== undefined) {
        key = `node:${node}`;
        const name = json.nodes[node].name;
        const label = (typeof name === 'string' && name.trim()) ||
          (input.identity === 'playground' ? objectId : undefined) || `Node ${node}`;
        outline.push(Object.freeze({ key, parentKey, label, ...(objectId === undefined ? {} : { objectId }) }));
      } else if (objectId !== undefined && input.identity !== 'playground') {
        key = `${parentKey}/primitive:${sibling}`;
        const label = object.name || `Primitive ${sibling + 1}`;
        outline.push(Object.freeze({ key, parentKey, label, objectId }));
      }
      object.children.forEach((child, i) => visit(child, key, i));
      const def = node === undefined ? undefined : lights.get(node);
      if (def) {
        if (!object.matrixWorld.elements.every(Number.isFinite)) throw new Error('Nonfinite punctual light transform');
        const color = new Color().setRGB(...def.color, LinearSRGBColorSpace);
        const light = def.type === 'directional' ? new DirectionalLight(color, def.intensity)
          : def.type === 'point' ? new PointLight(color, def.intensity, def.range)
          : new SpotLight(color, def.intensity, def.range, def.outer, 1 - def.inner / def.outer);
        light.position.set(0, 0, 0);
        if (light instanceof DirectionalLight || light instanceof SpotLight) {
          light.target.position.set(0, 0, -1);
          light.add(light.target);
        }
        object.add(light);
      }
    }
    root.children.forEach((child, i) => visit(child, null, i));
    for (const def of previewLights ?? []) {
      const color = new Color().setRGB(...def.color, LinearSRGBColorSpace);
      if (def.type === 'ambient') root.add(new AmbientLight(color, def.intensity));
      else {
        const ground = new Color().setRGB(...def.groundColor, LinearSRGBColorSpace);
        const light = new HemisphereLight(color, ground, def.intensity);
        light.position.set(...def.direction);
        root.add(light);
      }
    }
    return { root, hasAuthoredLights: lights.size > 0 || !!previewLights?.length,
      outline: Object.freeze(outline), bounds, objects, ids, close };
  } catch (error) { close(); throw error; }
  finally { urls.forEach(u => URL.revokeObjectURL(u)); }
}
