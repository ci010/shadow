import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { imageSize } from 'image-size'
import type { ImageContentPart } from '../providers/provider.ts'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 25_000_000
export const MAX_TOOL_IMAGES = 4
const formats = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']])
const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.avif', '.heic', '.heif', '.ico'])

export function isImagePath(path: string): boolean {
  if (path.startsWith('data:image/')) return true
  return extensions.has(extname(/^https?:\/\//i.test(path) ? new URL(path).pathname : path).toLowerCase())
}

export async function isImageFile(path: string): Promise<boolean> {
  if (isImagePath(path) && extname(path).toLowerCase() !== '.svg') return true
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    return (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (bytesRead >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255) ||
      (bytesRead >= 6 && /^GIF8[79]a$/.test(header.toString('ascii', 0, 6))) ||
      (bytesRead >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
  } finally { await file.close() }
}

/** Immutable bytes are stored in the existing multimodal history, not reread from mutable paths. */
export function imageFromBytes(bytes: Uint8Array, expectedMime?: string): {
  part: ImageContentPart; width: number; height: number; mime: string
} {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Image must be nonempty and at most 5 MiB. Resize or crop it before reading.')
  }
  let info: ReturnType<typeof imageSize>
  try { info = imageSize(bytes) }
  catch { throw new Error('Invalid image header. Supported image formats: PNG, JPEG, GIF and WebP.') }
  const mime = formats.get(info.type ?? '')
  if (!mime) throw new Error('Unsupported image format. Convert to PNG, JPEG, GIF or WebP before reading.')
  if (expectedMime && expectedMime.toLowerCase() !== mime) throw new Error('Image MIME type does not match its bytes.')
  const { width, height } = info
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('Image dimensions exceed 25 million pixels. Resize or crop it before reading.')
  }
  return { mime, width, height, part: {
    type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, detail: 'auto' },
  } }
}

export function imageFromDataUrl(url: string): ImageContentPart {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url)
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error('Expected a PNG, JPEG, GIF or WebP data URL of at most 5 MiB.')
  }
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.toString('base64') !== match[2]) throw new Error('Invalid image base64 encoding.')
  return imageFromBytes(bytes, match[1]).part
}

export async function imageFromResponse(response: Response, signal?: AbortSignal) {
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}.`)
  if (!response.body) throw new Error('Image download returned no body.')
  const reader = response.body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 5 MiB. Resize or crop it before reading.')
      chunks.push(value)
    }
    signal?.throwIfAborted()
    return imageFromBytes(Buffer.concat(chunks, length))
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

export async function readImage(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Image input must be a regular file.')
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 5 MiB. Resize or crop it before reading.')
    // Bound allocation even if the file grows after stat.
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    signal?.throwIfAborted()
    return imageFromBytes(bytes.subarray(0, length))
  } finally { await file.close() }
}
