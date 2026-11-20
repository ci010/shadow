import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export { THREE };
export async function exportRoot(root) {
  const scene = new THREE.Scene();
  const seen = new Set([root]);
  const ids = new Set();
  if (!Array.isArray(root.children) || root.children.length > 4096) throw new Error('Scene node limit exceeded');
  const nodes = [...root.children].reverse().map((node, i, list) => [node, String(list.length - 1 - i), 1]);
  let count = 0;
  while (nodes.length) {
    const [node, path, depth] = nodes.pop();
    if (!node?.isObject3D || seen.has(node)) throw new Error('Invalid or cyclic scene graph');
    if (++count > 4096 || depth > 64 || !Array.isArray(node.children) || nodes.length + node.children.length + count > 4096) {
      throw new Error('Scene node or depth limit exceeded');
    }
    seen.add(node);
    const location = `root/${path}${node.name ? ` (${JSON.stringify(node.name.slice(0, 120))})` : ''}`;
    if (node.isLight || node.isCamera) throw new Error(`${location}: lights and cameras are not model output; remove this node`);
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
    for (let i = node.children.length - 1; i >= 0; i--) nodes.push([node.children[i], `${path}/${i}`, depth + 1]);
  }
  // Export only the root's children. Preserve their full affine transforms
  // (including shear), rather than decomposing the combined matrices into TRS.
  if (root.matrixAutoUpdate) root.updateMatrix();
  for (const child of [...root.children]) {
    if (child.matrixAutoUpdate) child.updateMatrix();
    child.matrix.premultiply(root.matrix);
    child.matrixAutoUpdate = false;
    scene.add(child);
  }
  return new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
}
