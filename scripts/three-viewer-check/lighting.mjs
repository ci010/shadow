import { Color, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeViewer } from '@shadow/three-viewer';
import { fetchPlaygroundSnapshot, exportSnapshot } from '../../app/src/three-playground-client.ts';

const extension = 'KHR_lights_punctual';
const expected = {
  point: { name: 'Amber display bulb', position: [-.94, 1.48, -.04], color: 0xff9f58, intensity: 2.4, range: 2.3 },
  spot: { name: 'Blue window spotlight', position: [1.02, 1.76, .23], target: [.66, .72, -.47], color: 0x8dbbff, intensity: 8, range: 3.2 },
  directional: { name: 'Cool street fill', position: [-2, 3, 4], target: [0, .65, 0], color: 0xb6cbff, intensity: .42 },
};
const ids = ['store.base', 'store.back', 'store.sill', 'store.pot.tall', 'store.awning.0'];
function check(condition, message) { if (!condition) throw new Error(message); }
const near = (a, b) => Math.abs(a - b) < 1e-5;

function glbEditor(bytes) {
  const source = new Uint8Array(bytes);
  const view = new DataView(source.buffer);
  const jsonLength = view.getUint32(12, true);
  check(view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2 &&
    view.getUint32(16, true) === 0x4e4f534a, 'Expected GLB v2 with a JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(source.subarray(20, 20 + jsonLength)));
  const tail = source.subarray(20 + jsonLength);
  return { json, variant(edit) {
    const copy = structuredClone(json);
    edit(copy);
    const data = new TextEncoder().encode(JSON.stringify(copy));
    const padded = Math.ceil(data.length / 4) * 4;
    const output = new Uint8Array(20 + padded + tail.length);
    output.set(source.subarray(0, 20));
    const header = new DataView(output.buffer);
    header.setUint32(8, output.length, true);
    header.setUint32(12, padded, true);
    output.fill(0x20, 20, 20 + padded);
    output.set(data, 20);
    output.set(tail, 20 + padded);
    return output.buffer;
  } };
}

async function pixels(blob) {
  const image = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, image.width, image.height).data;
  } finally { image.close(); }
}

