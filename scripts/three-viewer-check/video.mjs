import { ThreeViewer } from '@shadow/three-viewer';
import { buildPreviewSnapshot, fetchPlaygroundSnapshot } from '../../app/src/three-playground-client.ts';
let viewer, version, camera, next = 0, fps;
window.startThreeVideo = async config => {
  const url = new URL('/__three-marker', location.href);
  url.searchParams.set('path', new URL(location.href).searchParams.get('marker'));
  const signal = AbortSignal.timeout(config.timeout * 1000);
  const { snapshot } = await fetchPlaygroundSnapshot(url, '', signal);
  const build = await buildPreviewSnapshot(snapshot, signal);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `display:block;width:${config.width}px;height:${config.height}px`;
  document.querySelector('#app').append(canvas);
  viewer = new ThreeViewer(canvas, { ground: false });
  await viewer.load({ bytes: build.glb, previewLights: build.previewLights, shaders: snapshot.shaders, preview: snapshot.preview, version: build.version, identity: 'playground' });
  version = build.version; camera = { position: config.position, target: config.target }; fps = config.fps;
  return { version, camera: viewer.getCamera(camera), preview: snapshot.preview ?? { toneMapping: 'none', exposure: 1 } };
};
window.nextThreeVideoFrame = async index => {
  if (index !== next++) throw new Error('Out of order video frame');
  const frame = await viewer.captureVideoFrame(camera, index / fps);
  if (frame.version !== version) throw new Error('Video version drift');
  return new Uint8Array(await frame.image.arrayBuffer()).toBase64();
};
window.stopThreeVideo = () => { viewer?.dispose(); viewer = null; };
