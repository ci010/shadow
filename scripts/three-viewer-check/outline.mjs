// Run with pnpm exec node --import tsx scripts/three-viewer-check/run.mjs outline.
import { createApp, h } from 'vue';
import * as THREE from 'three';
import { ThreeViewer } from '@shadow/three-viewer';
import { i18n } from '../../app/src/i18n.ts';
import { createResourceStores } from '../../app/src/stores/app.ts';
import { createEditorGroups, EditorGroupsKey } from '../../app/src/editor-groups.ts';
import EditorGroupHost from '../../app/src/components/EditorGroupHost.vue';
import EditorViewHost from '../../app/src/components/EditorViewHost.vue';
import GltfFilePreview from '../../app/src/components/files/GltfFilePreview.vue';
import { apiBase, projectId, sessionId } from './constants.mjs';
import { exportGlb } from './browser.mjs';

// Observe the actual WebGL viewer; neither selection nor rendering is mocked.
const viewers = new WeakMap();
const load = ThreeViewer.prototype.load;
ThreeViewer.prototype.load = function (...args) {
  viewers.set(this.canvas, this);
  return load.apply(this, args);
};
const sides = ['left', 'right'];
const points = [-1.4, 1.4];
const objectId = (side, index) => `${side} box ${index + 1}`;
const blobs = await Promise.all(sides.map(async side => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x359ec4 });
  for (const [index, x] of points.entries()) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x;
    mesh.name = objectId(side, index);
    scene.add(mesh);
  }
  try { return new Blob([await exportGlb(scene)]); }
  finally { geometry.dispose(); material.dispose(); }
}));
const groups = createEditorGroups();
const base = location.origin + apiBase;
const app = createApp({ render: () => h('main', { style: 'height:720px;width:1040px;display:flex;flex-direction:column' }, [
  h(EditorGroupHost, { projectId, apiBase: base, active: true }),
  ...sides.map((side, index) => {
    const path = `${side}.glb`;
    return h(EditorViewHost, { key: side, initialSide: side, descriptor: {
      id: side, projectId, owner: 'outline-check', label: path, icon: '', closable: false, select() {}, close() {},
    } }, () => h(GltfFilePreview, { apiBase: base, sessionId, path, sourceBlob: blobs[index], active: true, canReview: false, fileEditor: true }));
  }),
]) });
app.use(i18n);
app.use(createResourceStores());
app.provide(EditorGroupsKey, groups);
app.mount('#app');

const dock = '.project-file-explorer .model-outline-dock';
const canvas = side => document.querySelector(`[data-editor-id="${side}"] canvas`);
window.outlineCheck = {
  state() {
    const rows = [...document.querySelectorAll(`${dock} [role="treeitem"][aria-selected]`)];
    return {
      panes: document.querySelectorAll(`${dock} .model-outline-pane`).length,
      file: document.querySelector(`${dock} .model-outline-file`)?.textContent,
      rows: rows.map(row => row.getAttribute('aria-label')),
      selectedRows: rows.filter(row => row.getAttribute('aria-selected') === 'true').map(row => row.getAttribute('aria-label')),
      canvases: Object.fromEntries(sides.map(side => {
        const el = canvas(side), viewer = viewers.get(el);
        return [side, { width: el?.clientWidth, version: viewer?.version, selection: viewer?.selection.map(id => viewer.labelFor(id)), status: el?.closest('.model-view').querySelector('.selection')?.textContent, error: el?.closest('.model-view').querySelector('[role=alert]')?.textContent }];
      })),
    };
  },
  control(selector, text) {
    const el = [...document.querySelectorAll(selector)].find(el => !el.disabled && (el.getAttribute('aria-label') ?? el.textContent.trim()) === text);
    const rect = el?.getBoundingClientRect();
    return rect?.width && rect.height ? [rect.x + rect.width / 2, rect.y + rect.height / 2] : null;
  },
  projected(side) {
    const el = canvas(side), viewer = viewers.get(el), rect = el.getBoundingClientRect();
    viewer.camera.updateMatrixWorld();
    return points.map(x => {
      const p = new THREE.Vector3(x, 0, 0).project(viewer.camera);
      return [rect.x + (1 + p.x) / 2 * rect.width, rect.y + (1 - p.y) / 2 * rect.height];
    });
  },
};
