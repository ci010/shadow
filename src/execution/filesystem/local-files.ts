import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { filePreviewLimit, type LocalFileEntry, type LocalFileOperation } from './contracts.ts'
import { decodeTextPreview, type TextEncoding } from './text-encoding.ts'

export class FileReadError extends Error {
  constructor(readonly code: 'invalid_path' | 'not_a_file') {
    super(code)
  }
}

export type LocalFilesResult =
  | { operation: 'files'; base: string; path: string; entries: LocalFileEntry[] }
  | { operation: 'raw'; target: string; size: number; stream: ReadableStream<Uint8Array> }
  | { operation: 'preview'; target: string; preview: {
    path: string; size: number; truncated: boolean
  } & ReturnType<typeof decodeTextPreview> }

function contained(base: string, target: string): boolean {
  const path = relative(base, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../')
}

/** Resolve a relative path without permitting escape from the selected root. */
export function resolveInWorkspace(baseDir: string, relPath: string): string | null {
  if (relPath.includes('\0')) return null
  const target = resolve(baseDir, relPath.replace(/^[/\\]+/, ''))
  return contained(baseDir, target) ? target : null
}

async function resolveLocalFile(base: string, path: string): Promise<string | null> {
  const target = resolveInWorkspace(base, path)
  if (!target) return null
  const [root, canonical] = await Promise.all([realpath(base), realpath(target)])
  return contained(root, canonical) ? canonical : null
}

/** Read an authorized local root; raw stream ownership passes to the caller. */
export async function localFiles(
  base: string,
  operation: LocalFileOperation,
  path: string,
  signal: AbortSignal,
  maxBytes = filePreviewLimit(undefined),
  encoding: TextEncoding = 'auto',
): Promise<LocalFilesResult> {
  signal.throwIfAborted()
  base = await realpath(base)
  const target = await resolveLocalFile(base, path)
  if (!target) throw new FileReadError('invalid_path')
  if (operation === 'files') {
    const dirents = await readdir(target, { withFileTypes: true })
    const entries = await Promise.all(dirents.map(async entry => {
      let size = 0
      let mtime: string | null = null
      let isDir = entry.isDirectory()
      try {
        const child = await resolveLocalFile(base, relative(base, resolve(target, entry.name)))
        if (child) {
          const info = await stat(child)
          size = info.size
          mtime = info.mtime.toISOString()
          isDir = info.isDirectory()
        }
      } catch { /* A disappearing or inaccessible entry remains visible. */ }
      return { name: entry.name, type: isDir ? 'dir' as const : 'file' as const,
        ext: isDir ? '' : extname(entry.name).toLowerCase(), size, mtime }
    }))
    entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
    signal.throwIfAborted()
    return { operation, base, path: path.replace(/^[/\\]+/, ''), entries }
  }
  const file = await open(target, 'r')
  let streaming = false
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new FileReadError('not_a_file')
    signal.throwIfAborted()
    if (operation === 'raw') {
      const stream = file.createReadStream({ signal, autoClose: true })
      const result = { operation, target, size: info.size,
        stream: Readable.toWeb(stream) as ReadableStream<Uint8Array> }
      streaming = true
      return result
    }
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    const slice = buffer.subarray(0, bytesRead)
    return { operation, target, preview: { path, size: info.size,
      truncated: info.size > bytesRead, ...decodeTextPreview(slice, encoding, info.size > bytesRead) } }
  } finally {
    if (!streaming) await file.close()
  }
}
