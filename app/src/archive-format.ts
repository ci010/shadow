import type { FileEntry } from './composables/useSessionFiles.ts'

export const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024
export const ARCHIVE_ENTRY_MAX_BYTES = 32 * 1024 * 1024
export const ARCHIVE_MAX_ENTRIES = 50_000
export const ARCHIVE_MAX_DEPTH = 4

export interface ArchiveReference {
  path: string
  members: string[]
}

export interface ArchiveMember {
  path: string
  type: 'file' | 'dir'
  size: number
  encrypted: boolean
  link: boolean
  stream?: boolean
}

export interface ArchiveRequest {
  file: Blob
  name: string
  members: string[]
  mode: 'list' | 'read'
}

export type ArchiveResult = { entries: ArchiveMember[] } | { bytes: Uint8Array<ArrayBuffer> }

export function isArchive(name: string): boolean {
  return /\.(?:zip|7z|rar|tar|gz|tgz|bz2|tbz2?|xz|txz)$/i.test(name)
}

const mediaTypes: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf',
}

export function archiveMimeType(name: string): string {
  return mediaTypes[name.split('.').at(-1)!.toLowerCase()] ?? 'application/octet-stream'
}

export function archivePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized.length > 4096 || /[\x00-\x1f\x7f]/.test(normalized)
    || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('This archive contains an unsafe or unsupported entry path.')
  }
  return normalized
}

export function archiveDirectory(entries: readonly ArchiveMember[], archive: ArchiveReference, dir = ''): FileEntry[] {
  const children = new Map<string, FileEntry>()
  const prefix = dir ? `${dir}/` : ''
  for (const member of entries) {
    if (!member.path.startsWith(prefix)) continue
    const relative = member.path.slice(prefix.length)
    if (!relative) continue
    const [name, ...rest] = relative.split('/')
    const directory = rest.length > 0 || member.type === 'dir'
    const previous = children.get(name!)
    if (previous) {
      if (previous.type !== (directory ? 'dir' : 'file')) throw new Error('This archive contains conflicting file and folder paths.')
      continue
    }
    const path = prefix + name
    children.set(name!, {
      name: name!, type: directory ? 'dir' : 'file',
      ext: directory ? '' : name!.slice(name!.lastIndexOf('.') < 0 ? name!.length : name!.lastIndexOf('.')).toLowerCase(),
      size: directory ? 0 : member.size, mtime: null,
      archive: { path: archive.path, members: [...archive.members, path] },
    })
  }
  return [...children.values()].sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
}
