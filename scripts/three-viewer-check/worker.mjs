import { apiBase, marker, sessionId } from './constants.mjs';
import { fetchPlaygroundSnapshot, exportSnapshot } from '../../app/src/three-playground-client.ts';
import './browser.mjs';

// Standalone diagnostic for the real app Worker and WASM, without Vue.
window.runThreeWorkerCheck = async () => {
  const url = new URL(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/workspace/three-snapshot`, location.href);
  url.searchParams.set('path', marker);
  const signal = AbortSignal.timeout(20000);
  const { snapshot, tag } = await fetchPlaygroundSnapshot(url, '', signal);
  if (await fetchPlaygroundSnapshot(url, tag, signal) !== null) throw new Error('Unchanged synthetic snapshot did not return 304');
  const bytes = await exportSnapshot(snapshot, signal);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  link.download = 'cube-stand.glb';
  link.click();
  return { snapshot: snapshot.version, shaders: snapshot.shaders.length };
};
