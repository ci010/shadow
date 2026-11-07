import { isRecord } from './folders-sidebar.ts'

const imageDataPrefix = /^data:image\/(?:png|jpeg|gif|webp);base64,/i
// Search for one non-alphabet character, without a payload-sized capture or
// backtracking over the payload. lastIndex is reset on every synchronous call.
const nonBase64Character = /[^A-Za-z0-9+/]/g

function isImageDataUrl(url: string): boolean {
  const prefix = imageDataPrefix.exec(url)
  if (!prefix) return false
  const start = prefix[0].length
  if (start === url.length) return false
  nonBase64Character.lastIndex = start
  const first = nonBase64Character.exec(url)
  if (!first) return true
  // Preserve the old alphabet+ followed by any number of '=' padding characters;
  // deliberately do not impose decoded-byte, quartet, or padding-count limits.
  if (first.index === start) return false
  for (let i = first.index; i < url.length; i++) {
    if (url.charCodeAt(i) !== 61) return false
  }
  return true
}

export function toolImages(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const images: string[] = []
  for (const part of content) {
    if (isRecord(part) && part.type === 'image_url' && isRecord(part.image_url)
      && typeof part.image_url.url === 'string' && isImageDataUrl(part.image_url.url)) {
      images.push(part.image_url.url)
    }
  }
  return images
}
