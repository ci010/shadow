import { MAX_PREVIEW_LIGHTS, snapshotPreviewLights } from '../three-viewer/src/preview-lights.ts';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export { THREE };
const PUNCTUAL = 'KHR_lights_punctual';
const MAX_LIGHTS = 16;
const inRange = (v, min, max = Number.MAX_VALUE) => Number.isFinite(v) && v >= min && v <= max;

// Resolve the static target even when it is detached or under a different
// parent. The build root is the export boundary, not its authored parent.
function worldMatrix(node, root, fail) {
  const chain = [];
  for (let cursor = node; cursor; cursor = cursor.parent) {
    if (!cursor.isObject3D || chain.length >= 65 || chain.includes(cursor)) fail('invalid light/target ancestry');
    if (cursor.matrixAutoUpdate) cursor.updateMatrix();
    const e = cursor.matrix.elements;
    if (!e.every(Number.isFinite) || e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1) fail('light/target needs a finite affine transform');
    chain.push(cursor);
    if (cursor === root) break;
  }
  const result = new THREE.Matrix4();
  for (const cursor of chain.reverse()) result.multiply(cursor.matrix);
  if (!result.elements.every(Number.isFinite)) fail('non-finite light/target world transform');
  return result;
}

function prepareLight(node, root, location) {
  const fail = message => { throw new Error(`${location}: ${message}`); };
  const type = node instanceof THREE.PointLight ? 'point' : node instanceof THREE.SpotLight ? 'spot' :
    node instanceof THREE.DirectionalLight ? 'directional' : fail('unsupported light; use PointLight, SpotLight, DirectionalLight, HemisphereLight or AmbientLight');
  const color = [node.color?.r, node.color?.g, node.color?.b];
  if (!color.every(v => inRange(v, 0, 1)) || !inRange(node.intensity, 0)) fail('invalid light color or intensity');
  const definition = { type, color, intensity: node.intensity };
  if (node.name) definition.name = node.name;
  if (type !== 'directional') {
    if (!inRange(node.distance, 0) || node.decay !== 2) fail('light needs a finite non-negative distance and decay = 2');
    if (node.distance > 0) definition.range = node.distance;
  }
  const world = worldMatrix(node, root, fail);
  if (type === 'point') return { node, definition };
  if (type === 'spot') {
    if (!inRange(node.angle, 0, Math.PI / 2) || node.angle === 0 || !inRange(node.penumbra, 0, 1)) fail('invalid spotlight angle or penumbra');
    if (node.map) fail('spotlight maps are unsupported');
    let inner = (1 - node.penumbra) * node.angle;
    if (inner >= node.angle) {
      // glTF disallows equal cones. Approximate a hard edge with a 0.01%
      // angular transition, preserving the outer angle. For subnormal angles
      // the multiplication can round back to the original value.
      inner = node.angle * (1 - 1e-4);
      if (inner >= node.angle) inner = 0;
    }
    definition.spot = { innerConeAngle: inner, outerConeAngle: node.angle };
  }
  if (!node.target?.isObject3D) fail('missing light target');
  const target = new THREE.Vector3().setFromMatrixPosition(worldMatrix(node.target, root, fail));
  const direction = target.sub(new THREE.Vector3().setFromMatrixPosition(world));
  const determinant = world.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) fail('singular or out-of-range light transform');
  const inverse = world.clone().invert();
  const local = direction.applyMatrix3(new THREE.Matrix3().setFromMatrix4(inverse));
  const length = Math.hypot(local.x, local.y, local.z);
  if (!Number.isFinite(length) || length === 0) fail('light target must define a finite nonzero direction');
  const emission = new THREE.Object3D();
  local.set(local.x / length, local.y / length, local.z / length);
  const up = Math.abs(local.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  emission.matrix.lookAt(new THREE.Vector3(), local, up);
  emission.matrixAutoUpdate = false;
  return { node, definition, emission };
}

const rgb = color => [color?.r, color?.g, color?.b];
function preparePreviewLight(node, root, location) {
  const fail = message => { throw new Error(`${location}: ${message}`); };
  const base = { color: rgb(node.color), intensity: node.intensity };
  const light = { ...base, type: 'ambient' };
  if (node instanceof THREE.HemisphereLight) {
    const { x, y, z } = new THREE.Vector3().setFromMatrixPosition(worldMatrix(node, root, fail));
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length === 0) fail('hemisphere light needs a finite nonzero world direction');
    light.type = 'hemisphere';
    light.direction = [x / length, y / length, z / length];
    light.groundColor = rgb(node.groundColor);
  }
  try { return snapshotPreviewLights([light])[0]; }
  catch (error) { fail(error.message); }
}

