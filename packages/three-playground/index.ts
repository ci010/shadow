import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSHandle } from 'quickjs-emscripten';
import engine from './generated/engine-source.js';
import { validateGlb, MAX_GLB_BYTES } from './validate.ts';
import { PlaygroundError, type PlaygroundPhase } from './errors.ts';
export { PlaygroundError, type PlaygroundPhase } from './errors.ts';

export interface PlaygroundSnapshot {
  readonly files: Readonly<Record<string, string>>;
  readonly assets?: Readonly<Record<string, ArrayBuffer>>;
}
export interface PlaygroundOptions { readonly seed?: number; readonly timeoutMs?: number }
export interface PlaygroundResult { readonly glb: ArrayBuffer; readonly objectCount: number }

const ENTRY = 'main.mjs';
const ENGINE = '@engine';
const DRIVER = '@driver';
const BOOT = '@boot';
const MiB = 1024 * 1024;
const encoder = new TextEncoder();
function pathValid(name: string) {
  return name.length <= 240 && name.split('/').every(part =>
    /^[\p{L}\p{N}_. -]+$/u.test(part) && part !== '.' && part !== '..');
}
function snapshotCopy(snapshot: PlaygroundSnapshot) {
  const files = new Map<string, string>();
  const assets: Record<string, number[]> = Object.create(null);
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
    assets[name] = Array.from(new Uint8Array(bytes));
  }
  return { files, assets };
}
function resolveLocal(base: string, request: string) {
  if (request.length > 240 || (!request.startsWith('./') && !request.startsWith('../'))) return;
  const path = base.split('/').slice(0, -1);
  for (const segment of request.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (!path.length) return;
      path.pop();
    } else {
      if (!pathValid(segment)) return;
      path.push(segment);
    }
  }
  const name = path.join('/');
  if (pathValid(name) && /\.m?js$/.test(name)) return name;
}

