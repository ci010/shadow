import { isRecord } from './folders-sidebar.ts'

export function toolImages(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(part => isRecord(part) && part.type === 'image_url' && isRecord(part.image_url)
    && typeof part.image_url.url === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i.test(part.image_url.url)
    ? [part.image_url.url] : [])
}
