import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectDataPaths, projectStoragePath } from './data-paths.ts'
import { sessionWorkspacePath } from './paths.ts'
import { OUTPUT_PREVIEW_CHARS, outputPreview, safePrefix } from './output-preview.ts'

export const SESSION_OUTPUT_DIR = '.tool-output'
const spillReference = /^(v:output|\.tmp)\/((?:tool-result|background-task)-[\w-]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.txt)$/

/** Workdirs can be shared or have colliding legacy safe IDs; spills never share ownership. */
export function sessionOutputDirectory(home: string, sessionId: string): string {
  return join(sessionWorkspacePath(home, sessionId), SESSION_OUTPUT_DIR, createHash('sha256').update(sessionId).digest('hex'))
}

async function checkDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (!(await lstat(path)).isDirectory()) throw new Error('Output spill storage must be a regular directory, not a link.')
}

async function resolveOutputDirectory(home: string, sessionId: string, create: boolean): Promise<string> {
  const workdirs = projectDataPaths(home).workdirs
  const sessionDir = sessionWorkspacePath(home, sessionId)
  const directory = sessionOutputDirectory(home, sessionId)
  // Check before descending: a session's managed workdir can be edited by tools.
  for (const component of [workdirs, sessionDir, join(sessionDir, SESSION_OUTPUT_DIR), directory]) {
    await checkDirectory(component, create)
  }
  return directory
}

export async function removeSessionOutput(home: string, sessionId: string): Promise<void> {
  try { await rm(await resolveOutputDirectory(home, sessionId, false), { recursive: true, force: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

export async function spillOutputPreview(
  home: string | undefined, sessionId: string, label: string, text: string,
  limit = OUTPUT_PREVIEW_CHARS,
  onError: (error: unknown) => string = () => 'Full output was NOT saved: session output storage is unavailable.',
): Promise<string> {
  if (text.length <= limit) return text
  const preview = outputPreview(text, limit)
  try {
    if (!home || !sessionId) throw new Error('Session output storage is unavailable')
    const directory = await resolveOutputDirectory(home, sessionId, true)
    const filename = `${label.replace(/[^\w-]/g, '_').slice(0, 80)}-${randomUUID()}.txt`
    await writeFile(join(directory, filename), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const path = `v:output/${filename}`
    return preview + `Full output saved to: ${path}\n` +
      `Use read with path=${JSON.stringify(path)}, flag="c", offset=1 to page through the captured output.`
  } catch (error) {
    return preview + onError(error)
  }
}

/** Read a bounded UTF-8 spill page, even if the output is a single huge line. */
export async function readOutputSpill(home: string, sessionId: string, path: string, offset: number, limit: number, signal: AbortSignal): Promise<string> {
  const match = spillReference.exec(path)
  if (!match) throw new Error('Flag c is only for generated tool-output references (v:output/ or legacy .tmp/).')
  const file = match[1] === 'v:output'
    ? join(await resolveOutputDirectory(home, sessionId, false), match[2]!)
    : projectStoragePath(home, path)
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
