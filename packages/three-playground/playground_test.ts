import assert from 'node:assert/strict';
import { after, test as nodeTest } from 'node:test';
import { launchBrowser } from './browser-test-driver.mjs';
import { compileSnapshot } from './snapshot-modules.mjs';
import { buildPlayground as buildInDocument, PlaygroundError, type PlaygroundOptions, type PlaygroundSnapshot, type PlaygroundPhase } from './index.ts';
import { validateGlb } from './validate.ts';

const executable = process.env.PLAYGROUND_CHROMIUM;
let driver: ReturnType<typeof launchBrowser> | undefined;
const browser = () => driver ??= launchBrowser(executable!);
after(async () => { if (driver) await (await driver.catch(() => undefined))?.close(); });
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { skip: !executable && 'Set PLAYGROUND_CHROMIUM to a Chromium executable' }, fn);
async function buildPlayground(snapshot: PlaygroundSnapshot, options: PlaygroundOptions & { cancelAfter?: number; mutateInputs?: boolean } = {}) {
  // Copy before awaiting browser startup, as the real document API does.
  const files = { ...snapshot.files };
  const assets = Object.fromEntries(Object.entries(snapshot.assets ?? {}).map(([name, bytes]) => [name, Array.from(new Uint8Array(bytes))]));
  const result = await (await browser()).run({ files, assets, timeoutMs: options.timeoutMs, cancelAfter: options.cancelAfter, mutateInputs: options.mutateInputs });
  assert.equal(result.frameCount, 0, 'The broker iframe was removed');
  if (result.error) {
    const { name, phase, message, guestStack } = result.error;
    if (phase) throw new PlaygroundError(phase, message.slice(phase.length + 3), guestStack);
    throw new DOMException(message, name);
  }
  return { glb: Uint8Array.from(result.bytes).buffer, objectCount: result.objectCount };
}

nodeTest('requires a browser document and honors pre-cancellation', async () => {
  const input = { files: { 'main.mjs': 'export function build() {}' } };
  await assert.rejects(buildInDocument(input), { phase: 'runtime' });
  await assert.rejects(buildInDocument(input, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

nodeTest('rejects native static cycles explicitly; dynamic back edges do not form static cycles', () => {
  const files = new Map([['main.mjs', `import './next.mjs'`], ['next.mjs', `export * from './main.mjs'`]]);
  assert.throws(() => compileSnapshot(files, () => 'blob:unit-test'), /Static import cycle: main\.mjs -> next\.mjs -> main\.mjs/);
  files.set('next.mjs', `export async function next() { return import(/* comment */ './main.mjs') }`);
  assert.equal(compileSnapshot(files, () => 'blob:unit-test').urls.size, 2);
});

const run = (source: string, timeoutMs?: number) => buildPlayground({ files: { 'main.mjs': source } }, { timeoutMs });
const diagnostic = (phase: PlaygroundPhase, text: RegExp, guestStack?: RegExp) => (error: unknown) =>
  error instanceof PlaygroundError && error.phase === phase && text.test(error.message) &&
  (!guestStack || guestStack.test(error.guestStack ?? ''));
interface JsonNode { name?: string; extras?: { objectId: string }; matrix?: number[] }
interface SceneJson {
  nodes: JsonNode[];
  materials: { pbrMetallicRoughness: { metallicFactor: number } }[];
  meshes: unknown[];
  extensionsUsed: string[];
}
function json(glb: ArrayBuffer): SceneJson {
  const view = new DataView(glb);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), glb.byteLength);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, view.getUint32(12, true))));
}

