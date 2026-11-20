import { createUuid } from './uuid.ts'

export const isPlaygroundFile = (name: string) => name === 'playground.three.json'
export const isGltfFile = (name: string) => /\.(?:gltf|glb)$/i.test(name)
export const MODEL_MAX_BYTES = 32 * 1024 * 1024
const JSON_MAX_BYTES = 2 * 1024 * 1024
const INPUT_MAX_BYTES = 64 * 1024 * 1024

/** Never follow a URL supplied by a model. Only ordinary adjacent model buffers/images may be read. */
function resourcePath(uri: string, image: boolean): string {
  let path: string
  try { path = decodeURIComponent(uri) } catch { throw new Error('Invalid encoded glTF resource name') }
  if (path.startsWith('./')) path = path.slice(2)
  if (!path || path.length > 1024 || /[\x00-\x1f\x7f\\:#?%]/.test(path)
    || path.split('/').some(s => !s || s.startsWith('.') || /[. ]$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s))
    || !(image ? /\.(png|jpe?g)$/i : /\.bin$/i).test(path)) {
    throw new Error('glTF resources must be relative .bin, .png or .jpg files within the model directory')
  }
  return path
}

export async function collectModelResources(bytes: Uint8Array, signal: AbortSignal,
  read?: (relative: string, maxBytes: number) => Promise<Uint8Array>): Promise<Map<string, Uint8Array>> {
  if (bytes.length > MODEL_MAX_BYTES) throw new Error('Model exceeds 32 MiB')
  let json = bytes
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 4 && header.getUint32(0, true) === 0x46546c67) {
    if (bytes.length < 20 || header.getUint32(8, true) !== bytes.length || header.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid GLB header')
    const length = header.getUint32(12, true)
    if (length > bytes.length - 20) throw new Error('Truncated GLB JSON')
    json = bytes.subarray(20, 20 + length)
  }
  if (json.length > JSON_MAX_BYTES) throw new Error('Model JSON exceeds 2 MiB')
  const model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))
  if (model?.asset?.version !== '2.0') throw new Error('Expected glTF 2.0')
  const resources = new Map<string, Uint8Array>()
  let remaining = INPUT_MAX_BYTES - bytes.length
  for (const key of ['buffers', 'images'] as const) {
    const list = model[key] ?? []
    if (!Array.isArray(list) || list.length > 128) throw new Error(`Invalid glTF ${key} table`)
    for (const item of list) {
      signal.throwIfAborted()
      const uri: unknown = item?.uri
      if (uri === undefined) continue
      if (typeof uri !== 'string' || !uri) throw new Error(`Invalid URI in glTF ${key}`)
      if (resources.has(uri)) continue
      if (resources.size >= 128) throw new Error('Too many glTF resources')
      let data: Uint8Array
      if (uri.startsWith('data:')) {
        const comma = uri.indexOf(',')
        const prefix = uri.slice(0, comma)
        if (comma < 0 || !(key === 'buffers' ? /^data:application\/(?:octet-stream|gltf-buffer);base64$/i : /^data:image\/(?:png|jpeg);base64$/i).test(prefix)) throw new Error('Unsupported embedded glTF resource')
        data = decodeBase64(uri.slice(comma + 1), remaining)
      } else {
        const path = resourcePath(uri, key === 'images')
        if (!read) throw new Error('Sidecar files are unavailable for standalone attachments or archive entries; use a self-contained GLB')
        data = await read(path, Math.min(MODEL_MAX_BYTES, remaining))
      }
      if (data.length > remaining) throw new Error('Model resources exceed 64 MiB')
      remaining -= data.length
      resources.set(uri, data)
    }
  }
  signal.throwIfAborted()
  return resources
}

export function decodeBase64(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (value.length > 4 * Math.ceil(maxBytes / 3)) throw new Error('Resource byte limit exceeded')
  const source = atob(value)
  if (source.length > maxBytes) throw new Error('Resource byte limit exceeded')
  return Uint8Array.from(source, c => c.charCodeAt(0))
}

/** Include sidecar contents in asset revisions. HTTP-only clients without SubtleCrypto
 * still get a unique load revision (never a name/mtime that could accidentally match). */
export async function modelVersion(bytes: Uint8Array<ArrayBuffer>, resources: ReadonlyMap<string, Uint8Array>): Promise<string> {
  if (!globalThis.crypto?.subtle) return `load-${createUuid()}`
  const hash = async (data: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('')
  const parts: string[] = [await hash(bytes)]
  if (!resources.size) return parts[0]!
  for (const [uri, value] of resources) parts.push(uri, await hash(new Uint8Array(value)))
  return hash(new TextEncoder().encode(JSON.stringify(parts)))
}