export async function exportRoot(root) {
  const scene = new THREE.Scene();
  const seen = new Set([root]);
  const ids = new Set();
  if (root.isLight || root.isCamera) throw new Error('The build root must remain a group');
  if (!Array.isArray(root.children) || root.children.length > 4096) throw new Error('Scene node limit exceeded');
  const nodes = [...root.children].reverse().map((node, i, list) => [node, String(list.length - 1 - i), 1, root]);
  let count = 0;
  const lights = [];
  const previewLights = [];
  let extraNodes = 0;
  while (nodes.length) {
    const [node, path, depth, parent] = nodes.pop();
    if (!node?.isObject3D || seen.has(node) || node.parent !== parent) throw new Error('Invalid or cyclic scene graph');
    if (++count > 4096 || depth > 64 || !Array.isArray(node.children) || nodes.length + node.children.length + count > 4096) {
      throw new Error('Scene node or depth limit exceeded');
    }
    seen.add(node);
    const location = `root/${path}${node.name ? ` (${JSON.stringify(node.name.slice(0, 120))})` : ''}`;
    if (node.isCamera || node instanceof THREE.Camera) throw new Error(`${location}: cameras are not model output; remove this node`);
    if (node instanceof THREE.HemisphereLight || node instanceof THREE.AmbientLight) {
      if (previewLights.length >= MAX_PREVIEW_LIGHTS) throw new Error(`${location}: preview light limit exceeded (16)`);
      previewLights.push(preparePreviewLight(node, root, location));
      // Preserve the plain transform node (and any children), not the light.
      node.isLight = false;
    } else if (node.isLight || node instanceof THREE.Light) {
      if (lights.length >= MAX_LIGHTS) throw new Error(`${location}: punctual light limit exceeded (16)`);
      const light = prepareLight(node, root, location);
      lights.push(light);
      if (light.emission) {
        extraNodes++;
        if (depth === 64) throw new Error('Scene depth limit exceeded by light emission node');
      }
    }
    if (node.isSkinnedMesh || node.isInstancedMesh) throw new Error('SkinnedMesh and InstancedMesh are outside the playground export profile');
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    if (materials.some(material => Object.values(material).some(value => value?.isTexture))) {
      throw new Error('Material textures are outside the playground export profile; use untextured PBR materials');
    }
    const id = node.userData.objectId;
    const selectable = node.isMesh || node.isLine || node.isPoints;
    if (selectable && id === undefined) {
      throw new Error(`${location}: missing userData.objectId; assign an explicit stable ID to this renderable node`);
    }
    if (id !== undefined) {
      if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error(`${location}: invalid userData.objectId; use a non-blank string of at most 256 characters`);
      if (ids.has(id)) throw new Error(`${location}: duplicate userData.objectId ${JSON.stringify(id)}; assign a unique stable ID`);
      ids.add(id);
    }
    // Rebuild extras rather than preserving a caller-supplied slot map or toJSON hook.
    const { shadowMaterialSlots: ignoredSlots, toJSON: ignoredSerializer, ...extras } = node.userData;
    if (id !== undefined) extras.objectId = id;
    node.userData = extras;
    if (selectable && Array.isArray(node.material)) {
      const geometry = node.geometry;
      const length = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
      const groups = [];
      for (const { start, count, materialIndex } of geometry.groups) {
        if (count === 0) continue;
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0 || start + count > length ||
            !Number.isSafeInteger(materialIndex) || materialIndex < 0 || !node.material[materialIndex]?.isMaterial) {
          throw new Error(`${location}: invalid geometry group range or materialIndex`);
        }
        groups.push({ start, count, materialIndex });
      }
      if (!groups.length) throw new Error(`${location}: multi-material geometry needs at least one non-empty group`);
      if (groups.length !== geometry.groups.length) {
        // r180 emits a primitive even for an empty group. Drop those groups
        // from an export-only copy, leaving shared authored geometry intact.
        node.geometry = geometry.clone();
        node.geometry.groups = groups;
      }
      extras.shadowMaterialSlots = groups.map(group => group.materialIndex);
    }
    for (let i = node.children.length - 1; i >= 0; i--) nodes.push([node.children[i], `${path}/${i}`, depth + 1, node]);
  }
  if (count + extraNodes > 4096) throw new Error('Scene node limit exceeded by light emission nodes');
  const attachments = new Map();
  const definitions = lights.map(({ node, definition, emission }, index) => {
    // Disable r180's built-in plugin, which cannot encode arbitrary targets.
    node.isLight = false;
    if (emission) node.add(emission);
    attachments.set(emission ?? node, index);
    return definition;
  });
  const exporter = new GLTFExporter();
  if (lights.length) exporter.register(writer => ({
    name: PUNCTUAL,
    writeNode(node, output) {
      if (!attachments.has(node)) return;
      writer.extensionsUsed[PUNCTUAL] = true;
      (writer.json.extensions ??= {})[PUNCTUAL] = { lights: definitions };
      (output.extensions ??= {})[PUNCTUAL] = { light: attachments.get(node) };
    },
  }));
  // Export only the root's children. Preserve their full affine transforms
  // (including shear), rather than decomposing the combined matrices into TRS.
  if (root.matrixAutoUpdate) root.updateMatrix();
  for (const child of [...root.children]) {
    if (child.matrixAutoUpdate) child.updateMatrix();
    child.matrix.premultiply(root.matrix);
    child.matrixAutoUpdate = false;
    scene.add(child);
  }
  const glb = await exporter.parseAsync(scene, { binary: true, onlyVisible: false });
  return { glb, previewLights };
}
