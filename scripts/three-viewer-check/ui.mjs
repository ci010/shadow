import { createApp, h, ref } from 'vue';
import { i18n } from '../../app/src/i18n.ts';
import { composeGltfReferenceMessage, createGltfReferenceDraftBridge, GltfReferenceDraftKey } from '../../app/src/gltf-reference.ts';
import FilePreviewModal from '../../app/src/components/files/FilePreviewModal.vue';
import { gltfCaptureChatHeaders } from '../../app/src/gltf-capture-bridge.ts';
import { ThreeViewer } from '@shadow/three-viewer';
import { apiBase, marker, projectId, sessionId } from './constants.mjs';
import './browser.mjs';

// Adapter observes the live viewer, without changing its behavior or adding
// production hooks. mounted in Electron; no mocked canvas or renderer.
let viewer;
const load = ThreeViewer.prototype.load;
const buildStarts = [], viewerLoads = [];
new MutationObserver(records => {
  for (const { addedNodes } of records) {
    for (const node of addedNodes) {
      if (node instanceof HTMLIFrameElement && node.getAttribute('sandbox') === 'allow-scripts') buildStarts.push(Date.now());
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
ThreeViewer.prototype.load = function (...args) {
  viewer = this;
  const row = { version: args[0].version, started: Date.now() };
  viewerLoads.push(row);
  return load.apply(this, args).then(result => { row.committed = Date.now(); return result; });
};
const references = ref([]), active = ref(true), opened = ref(false);
const [name, dir] = [marker.split('/').at(-1), marker.slice(0, marker.lastIndexOf('/'))];
const view = createApp({ render: () => h('main', [opened.value
  ? h('div', { style: 'height:710px;width:1040px;display:flex;flex-direction:column' }, [h(FilePreviewModal, {
      dir, entry: { name, ext: '.json', type: 'file', size: 0, mtime: null },
      apiBase: location.origin + apiBase, sessionId, sessionWorkspace: true, inline: true,
      active: active.value, canQuote: true, remote: false,
    })])
  : h('button', { onClick: () => { opened.value = true; } }, 'Open cube stand'),
  h('div', { 'aria-label': 'Synthetic chat draft' }, references.value.map(ref => h('span', { 'data-draft-object': ref.object.objectId }, ref.label)))]) });
view.use(i18n);
view.provide(GltfReferenceDraftKey, createGltfReferenceDraftBridge(() => ({ key: 'synthetic-draft', label: 'Synthetic chat', sessionId }), objects => {
  references.value = [...references.value, ...objects];
  active.value = false;
  return true;
}));
view.mount('#app');

window.threeUi = {
  activate() { active.value = true; },
  button(name) {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find(button => [button.textContent?.trim(), button.getAttribute('aria-label')].includes(name));
    if (!button || button.disabled) return null;
    const { x, y, width, height } = button.getBoundingClientRect();
    return [Math.round(x + width / 2), Math.round(y + height / 2)];
  },
  state() {
    const canvas = document.querySelector('canvas');
    const { x, y, width, height } = canvas?.getBoundingClientRect() ?? {};
    return { canvas: canvas ? { x, y, width, height } : null, active: active.value, alert: document.querySelector('[role=alert]')?.innerText, text: document.body.innerText, drafts: references.value.map(item => item.object) };
  },
  requests: () => fetch(`${apiBase}/requests`).then(response => response.json()),
  buildStarts: () => buildStarts,
  viewerLoads: () => viewerLoads,
  bindingReady: () => Object.keys(gltfCaptureChatHeaders(location.origin + apiBase, projectId, sessionId)).length > 0,
  admit: content => post('/api/chat/send', { chatId: sessionId.slice(4), content: composeGltfReferenceMessage(content, references.value) }, gltfCaptureChatHeaders(location.origin + apiBase, projectId, sessionId)),
  tool: (messageId, name, args) => post(`/test/tool/${name}`, { messageId, args }),
  async capturedToolResult(value) {
    if (value.error) return value;
    const [info, image] = value.content ?? [];
    const data = image?.image_url?.url?.match(/^data:image\/png;base64,(.+)$/)?.[1];
    if (info?.type !== 'text' || image?.type !== 'image_url' || !data || !/transient/i.test(value.transient)) throw new Error('Expected transient tool image_url, not a local path');
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const size = [bitmap.width, bitmap.height]; bitmap.close();
    const sha = await crypto.subtle.digest('SHA-256', bytes);
    return { ...JSON.parse(info.text), size, bytes: bytes.length, imageHash: [...new Uint8Array(sha)].join(',') };
  },
  camera: () => viewer.getCamera(),
  selection: () => viewer.selection,
  async capture(view) {
    const { image, ...frame } = await viewer.captureFrame(view);
    const bytes = typeof image === 'string' ? new TextEncoder().encode(image) : new Uint8Array(await image.arrayBuffer());
    const sha = await crypto.subtle.digest('SHA-256', bytes);
    return { ...frame, imageBytes: bytes.length, imageHash: [...new Uint8Array(sha)].join(',') };
  },
};

async function post(path, body, extraHeaders = {}) {
  const response = await fetch(apiBase + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture endpoint ${path} failed: ${response.status}: ${await response.text()}`);
  return response.json();
}