window.runThreeLightingCheck = async () => {
  const url = new URL('/__three-marker', location.href);
  url.searchParams.set('path', new URL(location.href).searchParams.get('marker'));
  const signal = AbortSignal.timeout(20_000);
  const { snapshot, tag } = await fetchPlaygroundSnapshot(url, '', signal);
  url.searchParams.set('comparison', '1');
  const neutral = await fetchPlaygroundSnapshot(url, tag, signal);
  check(neutral && neutral.snapshot.version !== snapshot.version && neutral.tag !== tag, 'Preview-only edit must invalidate the snapshot version and ETag');
  check(snapshot.preview?.toneMapping === 'aces' && near(snapshot.preview.exposure, 1.16) &&
    neutral.snapshot.preview?.toneMapping === 'none' && neutral.snapshot.preview.exposure === 1, 'Preview settings did not survive the snapshot/client boundary');
  const bytes = await exportSnapshot(snapshot, signal);
  const neutralBytes = await exportSnapshot(neutral.snapshot, signal);
  const acesGlb = new Uint8Array(bytes), neutralGlb = new Uint8Array(neutralBytes);
  check(acesGlb.length === neutralGlb.length && acesGlb.every((value, i) => value === neutralGlb[i]), 'Preview-only changes must not affect exported GLB bytes');
  const { json, variant } = glbEditor(bytes);
  const definitions = json.extensions?.[extension]?.lights;
  check(json.extensionsUsed?.includes(extension) && definitions?.length === 3, 'Expected three KHR_lights_punctual definitions');
  const refs = json.nodes.flatMap(node => node.extensions?.[extension] ? [node.extensions[extension].light] : []);
  check(refs.sort().join(',') === '0,1,2', 'Expected one node binding per light');

  const { scene } = await new GLTFLoader().parseAsync(bytes, '');
  scene.updateMatrixWorld(true);
  const imported = new Map(), importedIds = new Set();
  scene.traverse(node => {
    if (node.isLight) imported.set(node.isPointLight ? 'point' : node.isSpotLight ? 'spot' : node.isDirectionalLight ? 'directional' : node.type, node);
    if (node.isMesh) importedIds.add(node.userData.objectId);
  });
  check(imported.size === 3 && ids.every(id => importedIds.has(id)), 'Imported lights or storefront mesh IDs missing');
  for (const [type, spec] of Object.entries(expected)) {
    const def = definitions.find(light => light.type === type);
    const light = imported.get(type);
    check(def && light && near(def.intensity, spec.intensity) && near(light.intensity, spec.intensity), `${type}: incorrect type or intensity`);
    check(new Color(spec.color).toArray().every((channel, i) => near(channel, def.color?.[i]) && near(channel, light.color.toArray()[i])), `${type}: incorrect color readback`);
    const origin = light.getWorldPosition(new Vector3());
    check(origin.distanceTo(new Vector3(...spec.position)) < 1e-5, `${type}: incorrect origin`);
    if (spec.range) check(near(def.range, spec.range) && near(light.distance, spec.range) && light.decay === 2, `${type}: incorrect range or decay`);
    if (type === 'spot') check(near(light.angle, .37) && near(light.penumbra, .4), 'Incorrect spotlight cone');
    if (spec.target) {
      const aim = new Vector3(...spec.target).sub(origin).normalize();
      const axis = new Vector3(0, 0, -1).transformDirection(light.matrixWorld);
      const target = light.target.getWorldPosition(new Vector3()).sub(origin).normalize();
      check(aim.dot(axis) > .99999 && aim.dot(target) > .99999, `${type}: local -Z or imported target does not aim at the storefront`);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:960px;height:680px';
  document.querySelector('#app').append(canvas);
  const viewer = new ThreeViewer(canvas);
  try {
    let camera;
    async function frame(data, label, preview = snapshot.preview) {
      await viewer.load({ bytes: data, version: label, identity: 'playground', preview });
      check(ids.every(id => viewer.objectIds.includes(id)), `${label}: viewer lost storefront objects`);
      camera ??= viewer.getCamera('front');
      const capture = await viewer.captureFrame(camera);
      check(capture.version === label && JSON.stringify(capture.camera) === JSON.stringify(camera), `${label}: capture camera or version drift`);
      return pixels(capture.image);
    }
    const authored = await frame(bytes, snapshot.version);
    const neutralFrame = await frame(neutralBytes, neutral.snapshot.version, neutral.snapshot.preview);
    const unitExposure = await frame(bytes, 'aces-unit-exposure', { ...snapshot.preview, exposure: 1 });
    const dark = await frame(variant(copy => {
      for (const light of copy.extensions[extension].lights) light.intensity = 0;
    }), 'zero-intensity');
    const fallback = await frame(variant(copy => {
      delete copy.extensions[extension];
      copy.extensionsUsed = copy.extensionsUsed.filter(name => name !== extension);
      if (copy.extensionsRequired) copy.extensionsRequired = copy.extensionsRequired.filter(name => name !== extension);
      for (const node of copy.nodes) if (node.extensions) delete node.extensions[extension];
    }), 'no-authored-lights');
    const rgb = (image, i) => (image[i] + image[i + 1] + image[i + 2]) / 3;
    const changed = (a, b, delta) => {
      check(a.length === b.length, 'Capture dimensions changed');
      let count = 0;
      for (let i = 0; i < a.length; i += 4) if (rgb(a, i) - rgb(b, i) > delta) count++;
      return count;
    };
    const toneMappedPixels = changed(unitExposure, neutralFrame, 8) + changed(neutralFrame, unitExposure, 8);
    const exposurePixels = changed(authored, unitExposure, 5);
    check(toneMappedPixels > 1_000 && exposurePixels > 1_000, `Preview tone mapping or exposure had no substantial pixel effect (${toneMappedPixels}, ${exposurePixels})`);
    const darkGeometry = changed(fallback, dark, 25);
    let black = 0;
    for (let i = 0; i < dark.length; i += 4) if (rgb(dark, i) < 10 && rgb(fallback, i) > 35) black++;
    check(black > 5_000, `Zero-intensity authored geometry should be black where the no-lights control is lit (${black} pixels)`);
    const contributions = {};
    for (const type of Object.keys(expected)) {
      const muted = await frame(variant(copy => {
        copy.extensions[extension].lights.find(light => light.type === type).intensity = 0;
      }), `muted-${type}`);
      contributions[type] = changed(authored, muted, 8);
      check(contributions[type] > 200, `${type}: authored light made no substantial pixel contribution (${contributions[type]})`);
    }
    return { glbBytes: bytes.byteLength, importedLights: [...imported.keys()], objects: viewer.objectIds.length, darkGeometry, black, contributions, toneMappedPixels, exposurePixels, previewVersions: [snapshot.version, neutral.snapshot.version] };
  } finally { viewer.dispose(); }
};