test('exports custom indexed geometry, PBR, groups and stable selectable IDs', async () => {
  const source = `export async function build({ THREE, root, random }) {
    if (THREE.REVISION !== '180') throw new Error('wrong engine');
    const group = new THREE.Group();
    group.userData.objectId = 'trio';
    root.position.x = 2;
    root.add(group);
    await Promise.resolve();
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0], 3));
      g.setIndex([0,1,2]);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({color:0x535363, metalness:0.6, roughness:0.4, clearcoat:0.5}));
      mesh.name = '实体 ' + i;
      mesh.userData.objectId = 'entity-' + i;
      mesh.position.x = random();
      group.add(mesh);
    }
  }`;
  const first = await run(source);
  const second = await run(source);
  assert.equal(first.objectCount, 4);
  assert.deepEqual(first.glb, second.glb);
  const scene = json(first.glb);
  assert.equal(scene.materials[0].pbrMetallicRoughness.metallicFactor, 0.6);
  assert.ok(scene.extensionsUsed.includes('KHR_materials_clearcoat'));
  assert.ok(scene.nodes.some(n => n.extras?.objectId === 'entity-2' && n.name === '实体 2'));
  assert.equal(scene.nodes.find(n => n.extras?.objectId === 'trio')?.matrix?.[12], 2);
  assert.equal(scene.meshes.length, 3);
});

test('relative ESM with a dynamic back edge, dynamic imports, top-level await and same-path reloads', async () => {
  const files = {
    'main.mjs': `import { setter } from './sub/part.mjs';
      export const prefix = 'local';
      export async function build({ THREE, root }) {
        const { suffix } = await import('./value.mjs');
        const child = new THREE.Object3D();
        await setter(child, suffix);
        root.add(child);
      }`,
    'sub/part.mjs': `export async function setter(node, suffix) { const { prefix } = await import('../main.mjs'); node.name = prefix + suffix; }`,
    'value.mjs': `export const suffix = await Promise.resolve('-one');`,
  };
  const first = await buildPlayground({ files });
  files['value.mjs'] = `export const suffix = '-two';`;
  const second = await buildPlayground({ files });
  assert.equal(json(first.glb).nodes[0].name, 'local-one');
  assert.equal(json(second.glb).nodes[0].name, 'local-two');
  assert.equal(second.objectCount, 1);
});

test('copies the snapshot before asynchronous build and gives guest fresh asset bytes', async () => {
  const files = { 'main.mjs': `export function build({THREE,root,assets}) {
    const n = new THREE.Object3D();
    const first = assets.read('bytes/data.bin');
    first[0] = 77;
    n.name = String(assets.read('bytes/data.bin')[0]);
    if (assets.has('missing') || !assets.has('bytes/data.bin')) throw new Error('bad asset lookup');
    root.add(n);
  }` };
  const data = Uint8Array.of(42);
  const output = await buildPlayground({ files, assets: { 'bytes/data.bin': data.buffer } }, { mutateInputs: true });
  assert.equal(json(output.glb).nodes[0].name, '42');
  await assert.rejects(buildPlayground({ files, assets: { 'too-big': new ArrayBuffer(1024 * 1024 + 1) } }), diagnostic('snapshot', /1 MiB binary/));
});

test('parses declared JSON in the guest with fresh values and strict UTF-8', async () => {
  const files = { 'main.mjs': `export function build({ THREE, root, assets }) {
    const scene = assets.json('scene.json');
    if (Object.getPrototypeOf(scene) !== Object.prototype) throw new Error('not a guest object');
    scene.name = 'changed';
    assets.read('scene.json').fill(0);
    const node = new THREE.Object3D();
    node.name = assets.json('scene.json').name;
    root.add(node);
  }` };
  const bytes = new TextEncoder().encode('{"name":"中文场景🌏"}');
  const valid = await buildPlayground({ files, assets: { 'scene.json': bytes.buffer } });
  assert.equal(json(valid.glb).nodes[0].name, '中文场景🌏');
  await assert.rejects(buildPlayground({ files }), diagnostic('build', /Unknown snapshot asset/));
  // Without fatal decoding this would be valid JSON containing a replacement character.
  const invalid = Uint8Array.of(0x22, 0xff, 0x22);
  await assert.rejects(buildPlayground({ files, assets: { 'scene.json': invalid.buffer } }), diagnostic('build', /Invalid UTF-8.*scene\.json/));
  const secret = 'private-json-content';
  const malformed = new TextEncoder().encode(`{"name":"${secret}",}`);
  const safeDiagnostic = (pattern: RegExp) => (error: unknown) =>
    diagnostic('build', pattern)(error) && error instanceof PlaygroundError &&
    !`${error.message}\n${error.guestStack}`.includes(secret);
  await assert.rejects(buildPlayground({ files, assets: { 'scene.json': malformed.buffer } }), safeDiagnostic(/Invalid JSON.*scene\.json/));
  for (const arg of [`'${secret}.json'`, `{ toString() { throw new Error('${secret}') } }`]) {
    await assert.rejects(run(`export function build({ assets }) { assets.json(${arg}); }`), safeDiagnostic(/Unknown snapshot asset/));
  }
});

