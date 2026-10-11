import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'

/**
 * Remove stale tool-result temp files older than `maxAgeMs` from `<workspace>/.tmp/`.
 */
export async function cleanupTempFiles(
  workspace: string,
  maxAgeMs = 60 * 60 * 1_000,
): Promise<void> {
  const tmpDir = join(workspace, '.tmp')
  try {
    const cutoff = Date.now() - maxAgeMs
    for (const entry of await readdir(tmpDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('tool-result-')) continue
      const filePath = join(tmpDir, entry.name)
      try {
        const info = await stat(filePath)
        if (info.mtime && info.mtime.getTime() < cutoff) {
          await rm(filePath)
        }
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* .tmp dir may not exist yet */ }
}

/**
 * Make a session ID safe for use as a filename component.
 */
export function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Generate a physical session ID from a logical session ID and a sequence index.
 */
export function newPhysicalSessionId(sessionId: string, index: number, version: 1 | 2 = 2): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_')
    .slice(0, 48)
  if (version === 2) {
    const digest = createHash('sha256').update(sessionId).digest('hex')
    return `${safe}-v2-${digest}-${index}`
  }
  return `${safe}-${index}`
}

/**
 * Resolve a path relative to the agent workspace root.
 */
export function workspacePath(
  workspace: string,
  ...segments: string[]
): string {
  return resolve(workspace, ...segments)
}

/**
 * Absolute path of the per-session working directory
 * (`<workspace>/<safeSessionId>/`).
 *
 * Each logical session gets its own folder so that files the agent produces
 * stay isolated instead of cluttering the shared workspace root.
 */
export function sessionWorkspacePath(
  workspace: string,
  sessionId: string,
): string {
  return resolve(workspace, safeSessionId(sessionId))
}

/**
 * Rewrite a leading `v:memory` virtual-filesystem alias to the real `memory/`
 * path segment, so tools that write/edit through `v:memory/...` land in the
 * shared memory store. Paths without the alias are returned unchanged.
 */
export function dealiasMemoryPath(p: string): string {
  return p.replace(/^v:memory(?=[\\/]|$)/, 'memory')
}

/**
 * Resolve an agent-provided path for filesystem/shell tools.
 *
 * - Absolute paths are returned unchanged.
 * - A leading `v:memory` alias is rewritten to the real `memory/` store.
 * - Explicit `v:memory` aliases and the special `.tmp` prefix resolve from Home.
 * - All other relative paths resolve against the effective working directory
 *   (`cwd`), including repository names such as AGENTS.md, skills and projects.
 *   With no selected folder, callers supply the managed session directory.
 */
export function resolveAgentPath(
  workspace: string,
  cwd: string,
  p: string,
): string {
  if (isAbsolute(p)) return p
  const normalized = dealiasMemoryPath(p)
  const firstSegment = normalized.split(/[\\/]/)[0]
  if (
    /^v:memory(?=[\\/]|$)/.test(p) || firstSegment === '.tmp'
  ) {
    return resolve(workspace, normalized)
  }
  return resolve(cwd, normalized)
}

/**
 * Check whether a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Read a text file if it exists, otherwise return undefined.
 */
export async function readFileIfExists(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Save binary data into the per-session uploads folder
 * (`<workspace>/<safeSessionId>/uploads/<filename>`) and return the
 * session-relative path (e.g. `"uploads/discord_123.png"`).
 *
 * The returned path resolves back to the same file from within the session via
 * {@link resolveAgentPath}, since `uploads` is not a shared prefix.
 *
 * The uploads directory is created automatically if it does not exist.
 */
export async function saveToUploads(
  workspace: string,
  sessionId: string,
  filename: string,
  data: Uint8Array,
): Promise<string> {
  const uploadsDir = join(sessionWorkspacePath(workspace, sessionId), 'uploads')
  await mkdir(uploadsDir, { recursive: true })
  await writeFile(join(uploadsDir, filename), data)
  return `uploads/${filename}`
}

/**
 * Resolve a media path and read the file. Relative paths resolve against the
 * session working directory (so `uploads/...` lands in the per-session folder),
 * falling back to the shared workspace root for backward compatibility.
 * Returns the raw bytes, filename, and lowercase extension.
 */
export async function readMediaFile(
  workspace: string,
  sessionId: string,
  mediaPath: string,
): Promise<{ filename: string; data: Uint8Array; ext: string }> {
  let absPath: string
  if (isAbsolute(mediaPath)) {
    absPath = mediaPath
  } else {
    const cwd = sessionWorkspacePath(workspace, sessionId)
    absPath = resolveAgentPath(workspace, cwd, mediaPath)
    // Fall back to the shared workspace root for files saved before uploads
    // were per-session, or media referenced by a plain root-relative path.
    if (!(await fileExists(absPath))) {
      const rootPath = resolve(workspace, mediaPath)
      if (await fileExists(rootPath)) absPath = rootPath
    }
  }
  const data = await readFile(absPath)
  const filename = basename(absPath)
  const ext = extname(filename).toLowerCase()
  return { filename, data, ext }
}
