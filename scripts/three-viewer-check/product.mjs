import * as THREE from 'three';
import { ThreeViewer } from '@shadow/three-viewer';
import { exportGlb, frame, stats } from './browser.mjs';

const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:960px;height:680px';
document.querySelector('#app').append(canvas);
const viewer = new ThreeViewer(canvas);
// Read renderer telemetry only from the actual viewer instance.
const renderer = viewer.renderer;
const gl = renderer.getContext();
const debug = gl.getExtension('WEBGL_debug_renderer_info');
const device = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION), threeRevision: THREE.REVISION };
const render = renderer.render.bind(renderer);
let frames = [];
renderer.render = (...args) => {
  const start = performance.now();
  render(...args);
  frames.push({ time: start, renderMs: performance.now() - start, drawCalls: renderer.info.render.calls });
};
let variants, revision = 0, target;
async function reload() {
  const start = performance.now();
  const version = String(++revision);
  const model = await viewer.load({ bytes: variants[revision % variants.length], version, identity: 'playground' });
  await frame(); await frame();
  return { elapsed: performance.now() - start, count: model.objectIds.length };
}
window.product = {
  device, stats, reload,
  async init(unique) {
    const count = unique ? 768 : 2048;
    const width = Math.ceil(Math.cbrt(count));
    const source = new THREE.Scene();
    const shape = new THREE.BoxGeometry(.8, .8, .8);
    const material = new THREE.MeshStandardMaterial({ color: 0x359ec4 });
    const geometries = new Set();
    for (let i = 0; i < count; i++) {
      const geometry = unique ? shape.clone().scale(1 + i / count / 10, 1, 1) : shape;
      geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(i % width - width / 2, Math.floor(i / width) % width - width / 2, Math.floor(i / width / width) - width / 2);
      mesh.userData.objectId = `mesh.${i}`;
      source.add(mesh);
    }
    const front = Math.floor((count - 1) / (width * width)) - 1;
    target = source.children[front * width * width + Math.floor(width / 2) * (width + 1)].position.clone();
    const original = await exportGlb(source);
    source.children[0].position.x += .05;
    variants = [original, await exportGlb(source)];
    shape.dispose();
    for (const geometry of geometries) geometry.dispose();
    material.dispose();
    const initial = await reload();
    if (initial.count !== count) throw new Error(`Loaded ${initial.count} vs expected ${count} objects`);
    return { meshes: count, geometries: geometries.size, bytes: variants[0].byteLength, canvas: canvas.getBoundingClientRect().toJSON() };
  },
  camera: () => viewer.getCamera(),
  reset() { viewer.setSelection([]); viewer.setView('front'); frames = []; },
  pickPoint() {
    viewer.camera.updateMatrixWorld();
    const point = target.clone().project(viewer.camera);
    return [(1 + point.x) / 2, (1 - point.y) / 2];
  },
  selected: () => Array.from(viewer.selection),
  drain() { const result = frames; frames = []; return result; },
  dispose: () => viewer.dispose(),
};
