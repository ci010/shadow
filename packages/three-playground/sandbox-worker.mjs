import { THREE, exportRoot } from './engine.mjs';
import { compileSnapshot } from './snapshot-modules.mjs';

const MAX_GLB_BYTES = 16 * 1024 * 1024;
const createUrl = URL.createObjectURL.bind(URL);
const revokeUrl = URL.revokeObjectURL.bind(URL);
const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const call = Reflect.apply;
const slice = Function.call.bind(String.prototype.slice);
const replaceAll = Function.call.bind(String.prototype.replaceAll);
const parseJson = JSON.parse;
const Bytes = Uint8Array;
const decode = TextDecoder.prototype.decode.bind(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }));
const imul = Math.imul;

// CSP restricts blob loads to this opaque environment. Further keep authored
// code from minting blob URLs or spawning nested workers in this realm.
function hide(target, name) {
  Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false });
}
hide(URL, 'createObjectURL');
hide(URL, 'revokeObjectURL');
for (const name of ['Worker', 'SharedWorker', 'postMessage', 'importScripts']) {
  for (let owner = Object.getPrototypeOf(globalThis); owner; owner = Object.getPrototypeOf(owner)) {
    if (Object.hasOwn(owner, name)) hide(owner, name);
  }
  hide(globalThis, name);
}

addEventListener('message', async ({ data: { files, assets: input, seed }, ports: [port] }) => {
  // The guest never gets access to the port. Capture its send function before
  // evaluation so project code cannot intercept it by changing prototypes.
  const reply = port.postMessage.bind(port);
  const urls = [];
  const makeUrl = source => {
    const url = createUrl(new Blob([source], { type: 'text/javascript' }));
    urls.push(url);
    return url;
  };
  let phase = 'build';
  let moduleNames = [];
  try {
    const { entry, registry, urls: modules } = compileSnapshot(files, makeUrl);
    (await import(registry)).initialize(modules);
    moduleNames = Array.from(modules, ([name, url]) => [url, name]);
    const entries = new Map(Object.entries(input));
    const get = entries.get.bind(entries);
    const has = entries.has.bind(entries);
    const assets = Object.freeze({ has, read(name) {
      const bytes = get(name);
      if (!bytes) throw new Error('Unknown snapshot asset');
      return new Bytes(bytes);
    }, json(name) {
      const bytes = get(name);
      if (!bytes) throw new Error('Unknown snapshot asset');
      if (!/\.json$/i.test(name)) throw new Error('Expected a .json snapshot asset');
      let text;
      try { text = decode(bytes); }
      catch { throw new Error('Invalid UTF-8 in JSON snapshot asset: ' + name); }
      try { return parseJson(text); }
      catch { throw new Error('Invalid JSON in snapshot asset: ' + name); }
    } });
    let state = seed;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let x = imul(state ^ state >>> 15, 1 | state);
      x ^= x + imul(x ^ x >>> 7, 61 | x);
      return ((x ^ x >>> 14) >>> 0) / 4294967296;
    };
    const root = new THREE.Group();
    const main = await import(entry);
    if (typeof main.build !== 'function') throw new Error('main.mjs must export build({ THREE, root, assets, random })');
    await main.build({ THREE, root, assets, random });
    phase = 'export';
    const { glb, previewLights } = await exportRoot(root);
    if (call(byteLength, glb, []) > MAX_GLB_BYTES) reply(['error', 'limit', 'GLB exceeds 16 MiB']);
    else reply(['ok', glb, previewLights], [glb]);
  } catch (error) {
    let message = 'Guest threw a non-Error value';
    let stack;
    try {
      const detail = typeof error === 'string' ? error : error?.message;
      const trace = error?.stack;
      if (typeof detail === 'string') message = slice(detail, 0, 4000);
      if (typeof trace === 'string') {
        stack = slice(trace, 0, 4000);
        for (let i = 0; i < moduleNames.length; i++) {
          const pair = moduleNames[i];
          // Callback replacement treats '$' and similar text as literal.
          stack = replaceAll(stack, pair[0], () => pair[1]);
        }
        stack = slice(stack, 0, 4000);
      }
    } catch { /* Do not forward arbitrary guest objects. */ }
    reply(['error', phase, message, stack]);
  } finally {
    for (let i = 0; i < urls.length; i++) revokeUrl(urls[i]);
  }
}, { once: true });
