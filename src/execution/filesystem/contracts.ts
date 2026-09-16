export interface LocalFileEntry {
  name: string
  type: 'dir' | 'file'
  ext: string
  size: number
  mtime: string | null
}

export type LocalFileOperation = 'files' | 'raw' | 'preview'

export function filePreviewLimit(value: string | undefined): number {
  return Math.min(Math.max(parseInt(value ?? '4096', 10) || 4096, 256), 65536)
}
