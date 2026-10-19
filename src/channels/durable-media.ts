import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { ChatMessage } from '../providers/provider.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'

const run = promisify(execFile)
let roots: Promise<string[]> | undefined

/** OS-resolved output folders only, never the user's entire home or a guessed Windows path. */
export function durableMediaRoots(): Promise<string[]> {
  return roots ??= discoverRoots()
}

async function discoverRoots(): Promise<string[]> {
  try {
    let folders: string[]
    if (process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $s=New-Object -ComObject Shell.Application; $d=$s.NameSpace('shell:Downloads').Self.Path; ConvertTo-Json -Compress -InputObject @([Environment]::GetFolderPath('MyDocuments'),[Environment]::GetFolderPath('MyPictures'),[Environment]::GetFolderPath('MyMusic'),[Environment]::GetFolderPath('MyVideos'),[Environment]::GetFolderPath('DesktopDirectory'),$d)`
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, windowsHide: true })
      const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''))
      folders = Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
    } else if (process.platform === 'darwin') {
      folders = await Promise.all(['documents', 'pictures', 'music', 'movies', 'desktop', 'downloads'].map(async name => {
        const { stdout } = await run('osascript', ['-e', `POSIX path of (path to ${name} folder)`], { timeout: 5_000 })
        return stdout.trim()
      }))
    } else {
      folders = await Promise.all(['DOCUMENTS', 'PICTURES', 'MUSIC', 'VIDEOS', 'DESKTOP', 'DOWNLOAD'].map(async name => {
        const { stdout } = await run('xdg-user-dir', [name], { timeout: 5_000 })
        return stdout.trim()
      }))
    }
    return [...new Set(folders.filter(p => p && isAbsolute(p)).map(p => join(p, 'Shadow')))]
  } catch {
    // OS discovery failure must not widen the allowlist.
    return []
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

export function isDurableMediaCandidate(path: string, allowedRoots: readonly string[]): boolean {
  return isAbsolute(path) && !path.includes('\0') && allowedRoots.some(root => within(root, resolve(path)))
}

/** History is the persisted attachment declaration (JSONL and SQLite share ChatMessage).
 * Ordinary prose, code samples, user messages and tool output never grant access.
 */
export async function resolveDurableMedia(
  path: string,
  history: readonly ChatMessage[],
  allowedRoots: readonly string[],
): Promise<string | null> {
  if (!isAbsolute(path) || path.includes('\0')) return null
  const target = resolve(path)
  if (!history.some(message => {
    if (message.role !== 'assistant') return false
    const text = typeof message.content === 'string' ? message.content
      : message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    return parseMediaFromContent(text).media?.some(p => isAbsolute(p) && resolve(p) === target)
  })) return null
  for (const root of allowedRoots) {
    if (!within(root, target)) continue
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
      // Refuse a redirected Shadow root itself and any symlink/junction escaping it.
      if (resolve(realRoot) !== resolve(root) || !within(realRoot, realTarget)) continue
      if ((await stat(realTarget)).isFile()) return realTarget
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return null
}