test('opaque worker and inherited CSP prevent network and external code loads', async () => {
  const client = await browser();
  const url = `${client.origin}/sentinel`;
  assert.equal((await run(`export async function build({ THREE, root }) {
    if (self.origin !== 'null' || self.location.protocol !== 'blob:') throw new Error('non-opaque or non-blob worker');
    for (const key of ['Worker','SharedWorker','document','postMessage','process','require','Deno','importScripts']) {
      if (typeof globalThis[key] !== 'undefined') throw new Error(key + ' exposed');
    }
    if (typeof URL.createObjectURL !== 'undefined') throw new Error('blob factory exposed');
    try { await fetch(${JSON.stringify(url + '?fetch')}); throw new Error('network succeeded'); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
    const xhr = new XMLHttpRequest();
    await new Promise((resolve, reject) => {
      xhr.open('GET', ${JSON.stringify(url + '?xhr')});
      xhr.onerror = resolve; xhr.onload = () => reject(new Error('XHR succeeded')); xhr.send();
    });
    try { Function('return 42')(); throw new Error('eval succeeded'); }
    catch (e) { if (!(e instanceof EvalError)) throw e; }
    const node = new THREE.Group(); node.name = '</script><img src="/sentinel?html">'; root.add(node);
  }`)).objectCount, 1);
  assert.equal(client.leaked(), 0);
  await assert.rejects(run(`export function build() { const path = './main.mjs'; return import(path); }`),
    diagnostic('build', /requires a literal relative path/));
  for (const forbidden of ['node:fs', 'https://remote.test/code.mjs', '/tmp/code.mjs', '../main.mjs', '@driver', '@engine', './x%2fm.mjs']) {
    await assert.rejects(run(`export async function build() { await import(${JSON.stringify(forbidden)}); }`), diagnostic('build', /Disallowed import.*main\.mjs/));
  }
});

test('terminates CPU loops, pending promises and cancelled builds; later builds still work', async () => {
  await assert.rejects(run('export function build() { for (;;) {} }', 500), diagnostic('limit', /deadline/));
  await assert.rejects(run('export async function build() { for (;;) await 0; }', 500), diagnostic('limit', /deadline/));
  await assert.rejects(run('export async function build() { await new Promise(() => {}); }', 500), diagnostic('limit', /deadline/));
  await assert.rejects(buildPlayground({ files: { 'main.mjs': 'export function build() { for (;;) {} }' } }, { cancelAfter: 150 }), { name: 'AbortError' });
  assert.equal((await run('export function build() {}')).objectCount, 0);
});

test('preserves syntax, runtime, missing relative module and export diagnostics', async () => {
  await assert.rejects(buildPlayground({ files: {
    'main.mjs': `import { crash } from './sub.mjs'; export async function build() { await 0; crash(); }`,
    'sub.mjs': `export function crash() {\n  const n = 1;\n  throw new Error('the cause ' + n);\n}`,
  } }), diagnostic('build', /the cause 1/, /sub\.mjs:3/));
  await assert.rejects(run('\n\nexport const = 5;'), diagnostic('build', /variable name|unexpected/i));
  await assert.rejects(run(`import './gone.mjs'; export function build() {}`), diagnostic('build', /gone\.mjs.*from main\.mjs/));
  await assert.rejects(run(`export function build({THREE,root}) {
    const a = new THREE.Group(); root.add(a); a.children.push(a);
  }`), diagnostic('export', /cyclic scene/));
  await assert.rejects(run(`export function build({THREE,root}) {
    const a = new THREE.Group(); root.add(a); a.userData.uri = 'https://remote.test/asset.bin';
  }`), diagnostic('validation', /unsupported JSON key: uri/));
  await assert.rejects(run(`export function build({THREE,root}) {
    for (let i=0;i<2;i++) {const n = new THREE.Group(); n.userData.objectId='same'; root.add(n);}
  }`), diagnostic('export', /duplicate userData.objectId/));
});

