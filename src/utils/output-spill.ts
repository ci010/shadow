import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectStoragePath } from './data-paths.ts'
import { OUTPUT_PREVIEW_CHARS, outputPreview, safePrefix } from './output-preview.ts'

export const OUTPUT_SPILL_PATH = /^\.tmp\/(?:tool-result|background-task)-[\w-]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.txt$/

export async function spillOutputPreview(
  workspace: string | undefined, label: string, text: string,
  limit = OUTPUT_PREVIEW_CHARS,
  onError: (error: unknown) => string = () => 'Full output was NOT saved: Project scratch storage is unavailable.',
): Promise<string> {
  if (text.length <= limit) return text
  const preview = outputPreview(text, limit)
  try {
    if (!workspace) throw new Error('Project Home is unavailable')
    const path = await saveOutputSpill(workspace, label, text)
    return preview + `Full output saved to: ${path}\n` +
      `Use read with path=${JSON.stringify(path)}, flag="c", offset=1 to page through the captured output.`
  } catch (error) {
    return preview + onError(error)
  }
}

/** Store the exact captured output, not the model preview, in its owning Project. */
async function saveOutputSpill(workspace: string, label: string, text: string): Promise<string> {
  const directory = projectStoragePath(workspace, '.tmp')
  const filename = `${label.replace(/[^\w-]/g, '_').slice(0, 80)}-${randomUUID()}.txt`
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, filename), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return `.tmp/${filename}`
}

/** Read a bounded UTF-8 spill page, even if the output is a single huge line. */
export async function readOutputSpill(workspace: string, path: string, offset: number, limit: number, signal: AbortSignal): Promise<string> {
  if (!OUTPUT_SPILL_PATH.test(path)) throw new Error('Flag c is only for generated tool-output files in Project Home .tmp/.')
  const file = projectStoragePath(workspace, path)
  if (!(await lstat(file)).isFile()) throw new Error('The output spill must be a regular file.')
  const size = Math.min(OUTPUT_PREVIEW_CHARS, limit)
  let skip = offset - 1
  let page = ''
  const stream = createReadStream(file, { encoding: 'utf8', signal })
  for await (const chunk of stream as AsyncIterable<string>) {
    if (skip >= chunk.length) { skip -= chunk.length; continue }
    if (skip && safePrefix(chunk, skip).length !== skip) throw new Error('Offset splits a Unicode character. Use the continuation offset from the previous page.')
    page += chunk.slice(skip, skip + size + 2 - page.length)
    skip = 0
    if (page.length > Math.max(2, size)) break
  }
  if (page.length <= size) return page
  const preview = safePrefix(page, size) || safePrefix(page, 2)
  if (preview.length === page.length) return preview
  return preview + `\n\n[more output: use flag="c" and offset=${offset + preview.length} to continue]`
}
