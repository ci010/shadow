import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'node:path'
import { isMissingRuntimeConfig, normalizeMainDirectoryPath } from './runtime-config.js'

async function canonical(path: string): Promise<string> {
  path = normalizeMainDirectoryPath(path)
  try { return await realpath(path) }
  catch (error) {
    if (!isMissingRuntimeConfig(error)) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonical(parent), basename(path))
  }
}
function contains(a: string, b: string): boolean {
  const value = relative(a, b)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

/** Reject alias/nested homes too: switching roles must not repurpose the other role's data. */
export async function assertRoleDataIsolation(paths: readonly string[], otherConfigPath: string, expectedOther: 'main' | 'child'): Promise<void> {
  let config: Record<string, unknown>
  try { config = JSON.parse(await readFile(otherConfigPath, 'utf8')) }
  catch (error) { if (isMissingRuntimeConfig(error)) return; throw error }
  if (!config || config.mode !== expectedOther || typeof config.dataDir !== 'string') throw new Error('Other desktop role configuration is invalid; restore it before changing folders')
  const protectedPaths = [config.dataDir]
  if (expectedOther === 'child') {
    if (!Array.isArray(config.workdirs)) throw new Error('Saved Child work folders are invalid')
    for (const entry of config.workdirs) {
      if (!entry || typeof entry.rootPath !== 'string') throw new Error('Saved Child work folders are invalid')
      protectedPaths.push(entry.rootPath)
    }
  }
  for (const path of paths) {
    const actual = await canonical(resolve(path))
    for (const protectedPath of protectedPaths) {
      const other = await canonical(protectedPath)
      if (contains(actual, other) || contains(other, actual)) throw new Error('Main data and Child home/work folders must be separate, non-overlapping folders')
    }
  }
}
