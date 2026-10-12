import { createUuid } from './uuid.ts'
import { fileTreePaths } from './file-tree-menu.ts'
import type { DirListing } from './composables/useSessionFiles.ts'

export const FILE_REFERENCE_MIME = 'application/x-shadow-file-reference'
export interface FileReference { apiBase: string; path: string; kind: 'file' | 'folder' }
const references = new Map<string, FileReference>()

/** Owned renderer token, not arbitrary serialized paths from external drag data. */
export function startFileReferenceDrag(
  data: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  apiBase: string, workdir: DirListing['workdir'], relativePath: string, kind: FileReference['kind'],
): (() => void) | undefined {
  if (workdir?.kind !== 'local' || !workdir.displayPath || !relativePath
    || relativePath.split(/[\\/]/).some(part => part === '..') || relativePath.includes('\0')) return
  const path = fileTreePaths(workdir, relativePath).full
  const token = createUuid()
  data.setData(FILE_REFERENCE_MIME, token)
  data.effectAllowed = 'copy'
  references.set(token, { apiBase, path, kind })
  return () => { references.delete(token) }
}
export function hasFileReference(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data && Array.from(data.types).includes(FILE_REFERENCE_MIME)
}
export function readFileReference(data: Pick<DataTransfer, 'types' | 'getData'> | null): FileReference | undefined {
  if (!data || !hasFileReference(data)) return
  return references.get(data.getData(FILE_REFERENCE_MIME))
}