/** Run in a dedicated Worker. The caller must enforce an external termination deadline. */
export async function buildPlayground(snapshot: PlaygroundSnapshot, options: PlaygroundOptions = {}): Promise<PlaygroundResult> {
  const { files, assets } = snapshotCopy(snapshot);
  const seed = options.seed ?? 1;
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(timeout) || timeout < 1 || timeout > 10000) {
    throw new PlaygroundError('snapshot', 'Expected a uint32 seed and timeoutMs between 1 and 10000');
  }
  // There are no JS host callbacks installed in the guest. Module resolution
  // returns only pre-copied strings; no filesystem, network, or native import.
  // A WASM trap (including failures during QuickJS teardown after OOM) must
  // never poison a subsequent invocation, so do not use the shared singleton.
  const wasm = await newQuickJSWASMModule(RELEASE_SYNC).catch(() => {
    throw new PlaygroundError('runtime', 'Unable to initialize QuickJS WASM');
  });
  const deadline = performance.now() + timeout;
  let interrupted = false;
  let phase: PlaygroundPhase = 'runtime';
  const vm = wasm.newRuntime();
  let context: ReturnType<typeof vm.newContext> | undefined;
  let failed = false;
  try {
    vm.setMemoryLimit(96 * MiB);
    vm.setMaxStackSize(64 * 1024);
    const expired = () => interrupted ||= performance.now() >= deadline;
    vm.setInterruptHandler(expired);
    const ctx = context = vm.newContext();
    const limitError = () => new PlaygroundError('limit', 'QuickJS execution deadline exceeded');
    const guestError = (error: QuickJSHandle): PlaygroundError => {
      try {
        if (expired()) return limitError();
        // Extract only strings, never dump arbitrary guest objects into the host.
        const field = (name: string) => {
          const handle = ctx.getProp(error, name);
          try { return ctx.typeof(handle) === 'string' ? ctx.getString(handle).slice(0, 4000) : ''; }
          finally { handle.dispose(); }
        };
        const message = (ctx.typeof(error) === 'string' ? ctx.getString(error).slice(0, 4000) : field('message')) || 'Guest threw a non-Error value';
        const stack = field('stack');
        return expired() ? limitError() : new PlaygroundError(phase, message, stack || undefined);
      } finally { error.dispose(); }
    };
    const driver = `import { THREE, exportRoot } from ${JSON.stringify(ENGINE)};
      let state = ${seed};
      const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let x = Math.imul(state ^ state >>> 15, 1 | state);
        x ^= x + Math.imul(x ^ x >>> 7, 61 | x);
        return ((x ^ x >>> 14) >>> 0) / 4294967296;
      };
      const source = ${JSON.stringify(Object.entries(assets))};
      const entries = new Map(source);
      const get = entries.get.bind(entries);
      const has = entries.has.bind(entries);
      const Bytes = Uint8Array;
      const assets = Object.freeze({ has, read(name) {
        const bytes = get(name);
        if (!bytes) throw new Error('Unknown snapshot asset');
        return new Bytes(bytes);
      } });
      const root = new THREE.Group();
      export async function build() {
        const main = await import(${JSON.stringify(ENTRY)});
        if (typeof main.build !== 'function') throw new Error('main.mjs must export build({ THREE, root, assets, random })');
        await main.build({ THREE, root, assets, random });
      }
      export function finish() { return exportRoot(root); }`;
    // In this QuickJS binding, an error returned by the normalizer can be
    // lost before loading. Use a reserved synthetic name and reject there.
    let deniedImport = '';
    vm.setModuleLoader(name => {
      if (name === '@denied') return { error: new Error(deniedImport) };
      if (name === ENGINE) return engine;
      if (name === DRIVER) return driver;
      const source = files.get(name);
      return source === undefined ? { error: new Error(`Missing snapshot module: ${name}`) } : source;
    }, (base, request) => {
      if ((base === BOOT && request === DRIVER) || (base === DRIVER && (request === ENGINE || request === ENTRY))) return request;
      const target = files.has(base) ? resolveLocal(base, request) : undefined;
      if (target && files.has(target)) return target;
      deniedImport = target ? `Missing snapshot module: ${target} (imported from ${base})`
        : `Disallowed import ${JSON.stringify(request.slice(0, 240))} from ${base}`;
      return '@denied';
    });
    const evaluate = (source: string) => {
      const result = ctx.evalCode(source, BOOT, { type: 'global' });
      if (result.error) throw guestError(result.error);
      const promise = result.value;
      try {
        for (let batches = 0; batches < 4096; batches++) {
          if (expired()) throw limitError();
          const status = ctx.getPromiseState(promise);
          if (status.type === 'fulfilled') return status.value;
          if (status.type === 'rejected') throw guestError(status.error);
          const jobs = vm.executePendingJobs(32);
          if (jobs.error) throw guestError(jobs.error);
          if (jobs.value === 0) throw new PlaygroundError(phase, 'Promise did not settle; no guest jobs remain');
        }
        throw new PlaygroundError('limit', 'Guest promise job limit exceeded');
      } finally { promise.dispose(); }
    };
    phase = 'build';
    evaluate(`(async () => (await import('${DRIVER}')).build())()`).dispose();
    phase = 'export';
    const output = evaluate(`(async () => (await import('${DRIVER}')).finish())()`);
    let glb: ArrayBuffer;
    try {
      const bytes = ctx.getArrayBuffer(output);
      try {
        if (bytes.value.length > MAX_GLB_BYTES) throw new PlaygroundError('limit', 'GLB exceeds 16 MiB');
        glb = new Uint8Array(bytes.value).buffer;
      } finally { bytes.dispose(); }
    } finally { output.dispose(); }
    return { glb, objectCount: validateGlb(glb) };
  } catch (error) {
    failed = true;
    if (error instanceof PlaygroundError) throw error;
    throw new PlaygroundError(phase, error instanceof Error ? error.message : 'QuickJS failed');
  } finally {
    try {
      try { context?.dispose(); } finally { vm.dispose(); }
    } catch (error) {
      // Preserve the original diagnostic when a trapped runtime cannot unwind.
      if (!failed) throw new PlaygroundError('runtime', error instanceof Error ? error.message : 'QuickJS teardown failed');
    }
  }
}
