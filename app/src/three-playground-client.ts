import { decodeBase64 } from './gltf-file-source.ts'

export interface ShaderSource { objectId: string; slot: number; vertex: string; fragment: string }
export interface FileSnapshot {
  version: string
  files: Record<string, string>
  assets: Record<string, ArrayBuffer>
  shaders: ShaderSource[]
}
export interface SnapshotRead { snapshot: FileSnapshot; tag: string }
const MiB = 1024 * 1024
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty snapshot response')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Snapshot byte limit exceeded')
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if ((length += value.length) > maxBytes) throw new Error('Snapshot byte limit exceeded')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  return JSON.parse(await new Blob(chunks).text())
}

export async function fetchPlaygroundSnapshot(url: URL, tag: string, signal: AbortSignal): Promise<SnapshotRead | null> {
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error', cache: 'no-store',
    headers: tag ? { 'If-None-Match': tag } : {} })
  if (tag && res.status === 304) return null
  if (!res.ok) {
    const e = await boundedJson(res, 16 * 1024).catch(() => undefined)
    throw new Error([`Snapshot (${res.status})`, ...(object(e) ? [e.file, e.message ?? e.error, e.id].filter(s => typeof s === 'string') : [])].join(': '))
  }
  const value = await boundedJson(res, 8 * MiB)
  if (!object(value) || typeof value.version !== 'string' || !/^[\da-f]{64}$/.test(value.version) || !object(value.files)
    || typeof value.files['main.mjs'] !== 'string' || Object.keys(value.files).length > 128 || !Object.values(value.files).every(s => typeof s === 'string')
    || !object(value.assets) || Object.keys(value.assets).length > 64 || !Array.isArray(value.shaders) || value.shaders.length > 32
    || !value.shaders.every(s => object(s) && typeof s.objectId === 'string' && Number.isSafeInteger(s.slot) && typeof s.vertex === 'string' && typeof s.fragment === 'string')) {
    throw new Error('Invalid Playground snapshot response')
  }
  let budget = MiB
  const assets: Record<string, ArrayBuffer> = Object.create(null)
  for (const [path, data] of Object.entries(value.assets)) {
    if (typeof data !== 'string') throw new Error('Invalid asset bytes')
    const bytes = decodeBase64(data, budget)
    budget -= bytes.length
    assets[path] = bytes.buffer
  }
  return { snapshot: { version: value.version, files: value.files as Record<string, string>, assets, shaders: value.shaders as ShaderSource[] }, tag: res.headers.get('ETag') ?? '' }
}

/** A poll observes an immutable snapshot. A newer observation invalidates the worker
 * immediately, before the debounce timer, even if the older GLB is still parsing. */
export function watchPlayground(callbacks: {
  read(tag: string, signal: AbortSignal): Promise<SnapshotRead | null>
  build(snapshot: FileSnapshot, signal: AbortSignal): Promise<void>
  failed(error: unknown, version?: string): void
}, pollMs = 1000, debounceMs = 180) {
  let disposed = false, tag = '', previous = '', failures = 0
  let poll: ReturnType<typeof setTimeout> | undefined, debounce: ReturnType<typeof setTimeout> | undefined
  let reader: AbortController | undefined, builder: AbortController | undefined
  function invalidate() { clearTimeout(debounce); builder?.abort(); builder = undefined }
  async function check(force: boolean) {
    if (disposed) return
    clearTimeout(poll); reader?.abort()
    if (force) invalidate()
    const request = reader = new AbortController()
    try {
      const changed = await callbacks.read(force ? '' : tag, request.signal)
      if (request.signal.aborted) return
      failures = 0
      if (!changed) return
      tag = changed.tag
      if (!force && previous === changed.snapshot.version) return
      previous = changed.snapshot.version
      invalidate()
      const current = builder = new AbortController()
      const run = async () => {
        try { await callbacks.build(changed.snapshot, current.signal) }
        catch (error) { if (!current.signal.aborted) callbacks.failed(error, changed.snapshot.version) }
      }
      if (force) void run()
      else debounce = setTimeout(() => { void run() }, debounceMs)
    } catch (error) {
      if (!request.signal.aborted) {
        invalidate(); previous = tag = ''; failures++
        callbacks.failed(error)
      }
    } finally {
      if (!disposed && reader === request) poll = setTimeout(() => { void check(false) }, pollMs * 2 ** Math.min(failures, 3))
    }
  }
  void check(true)
  return { rebuild: () => { void check(true) }, dispose: () => { disposed = true; clearTimeout(poll); reader?.abort(); invalidate() } }
}

export async function exportSnapshot(snapshot: FileSnapshot, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  const { buildPlayground } = await import('@shadow/three-playground')
  signal.throwIfAborted()
  const { glb } = await buildPlayground(snapshot, { signal, timeoutMs: 10_000 })
  return glb
}
