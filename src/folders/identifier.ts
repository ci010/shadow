/** Human-readable selectors, stable across ordering and registry growth. */
export function folderSlug(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'folder'
}

export function folderIdentifier(id: string, name?: string): string {
  if (!name) return id
  return `${folderSlug(name)}-${id.replaceAll('-', '').slice(0, 8)}`
}

export function selectFolder<T extends { id: string; name?: string }>(folders: readonly T[], identifier: string): T {
  // Full identity is always authoritative, even if another folder's name resembles it.
  const exact = folders.filter(folder => folder.id === identifier)
  if (exact.length === 1) return exact[0]!
  const matches = folders.filter(folder => folderIdentifier(folder.id, folder.name) === identifier || folder.name && folderSlug(folder.name) === identifier)
  if (matches.length !== 1) throw new Error('Unknown or ambiguous Project folder identifier. Read v:project/folders; use its name-ID selector or full folder ID, never a path. A plain folder name is accepted only when unique.')
  return matches[0]!
}

/** Prefer the shortest selector that resolves to this exact folder in this Project. */
export function projectFolderIdentifier<T extends { id: string; name?: string }>(folders: readonly T[], folder: T): string {
  const candidates = [folder.name ? folderSlug(folder.name) : folder.id, folderIdentifier(folder.id, folder.name), folder.id]
  for (const candidate of candidates) {
    try {
      if (selectFolder(folders, candidate).id === folder.id) return candidate
    } catch { /* A collision needs a more specific selector. */ }
  }
  throw new Error('Project folder has no unique selector.')
}
