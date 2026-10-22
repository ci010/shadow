import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { PROJECT_STORAGE_ENTRIES, projectDataPaths, projectStoragePath } from '../utils/data-paths.ts'

/** Historical text stays immutable; local file consumers can resolve paths that were moved. */
export function resolveLegacyProjectPath(home: string, path: string): string {
  if (!isAbsolute(path)) return path
  const root = resolve(home)
  let raw: string
  try { raw = readFileSync(resolve(root, 'state', 'layout-migration.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
    throw error
  }
  const marker = JSON.parse(raw) as { version?: unknown; legacyHome?: unknown }
  // This compatibility boundary is only for the same application's old managed
  // Project Home, never registered repositories or remote display paths.
  const expected = resolve(root, '..', '..', 'workspace.projects', 'projects', basename(root), 'workspace')
  if (marker.version !== 1 || typeof marker.legacyHome !== 'string' || !isAbsolute(marker.legacyHome) ||
    relative(expected, resolve(marker.legacyHome)) !== '' || basename(dirname(root)) !== 'projects') {
    throw new Error('Invalid Project storage migration marker')
  }
  const inside = (parent: string): string | undefined => {
    const suffix = relative(parent, path)
    return isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`) ? undefined : suffix
  }
  const oldConfig = inside(resolve(expected, '..', 'config'))
  if (oldConfig !== undefined) return resolve(root, 'config', oldConfig)
  const oldHome = inside(expected)
  if (oldHome === undefined) return path
  if (!oldHome) return root
  const entry = oldHome.split(sep)[0]!
  // Archives are no longer a service storage root; historical links can still
  // name Markdown retained by the completed layout migration.
  if (entry === 'projects') return resolve(root, 'state', 'legacy-initiatives', ...oldHome.split(sep).slice(1))
  return Object.hasOwn(PROJECT_STORAGE_ENTRIES, entry)
    ? projectStoragePath(root, oldHome)
    : resolve(projectDataPaths(root).workdirs, oldHome)
}
