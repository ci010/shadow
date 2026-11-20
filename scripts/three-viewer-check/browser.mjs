import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const loadGlb = bytes => new GLTFLoader().parseAsync(bytes, '');
export const exportGlb = scene => new GLTFExporter().parseAsync(scene, { binary: true });
export const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
}
window.readDownloadedGlb = async base64 => {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const { scene } = await loadGlb(bytes.buffer);
  const ids = [], sizes = {}, centers = {};
  scene.traverse(node => {
    if (!node.userData.objectId) return;
    ids.push(node.userData.objectId);
    const bounds = new THREE.Box3().setFromObject(node);
    sizes[node.userData.objectId] = bounds.getSize(new THREE.Vector3()).toArray();
    centers[node.userData.objectId] = bounds.getCenter(new THREE.Vector3()).toArray();
  });
  if (ids.length !== 33 || new Set(ids).size !== 33 || !ids.includes('stand.rear.left')) throw new Error('Downloaded fixture lost mesh IDs');
  return { bytes: bytes.byteLength, stableObjectIds: ids.length, baseSize: sizes['stand.base'], rearLeftCenter: centers['stand.rear.left'] };
};

window.runThreeCheck = async () => {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(960, 680);
  document.querySelector('#app').append(renderer.domElement);
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const device = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION), threeRevision: THREE.REVISION };
  const fixture = new THREE.Scene();
  const { build } = await import(/* @vite-ignore */ window.cubeStandEntry);
  await build({ THREE, root: fixture, assets: {}, random: () => .5 });
  const bytes = await exportGlb(fixture);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  link.download = 'cube-stand.glb';
  link.click();
  const workloads = [];
  for (const unique of [false, true]) {
    const source = new THREE.Scene();
    const count = 2048;
    const shape = new THREE.BoxGeometry(.8, .8, .8);
    const material = new THREE.MeshStandardMaterial({ color: 0x359ec4 });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(unique ? shape.clone().scale(1 + i / count / 10, 1, 1) : shape, material);
      mesh.position.set(i % 13 - 6, Math.floor(i / 13) % 13 - 6, Math.floor(i / 169) - 6);
      source.add(mesh);
    }
    const data = await exportGlb(source);
    const camera = new THREE.PerspectiveCamera(42, 960 / 680, .1, 200);
    const raycaster = new THREE.Raycaster(), point = new THREE.Vector3();
    const reload = [], orbit = [], raf = [], pick = [], box = [];
    let geometries, pickHits = 0, boxHits = 0, drawCalls;
    for (let trial = 0; trial < 5; trial++) {
      const start = performance.now();
      const { scene } = await loadGlb(data);
      const meshes = [];
      scene.traverse(node => { if (node.isMesh) meshes.push(node); });
      geometries = new Set(meshes.map(node => node.geometry));
      if (meshes.length !== count || geometries.size !== (unique ? count : 1)) throw new Error('Invalid mesh workload');
      scene.add(new THREE.HemisphereLight(0xffffff, 0x606070, 2));
      camera.position.set(24, 14, 24);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      await frame();
      if (trial > 0) reload.push(performance.now() - start);
      let previous = await frame();
      for (let i = 0; i < 30; i++) {
        const now = await frame(); raf.push(now - previous); previous = now;
        let t = performance.now();
        const angle = i * Math.PI / 15;
        camera.position.set(Math.sin(angle) * 32, 12, Math.cos(angle) * 32);
        camera.lookAt(0, 0, 0);
        renderer.render(scene, camera);
        orbit.push(performance.now() - t);
        drawCalls = renderer.info.render.calls;
        t = performance.now();
        raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        pickHits += raycaster.intersectObjects(meshes, false).length;
        pick.push(performance.now() - t);
        t = performance.now();
        for (const mesh of meshes) {
          point.setFromMatrixPosition(mesh.matrixWorld).project(camera);
          if (Math.abs(point.x) <= .22 && Math.abs(point.y) <= .22 && Math.abs(point.z) <= 1) boxHits++;
        }
        box.push(performance.now() - t);
      }
      for (const geometry of geometries) geometry.dispose();
      for (const material of new Set(meshes.map(mesh => mesh.material))) material.dispose();
    }
    if (!pickHits || !boxHits) throw new Error('Benchmark interactions missed all objects');
    workloads.push({ meshes: count, geometries: geometries.size, bytes: data.byteLength, drawCalls, pickHits, boxHits, glbParseAndFirstFrame: stats(reload), orbitAndSubmit: stats(orbit), rafInterval: stats(raf), raycast: stats(pick), projectedCentersBox: stats(box) });
  }
  renderer.dispose();
  return { device, workloads };
};
