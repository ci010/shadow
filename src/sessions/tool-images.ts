import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentPart } from '../providers/provider.ts'
import { imageFromDataUrl } from '../utils/image-input.ts'

/** Small live events point at immutable private uploads; history retains the image bytes. */
export async function saveToolImages(sessionDataDir: string, content: ContentPart[], signal: AbortSignal): Promise<string[]> {
  const paths: string[] = []
  for (const part of content) {
    if (part.type !== 'image_url') continue
    signal.throwIfAborted()
    const url = imageFromDataUrl(part.image_url.url).image_url.url
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    const ext = url.slice('data:image/'.length, url.indexOf(';'))
    const root = join(sessionDataDir, 'uploads', 'tool-images')
    await mkdir(root, { recursive: true })
    const path = join(root, `${createHash('sha256').update(bytes).digest('hex')}.${ext}`)
    try { await writeFile(path, bytes, { flag: 'wx', signal }) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (!(await readFile(path, { signal })).equals(bytes)) throw new Error('Saved tool image does not match its content identity.')
    }
    paths.push(path)
  }
  return paths
}
