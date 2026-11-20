import { ThreeViewer, type ModelInput } from '../src/index.js';
import { fixture, glb } from './fixture.js';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

async function multiMaterialGlb(annotate: boolean): Promise<ArrayBuffer> {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-3,-1,0, -1,-1,0, -2,1,0, 1,-1,0, 3,-1,0, 2,1,0], 3));
  geometry.setIndex([3,4,5, 0,1,2]);
  geometry.addGroup(0, 3, 1); geometry.addGroup(3, 3, 0);
  const materials = [new MeshBasicMaterial({ color: 0x0000ff }), new MeshBasicMaterial({ color: 0x00ff00 })];
  const mesh = new Mesh(geometry, materials); mesh.userData.objectId = 'two-materials';
  if (annotate) mesh.userData.shadowMaterialSlots = geometry.groups.map(group => group.materialIndex);
  const scene = new Scene(); scene.add(mesh);
  try { return await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer; }
  finally { geometry.dispose(); materials.forEach(m => m.dispose()); }
}

async function colors(blob: Blob) {
  const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0); bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const counts = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) if (data[i+c] > 245 && data[i+(c+1)%3] < 10 && data[i+(c+2)%3] < 10) counts[c]++;
  }
  return counts.map(count => count > 100);
}

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  try { await promise; } catch (error) { if (pattern.test(String(error))) return; throw error; }
  throw new Error(`expected rejection ${pattern}`);
}

