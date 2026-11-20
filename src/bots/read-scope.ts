import { basename, dirname, posix } from 'node:path'
import type { FolderRecord } from '../folders/contracts.ts'
import { z } from 'zod'
import type { ReadResources } from './read-scope-contract.ts'
export { ReadResourcesSchema, RegisteredReadFoldersSchema, type ReadResources } from './read-scope-contract.ts'

export function resourceSubset(scope?: ReadResources, ceiling?: ReadResources): boolean {
  return (!scope?.wiki || !!ceiling?.wiki) && (!scope?.knowledge || !!ceiling?.knowledge) &&
    (scope?.folders ?? []).every(id => ceiling?.folders?.includes(id))
}

export function unambiguousResourceFolders(scope?: ReadResources, legacy?: readonly string[]): boolean {
  return scope?.folders === undefined || !legacy?.length
}

export function intersectResources(scope: ReadResources, ceiling?: ReadResources): ReadResources {
  return { wiki: !!scope.wiki && !!ceiling?.wiki, knowledge: !!scope.knowledge && !!ceiling?.knowledge,
    folders: scope.folders?.filter(id => ceiling?.folders?.includes(id)) }
}

/** An explicit new list replaces, never unions with, a legacy list. */
export const resourceFolders = (scope: ReadResources | undefined, legacy?: readonly string[]): readonly string[] => scope?.folders ?? legacy ?? []

export const hasResourceGrants = (scope?: ReadResources): boolean => !!(scope?.folders?.length || scope?.knowledge || scope?.wiki)

const key = (part: string) => part.normalize('NFC').toLowerCase()
export const cleanResourceSegment = (part: string) => !!part && part !== '.' && part !== '..' && !/[\\/:%\x00-\x1f\x7f]/.test(part)

export function allowedWorkspaceReadSegment(part: string): boolean {
  return cleanResourceSegment(part) && !/^(?:|\.git|\.env.*|bot\.config\.json)$/i.test(part.replace(/[. ]+$/, ''))
}

/** No registration IDs, insertion-order suffixes or arbitrary aliases. */
export function folderRoutes(ids: readonly string[], lookup: (id: string) => FolderRecord | undefined) {
  const items = [...new Set(ids)].flatMap(id => {
    const folder = lookup(id)
    if (!folder || folder.kind === 'layerfs') return []
    // Display metadata only. Never resolve a remote path on Main.
    const display = folder.kind === 'remote' ? folder.path.replace(/\\/g, '/') : folder.path
    const name = folder.kind === 'remote' ? posix.basename(display) : basename(display)
    const parent = folder.kind === 'remote' ? posix.basename(posix.dirname(display)) : basename(dirname(display))
    return cleanResourceSegment(name) ? [{ id, name, provenance: [folder.name, parent] }] : []
  })
  const count = (names: string[], name: string) => names.filter(value => key(value) === key(name)).length
  const originals = items.map(item => item.name)
  const proposed = items.flatMap(item => {
    if (count(originals, item.name) === 1) return [{ ...item, route: item.name }]
    const prefix = item.provenance.find(name => cleanResourceSegment(name) && key(name) !== key(item.name) &&
      !z.string().uuid().safeParse(name).success && !count(originals, `${name} - ${item.name}`) &&
      !items.some(other => other !== item && key(other.name) === key(item.name) && other.provenance.some(candidate => key(candidate) === key(name))))
    return prefix ? [{ ...item, route: `${prefix} - ${item.name}` }] : []
  })
  return new Map(proposed.filter(item => count(proposed.map(other => other.route), item.route) === 1)
    .sort((a, b) => a.route < b.route ? -1 : 1).map(item => [item.route, item.id]))
}
