import { snapshotPreviewLights, type PreviewLight } from '../three-viewer/src/preview-lights.ts';
import { brokerDocument } from './broker.ts';
import workerSource from './generated/worker-source.js';
import { validateGlb, MAX_GLB_BYTES } from './validate.ts';
import { PlaygroundError, type PlaygroundPhase } from './errors.ts';
export { PlaygroundError, type PlaygroundPhase } from './errors.ts';

export interface PlaygroundSnapshot {
  readonly files: Readonly<Record<string, string>>;
  readonly assets?: Readonly<Record<string, ArrayBuffer>>;
}
export interface PlaygroundOptions { readonly signal?: AbortSignal; readonly seed?: number; readonly timeoutMs?: number }
export interface PlaygroundResult { readonly glb: ArrayBuffer; readonly objectCount: number; readonly previewLights: readonly PreviewLight[] }

const ENTRY = 'main.mjs';
const MiB = 1024 * 1024;
const encoder = new TextEncoder();
function pathValid(name: string) {
  return name.length <= 240 && name.split('/').every(part =>
    /^[\p{L}\p{N}_. -]+$/u.test(part) && part !== '.' && part !== '..');
}
function snapshotCopy(snapshot: PlaygroundSnapshot) {
  const files = new Map<string, string>();
  const assets: Record<string, Uint8Array> = Object.create(null);
  let size = 0;
  for (const [name, text] of Object.entries(snapshot.files)) {
    if (!pathValid(name) || !/\.m?js$/.test(name) || typeof text !== 'string') {
      throw new PlaygroundError('snapshot', `Invalid JavaScript snapshot file: ${name}`);
    }
    if (files.size >= 128 || text.length > MiB || (size += encoder.encode(text).length) > MiB) {
      throw new PlaygroundError('snapshot', 'Snapshot exceeds 128 modules or 1 MiB source');
    }
    files.set(name, text);
  }
  if (!files.has(ENTRY)) throw new PlaygroundError('snapshot', `Missing ${ENTRY}`);
  size = 0;
  let count = 0;
  for (const [name, bytes] of Object.entries(snapshot.assets ?? {})) {
    if (!pathValid(name) || !(bytes instanceof ArrayBuffer)) {
      throw new PlaygroundError('snapshot', `Invalid binary snapshot asset: ${name}`);
    }
    if (++count > 64 || (size += bytes.byteLength) > MiB) {
      throw new PlaygroundError('snapshot', 'Snapshot exceeds 64 assets or 1 MiB binary assets');
    }
    assets[name] = new Uint8Array(bytes.slice(0));
  }
  return { files, assets };
}
/** Build from a trusted browser document. Project code never runs in this realm. */
export async function buildPlayground(snapshot: PlaygroundSnapshot, options: PlaygroundOptions = {}): Promise<PlaygroundResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const started = performance.now();
  const { files, assets } = snapshotCopy(snapshot);
  const seed = options.seed ?? 1;
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(timeout) || timeout < 1 || timeout > 10000) {
    throw new PlaygroundError('snapshot', 'Expected a uint32 seed and timeoutMs between 1 and 10000');
  }
  if (typeof document === 'undefined' || !document.documentElement) {
    throw new PlaygroundError('runtime', 'The playground requires a trusted browser document');
  }

  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    const { port1, port2 } = new MessageChannel();
    const expired = () => performance.now() - started >= timeout;
    const deadline = () => new PlaygroundError('limit', 'Playground execution deadline exceeded');
    const timer = setTimeout(() => fail(deadline()), Math.max(0, timeout - (performance.now() - started)));
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      port1.close();
      port2.close();
      frame.onload = null;
      // Discarding the broker document also discards its dedicated worker.
      frame.remove();
    }
    function fail(error: unknown) { cleanup(); reject(error); }
    function abort() { fail(signal?.reason); }
    signal?.addEventListener('abort', abort, { once: true });
    port1.onmessageerror = () => fail(new PlaygroundError('runtime', 'Invalid broker response'));
    port1.onmessage = ({ data }) => {
      if (expired()) return fail(deadline());
      cleanup();
      try {
        if (data?.[0] === 'error') {
          const [, phase, message, stack] = data;
          throw new PlaygroundError(phase as PlaygroundPhase, message, stack);
        }
        const glb = data?.[1];
        if (data?.[0] !== 'ok' || !(glb instanceof ArrayBuffer)) {
          throw new PlaygroundError('runtime', 'Invalid broker response');
        }
        if (glb.byteLength > MAX_GLB_BYTES) throw new PlaygroundError('limit', 'GLB exceeds 16 MiB');
        const objectCount = validateGlb(glb);
        let previewLights: readonly PreviewLight[];
        try { previewLights = snapshotPreviewLights(data[2]); }
        catch (error) { throw new PlaygroundError('validation', (error as Error).message); }
        if (expired()) throw deadline();
        resolve({ glb, objectCount, previewLights });
      } catch (error) { reject(error); }
    };
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.hidden = true;
    frame.onload = () => {
      frame.onload = null;
      try {
        if (expired()) return fail(deadline());
        // Opaque origins require '*'; the destination is this exact WindowProxy.
        frame.contentWindow!.postMessage({ workerSource, files, assets, seed, timeout }, '*', [port2]);
      } catch (error) { fail(error); }
    };
    try {
      frame.srcdoc = brokerDocument();
      document.documentElement.append(frame);
    } catch (error) { fail(error); }
  });
}