async function run() {
  const canvas = document.querySelector('canvas')!;
  const removed: string[][] = [], modes: boolean[] = [];
  const viewer = new ThreeViewer(canvas, { background: '#778899', onSelectionChange: event => removed.push([...event.removed]), onPlayerModeChange: e => modes.push(e) });
  const model = (version: string, ids?: string[]): ModelInput => ({ version, bytes: glb(ids), identity: 'playground', identityScope: 'test' });
  const vertex = 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const fragment = 'void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }';
  try {
    equal(viewer.outline, []);
    equal((await viewer.load(model('1'))).objectIds, ['left', 'right']);
    const originalOutline = viewer.outline;
    equal(originalOutline, [
      { key: 'node:0', parentKey: null, label: 'Triangle 1', objectId: 'left' },
      { key: 'node:1', parentKey: null, label: 'Triangle 2', objectId: 'right' },
    ]);
    equal(viewer.labelFor('left'), 'Triangle 1');
    const groundCanvas = canvas.cloneNode() as HTMLCanvasElement;
    groundCanvas.width = canvas.width; groundCanvas.height = canvas.height;
    const withGround = new ThreeViewer(groundCanvas, { ground: true, background: '#778899', instructions: 'Localized controls' });
    try {
      equal(groundCanvas.getAttribute('aria-description'), 'Localized controls');
      equal((await withGround.load(model('1'))).objectIds, viewer.objectIds);
      equal(withGround.getCamera('top'), viewer.getCamera('top'));
      const a = new Uint8Array(await (await withGround.capture('top')).arrayBuffer());
      const b = new Uint8Array(await (await viewer.capture('top')).arrayBuffer());
      if (a.length === b.length && a.every((byte, i) => byte === b[i])) throw new Error('Expected the preview grid to appear');
    } finally { withGround.dispose(); }
    viewer.setView('front'); viewer.setSelection(['right']);
    const pose = viewer.getCamera();
    await rejects(viewer.load(model('duplicate', ['left', 'left'])), /unique/);
    await rejects(viewer.load({ ...model('missing'), shaders: [{ objectId: 'absent', slot: 0, vertex, fragment }] }), /Unknown objectId/);
    await rejects(viewer.load({ ...model('invalid'), shaders: [{ objectId: 'left', slot: 0, vertex, fragment: 'invalid shader' }] }), /Shader left\[0\]/);
    equal(viewer.getCamera(), pose); equal(viewer.selection, ['right']);
    if (viewer.outline !== originalOutline) throw new Error('Rejected load changed the outline');
    const established = await viewer.captureFrame();
    equal(established.version, '1'); equal(established.objectIds, ['right']);
    const pending = viewer.load(model('old'));
    const newer = viewer.load({ ...model('2', ['right']), shaders: [{ objectId: 'right', slot: 0, vertex, fragment }] });
    await rejects(pending, /AbortError/); await newer;
    const shaded = await createImageBitmap(await viewer.capture('front'));
    const shaderProbe = document.createElement('canvas'); shaderProbe.width = shaded.width; shaderProbe.height = shaded.height;
    const shaderCtx = shaderProbe.getContext('2d')!;
    shaderCtx.drawImage(shaded, 0, 0); shaded.close();
    equal([...shaderCtx.getImageData(shaderProbe.width / 2, shaderProbe.height / 2, 1, 1).data], [255, 0, 0, 255]);
    const originalToBlob = canvas.toBlob;
    canvas.toBlob = () => { throw new Error('Independent inspection touched the user canvas'); };
    const inspected = viewer.captureFrame('top');
    canvas.toBlob = originalToBlob;
    equal(viewer.getCamera(), pose); equal(viewer.selection, ['right']);
    const next = viewer.load(model('3', ['left']));
    const shot = await inspected;
    equal(shot.image.type, 'image/png'); equal(shot.version, '2'); equal(shot.objectIds, ['right']);
    const pixels = await createImageBitmap(shot.image); equal(pixels.width, canvas.width);
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.drawImage(pixels, 0, 0); pixels.close();
    equal([...probe.getImageData(0, 0, 1, 1).data], [119, 136, 153, 255]);
    await next; equal(viewer.selection, []); equal(removed.at(-1), ['right']);
    const aborted = new AbortController();
    const inFlight = viewer.load({ ...model('aborted'), signal: aborted.signal });
    aborted.abort(); await rejects(inFlight, /AbortError/);
    equal((await viewer.captureFrame()).version, '3');
    const { json, data } = fixture();
    const dimensions = [canvas.width, canvas.height];
    canvas.style.display = 'none';
    const hidden = await createImageBitmap(await viewer.capture());
    equal([hidden.width, hidden.height], dimensions); equal(viewer.getCamera(), pose); hidden.close();
    canvas.style.display = '';
    const pngCanvas = document.createElement('canvas'); pngCanvas.width = pngCanvas.height = 1;
    const pngCtx = pngCanvas.getContext('2d')!; pngCtx.fillStyle = '#0000ff'; pngCtx.fillRect(0, 0, 1, 1);
    const png = Uint8Array.from(atob(pngCanvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    const uv = new Uint8Array(new Float32Array([0, 0, 1, 0, 0.5, 1]).buffer);
    const meshBytes = new Uint8Array(data.length + uv.length); meshBytes.set(data); meshBytes.set(uv, data.length);
    const external = {
      ...json, images: [{ uri: 'texture.png' }], textures: [{ source: 0 }],
      buffers: [{ byteLength: meshBytes.length, uri: 'mesh.bin' }],
      bufferViews: [...json.bufferViews, { buffer: 0, byteLength: uv.length, byteOffset: data.length }],
      accessors: [...json.accessors, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
      meshes: [{ primitives: [{ material: 0, attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
      extensionsUsed: ['KHR_materials_unlit', 'KHR_texture_transform'],
      materials: [{ extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorTexture: {
        index: 0, extensions: { KHR_texture_transform: { offset: [0.2, 0.2] } },
      } } }],
    };
    const imported = { version: 'gltf', bytes: new TextEncoder().encode(JSON.stringify(external)), resources: new Map([['mesh.bin', meshBytes], ['texture.png', png]]) };
    const result = await viewer.load(imported);
    equal(await colors(await viewer.capture('front')), [false, false, true]);
    if (!result.objectIds[0].endsWith(':0:0') || !result.objectIds[1].endsWith(':1:0')) throw new Error('ordinary mesh instance identity');
    viewer.setSelection(result.objectIds);
    const reopened = await viewer.load(imported);
    equal(reopened.objectIds, result.objectIds); equal(viewer.selection, result.objectIds);
    const replacement = await viewer.load({ ...imported, version: 'updated' });
    if (replacement.objectIds.some(id => result.objectIds.includes(id))) throw new Error('ordinary identity reused across revisions');
    equal(viewer.selection, []);
    const bindings = [{ objectId: 'two-materials', slot: 1, vertex, fragment }];
    const multi = { ...model('multi'), bytes: await multiMaterialGlb(true), shaders: bindings };
    equal((await viewer.load(multi)).objectIds, ['two-materials']);
    equal(await colors(await viewer.capture('front')), [true, false, true]);
    viewer.bindShader('two-materials', 1, null);
    equal(await colors(await viewer.capture('front')), [false, true, true]);
    const unannotated = { ...multi, version: 'unannotated', bytes: await multiMaterialGlb(false) };
    await rejects(viewer.load(unannotated), /Missing shadowMaterialSlots/);
    equal((await viewer.captureFrame()).version, 'multi');
    equal((await viewer.load({ ...unannotated, shaders: undefined })).objectIds, ['two-materials']);
    equal(viewer.outline, [{ key: 'node:0', parentKey: null, label: 'two-materials', objectId: 'two-materials' }]);
    const { json: rain, data: rainMesh } = fixture(['rain']);
    const rainModel: ModelInput = {
      ...model('rain'), resources: new Map([['mesh.bin', rainMesh]]),
      bytes: new TextEncoder().encode(JSON.stringify({ ...rain,
        meshes: [{ primitives: [{ ...rain.meshes[0].primitives[0], material: 0 }] }],
        materials: [{ doubleSided: true, alphaMode: 'BLEND',
          pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 0.5], metallicFactor: 0, roughnessFactor: 1 } }],
      })),
    };
    const animated = { ...rainModel, shaders: [{ objectId: 'rain', slot: 0,
      vertex: `uniform float playgroundTime;
        void main() {
          vec3 p = position;
          p.x += 0.05 * sin(playgroundTime);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragment: `uniform float playgroundTime;
        uniform float playgroundOpacity;
        void main() {
          float moved = float(playgroundTime > 0.0);
          gl_FragColor = vec4(1.0 - moved, moved, 0.0, playgroundOpacity);
        }`,
    }] };
    // View the back face: only the authored double-sided, blended state shows the shader here.
    const fixed = { position: [0, 0, -4], target: [0, 0, 0] } as const;
    const center = async (blob: Blob) => {
      const image = await createImageBitmap(blob);
      shaderCtx.drawImage(image, 0, 0); image.close();
      return [...shaderCtx.getImageData(shaderProbe.width / 2, shaderProbe.height / 2, 1, 1).data];
    };
    const twoFrames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await viewer.load(rainModel);
    const staticPixel = await center(await viewer.capture(fixed));
    await viewer.load(animated);
    const first = await viewer.captureFrame(fixed);
    const before = await center(first.image);
    await twoFrames();
    const later = await viewer.captureFrame(fixed);
    const after = await center(later.image);
    equal(later.camera, first.camera);
    if (!(before[0] > before[1] && before[0] < 250 && after[1] > after[0] && after[1] < 250)) {
      throw new Error(`expected blended back-face animation: ${before} -> ${after}`);
    }
    await rejects(viewer.load({ ...animated, shaders: [{ ...animated.shaders[0], fragment: 'invalid shader' }] }), /Shader rain/);
    equal(await center(await viewer.capture(fixed)), after);
    await viewer.load(animated);
    equal(await center(await viewer.capture(fixed)), before);
    viewer.bindShader('rain', 0, null);
    await twoFrames();
    equal(await center(await viewer.capture(fixed)), staticPixel);
    await viewer.load(rainModel);
    equal(await center(await viewer.capture(fixed)), staticPixel);
    const { json: tree, data: treeMesh } = fixture([undefined, undefined]);
    const treeResult = await viewer.load({ version: 'tree', resources: new Map([['mesh.bin', treeMesh]]),
      bytes: new TextEncoder().encode(JSON.stringify({ ...tree, scenes: [{ nodes: [2] }, { nodes: [3] }],
        nodes: [...tree.nodes, { name: 'Group', children: [0, 1] }, { name: 'Inactive' }],
        meshes: [{ primitives: [...tree.meshes[0].primitives, ...tree.meshes[0].primitives] }],
      })),
    });
    equal(viewer.outline.map(({ key, parentKey, objectId }) => [key, parentKey, objectId]), [
      ['node:2', null, undefined],
      ['node:0', 'node:2', undefined],
      ['node:0/primitive:0', 'node:0', treeResult.objectIds[0]],
      ['node:0/primitive:1', 'node:0', treeResult.objectIds[1]],
      ['node:1', 'node:2', undefined],
      ['node:1/primitive:0', 'node:1', treeResult.objectIds[2]],
      ['node:1/primitive:1', 'node:1', treeResult.objectIds[3]],
    ]);
    viewer.setSelection([treeResult.objectIds[3]]);
    equal(viewer.selection, [treeResult.objectIds[3]]);
    viewer.setPlayerMode(true); canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    equal(modes, [true, false]);
  } finally { viewer.dispose(); }
}

run().then(() => { document.body.dataset.result = 'passed'; }, error => {
  document.body.dataset.result = 'failed';
  document.querySelector('pre')!.textContent = String(error.stack ?? error);
});
