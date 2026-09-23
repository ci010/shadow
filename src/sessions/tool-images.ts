import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentPart } from '../providers/provider.ts'
import { imageFromDataUrl } from '../utils/image-input.ts'

export const IMAGE_SNAPSHOT_LABEL = '\nImage snapshots (read these paths to view the same images again):\n'

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
    let existing: Buffer | undefined
    try { existing = await readFile(path, { signal }) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (existing) {
      if (!existing.equals(bytes)) throw new Error('Saved tool image does not match its content identity.')
    } else {
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, bytes, { flag: 'wx', signal })
        signal.throwIfAborted()
        try { await rename(temp, path) } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EEXIST'))) throw error
          // Windows may reject a competing rename while another reader holds the published file.
          if (!(await readFile(path, { signal })).equals(bytes)) throw error
        }
      } finally { await rm(temp, { force: true }) }
    }
    paths.push(path)
  }
  return paths
}
