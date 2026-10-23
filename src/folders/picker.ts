import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type { DirectoryListing } from './picker-contract.ts'
export * from './picker-contract.ts'
export function pickerPath(value: unknown, allowHome = false): string {
  if (allowHome && value === '') return homedir()
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value) || !isAbsolute(value)) {
    throw new TypeError('Provide an absolute directory path on the selected device')
  }
  return value
}
export async function browseDirectories(value: unknown, signal: AbortSignal): Promise<DirectoryListing> {
  const path = await realpath(pickerPath(value, true))
  signal.throwIfAborted()
  if (!(await stat(path)).isDirectory()) throw new TypeError('Not a directory')
  const directories: DirectoryListing['directories'] = []
  let truncated = false
  for (const entry of await readdir(path, { withFileTypes: true })) {
    signal.throwIfAborted()
    const child = join(path, entry.name)
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try { directory = (await stat(child)).isDirectory() } catch { continue }
    }
    if (!directory) continue
    if (directories.length === 1000) { truncated = true; break }
    directories.push({ name: entry.name, path: child })
  }
  directories.sort((a, b) => a.name.localeCompare(b.name))
  return { path, parent: dirname(path) === path ? null : dirname(path), directories, truncated }
}