test('rejects corrupted GLB envelopes and invalid embedded buffer layouts', async () => {
  const { glb } = await run(`export function build({ THREE, root }) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.userData.objectId = 'box';
    root.add(mesh);
  }`);
  const broken = glb.slice(0);
  const view = new DataView(broken);
  view.setUint32(8, glb.byteLength - 4, true);
  assert.throws(() => validateGlb(broken), diagnostic('validation', /invalid GLB 2 header/));
  view.setUint32(8, glb.byteLength, true);
  const jsonChunk = new Uint8Array(broken, 20, view.getUint32(12, true));
  const original = new TextDecoder().decode(jsonChunk);
  const modified = original.replace(/"byteLength":\d+/, match => match.replace(/\d/g, '9'));
  assert.notEqual(modified, original);
  jsonChunk.set(new TextEncoder().encode(modified));
  assert.throws(() => validateGlb(broken), diagnostic('validation', /bufferView outside embedded buffer|invalid embedded buffer/));
});

test('same-name meshes retain explicit identities through reordering and deletion; groups need no ID', async () => {
  const build = async (keys: string[]) => json((await run(`export function build({ THREE, root }) {
    const group = new THREE.Group(); group.name = 'folder'; root.add(group);
    for (const key of ${JSON.stringify(keys)}) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      mesh.name = 'Box';
      mesh.userData.objectId = key;
      mesh.position.x = key === 'left' ? -1 : 1;
      group.add(mesh);
    }
  }`)).glb).nodes;
  for (const order of [['left', 'right'], ['right', 'left'], ['right']]) {
    const nodes = await build(order);
    assert.deepEqual(nodes.filter(n => n.name === 'Box').map(n => n.extras?.objectId), order);
    assert.equal(nodes.find(n => n.name === 'folder')?.extras?.objectId, undefined);
  }
  await assert.rejects(run(`export function build({ THREE, root }) {
    const group = new THREE.Group(); root.add(group);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.name = 'Box'; group.add(mesh);
  }`), diagnostic('export', /root\/0\/0 \("Box"\): missing userData\.objectId; assign an explicit stable ID/));
});

test('exports authored material slots in primitive order, dropping empty groups and ignoring reserved input', async () => {
  const { glb } = await run(`export function build({ THREE, root }) {
    const geometry = new THREE.BoxGeometry(); geometry.clearGroups();
    geometry.addGroup(0, 6, 2); geometry.addGroup(6, 0, 0);
    geometry.addGroup(6, 6, 1); geometry.addGroup(12, 6, 2);
    const material = [0.1, 0.2, 0.3].map(roughness => new THREE.MeshStandardMaterial({ roughness }));
    const multi = new THREE.Mesh(geometry, material);
    multi.userData = { objectId: 'multi', shadowMaterialSlots: [0] };
    const single = new THREE.Mesh(geometry, material[0]);
    single.userData = { objectId: 'single', shadowMaterialSlots: [99] };
    root.add(multi, single);
  }`);
  const view = new DataView(glb);
  const scene = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, view.getUint32(12, true))));
  const [multi, single] = scene.nodes;
  assert.deepEqual(multi.extras, { objectId: 'multi', shadowMaterialSlots: [2, 1, 2] });
  assert.deepEqual(single.extras, { objectId: 'single' });
  assert.deepEqual(scene.meshes[multi.mesh].primitives.map((p: {material: number}) =>
    scene.materials[p.material].pbrMetallicRoughness.roughnessFactor), [0.3, 0.2, 0.3]);
  const chunk = new Uint8Array(glb, 20, view.getUint32(12, true));
  const text = new TextDecoder().decode(chunk);
  chunk.set(new TextEncoder().encode(text.replace('[2,1,2]', '[2,1  ]')));
  assert.throws(() => validateGlb(glb), diagnostic('validation', /one non-negative integer per primitive/));
});

test('rejects authored lights and cameras as non-model nodes', async () => {
  for (const kind of ['DirectionalLight', 'PerspectiveCamera']) {
    await assert.rejects(run(`export function build({ THREE, root }) { root.add(new THREE.${kind}()); }`),
      diagnostic('export', /root\/0: lights and cameras are not model output/));
  }
});
