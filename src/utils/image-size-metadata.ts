/** Payload-only lengths, not data-URI, JSON, HTTP, pixel or decompressed sizes. */
export interface ImageSizeMetadata {
  base64Characters: number
  base64Bytes: number
  decodedBytes?: number
}

/** No decoding/allocation of the binary image. Only strict standard base64 is counted as decodable. */
export function base64SizeMetadata(payload: string): ImageSizeMetadata {
  const size: ImageSizeMetadata = { base64Characters: payload.length, base64Bytes: Buffer.byteLength(payload, 'utf8') }
  // Accept padded and unpadded canonical base64; reject whitespace, URL-safe,
  // malformed padding and nonzero unused bits rather than guessing a size.
  const match = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(payload)
  if (!match) return size
  const body = match[1]!, padding = match[2]!.length, remainder = body.length % 4
  if (remainder === 1 || (padding > 0 && (payload.length % 4 !== 0 || padding !== (4 - remainder) % 4))) return size
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const last = alphabet.indexOf(body.at(-1) ?? 'A')
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) return size
  size.decodedBytes = Math.floor(body.length * 3 / 4)
  return size
}

export function imageUrlSizeMetadata(url: string): ImageSizeMetadata | undefined {
  const match = /^data:image\/[^;,]+(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(url)
  return match ? base64SizeMetadata(match[1]!) : undefined
}

/** Extract only known image representations, never retain a URL or arbitrary fields. */
export function imagePartSizeMetadata(value: Record<string, unknown>): ImageSizeMetadata | undefined {
  if (value.type === 'image_url' || value.type === 'input_image') {
    const image = value.image_url
    const url = typeof image === 'string' ? image : image && typeof image === 'object' ? (image as Record<string, unknown>).url : undefined
    return typeof url === 'string' ? imageUrlSizeMetadata(url) : undefined
  }
  if (value.type === 'image' && value.source && typeof value.source === 'object') {
    const source = value.source as Record<string, unknown>
    if (source.type === 'base64' && typeof source.data === 'string') return base64SizeMetadata(source.data)
  }
  return undefined
}
