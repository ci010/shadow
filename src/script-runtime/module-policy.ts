import { z } from 'zod'

export const PURE_NODE_MODULES = [
  'node:assert', 'node:assert/strict', 'node:buffer', 'node:crypto',
  'node:path', 'node:path/posix', 'node:path/win32', 'node:querystring',
  'node:string_decoder', 'node:url', 'node:util',
] as const

export const LIVE_NODE_MODULES = [
  ...PURE_NODE_MODULES, 'node:fs', 'node:fs/promises', 'node:http', 'node:https',
  'node:net', 'node:os', 'node:stream', 'node:stream/promises', 'node:zlib',
] as const

export const ScriptImportsSchema = z.array(z.string().refine(
  value => LIVE_NODE_MODULES.some(name => name === value) || /^@shadow\/[A-Za-z][A-Za-z0-9_-]{0,255}$/.test(value),
  'Use a supported node: module or @shadow/<module-name>.',
)).max(32)

export function importedModules(imports: readonly string[]): string[] {
  return imports.filter(name => name.startsWith('@shadow/')).map(name => name.slice('@shadow/'.length))
}

export function assertImportPolicy(imports: readonly string[], allowedModules: readonly string[]): void {
  ScriptImportsSchema.parse(imports)
  ScriptImportsSchema.parse(allowedModules)
  if (new Set(imports).size !== imports.length) throw new Error('Duplicate script imports.')
  if (new Set(allowedModules).size !== allowedModules.length) throw new Error('Duplicate allowed modules.')
  for (const name of imports) {
    if (!allowedModules.includes(name)) throw new Error(`Module not allowed: ${name}`)
  }
}
