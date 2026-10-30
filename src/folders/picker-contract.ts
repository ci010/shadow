/** Only the owner UI service may dispatch these operations; never a chat tool. */
export const LEGACY_FOLDER_PICKER_ID = 'owner-folder-picker-v1'
export const FOLDER_BROWSE_OPERATION = 'owner.folder.browse'
export const FOLDER_SELECT_OPERATION = 'owner.folder.select'
export interface DirectoryListing {
  path: string
  parent: string | null
  directories: { name: string; path: string }[]
  truncated: boolean
}
export function parseDirectoryListing(value: unknown): DirectoryListing {
  const v = value as DirectoryListing
  if (!v || typeof v !== 'object' || typeof v.path !== 'string' || !v.path || v.path.length > 4096 || /[\0\r\n]/.test(v.path) ||
    !(v.parent === null || (typeof v.parent === 'string' && v.parent.length <= 4096 && !/[\0\r\n]/.test(v.parent))) || typeof v.truncated !== 'boolean' ||
    !Array.isArray(v.directories) || v.directories.length > 1000 || v.directories.some(e =>
      !e || typeof e.name !== 'string' || !e.name || e.name.length > 1024 || e.name === '.' || e.name === '..' || /[/\\\0]/.test(e.name) || typeof e.path !== 'string' || !e.path || e.path.length > 4096 || /[\0\r\n]/.test(e.path))) {
    throw new TypeError('Invalid directory listing')
  }
  return v
}
