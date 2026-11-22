import { ThreeViewer } from '@shadow/three-viewer';
import { buildPreviewSnapshot, fetchPlaygroundSnapshot } from '../../app/src/three-playground-client.ts';

window.runThreeMarkerCheck = expectedShaders => renderMarker({ expectedShaders });
window.runThreeCapture = camera => renderMarker({ camera });

async function renderMarker({ expectedShaders, camera: requestedCamera }) {
  const url = new URL('/__three-marker', location.href);
  url.searchParams.set('path', new URL(location.href).searchParams.get('marker'));
  const signal = AbortSignal.timeout(20_000);
  const { snapshot, tag } = await fetchPlaygroundSnapshot(url, '', signal);
  if (!requestedCamera) {
    if (await fetchPlaygroundSnapshot(url, tag, signal) !== null) throw new Error('Expected HTTP 304');
    if (snapshot.shaders.length !== expectedShaders) throw new Error(`Expected ${expectedShaders} shaders, got ${snapshot.shaders.length}`);
  }
  const { glb: bytes, previewLights, version } = await buildPreviewSnapshot(snapshot, signal);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:960px;height:680px';
  document.querySelector('#app').append(canvas);
  const viewer = new ThreeViewer(canvas);
  try {
    // load() links every shader override on the real WebGL renderer before committing.
    await viewer.load({ bytes, previewLights, shaders: snapshot.shaders, preview: snapshot.preview, version: version, identity: 'playground' });
    if (requestedCamera) {
      const frame = await viewer.captureFrame(requestedCamera);
      if (frame.version !== version) throw new Error('Capture version drift');
      const png = new Uint8Array(await frame.image.arrayBuffer());
      return { version: frame.version, camera: frame.camera, pngBytes: png.byteLength, png: png.toBase64() };
    }
    if (!viewer.objectIds.length) throw new Error('No exported objects');
    const camera = viewer.getCamera('front');
    const frames = [];
    let png;
    for (let i = 0; i < 2; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 300));
      const frame = await viewer.captureFrame(camera);
      if (JSON.stringify(frame.camera) !== JSON.stringify(camera) || frame.version !== version) throw new Error('Capture camera or version drift');
      const pngBytes = await frame.image.arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pngBytes)).toHex();
      frames.push({ bytes: pngBytes.byteLength, hash });
      if (i === 1) png = new Uint8Array(pngBytes).toBase64();
    }
    if (expectedShaders && frames[0].hash === frames[1].hash) throw new Error('Animated frames did not change');
    return { version: version, assets: Object.keys(snapshot.assets), shaders: expectedShaders, objects: viewer.objectIds.length, glbBytes: bytes.byteLength, camera, frames, png };
  } finally { viewer.dispose(); }
}
