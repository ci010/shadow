import { isDeepStrictEqual } from 'node:util'
import { parseDocument, stringify } from 'yaml'
import { z, ZodError } from 'zod'
import { ResourceName } from '../execution/grant-contract.ts'
import { parseBot, type BotDefinition } from './sdk.ts'

/** Pure development-source conversion, never publication or storage migration.
 * Callers must compare source with the active revision, back up outside the
 * package, and publish through the owning Project's exact-content confirmation.
 * Raw JSON values are retained: no schema defaults, subscriptions or grants are
 * materialized. Already-modern packages are byte-identical and mixed ones fail.
 */
export function migrateBotFrontmatter(files: Record<string, string>): Record<string, string> {
  const before = parseBot(files)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(files['BOT.md']!)!
  const header = parseDocument(match[1]!, { uniqueKeys: true }).toJS({ maxAliasCount: 0 }) as Record<string, unknown>
  if (Object.hasOwn(header, 'mode')) return { ...files }
  const configPath = header.config as string
  const config = JSON.parse(files[configPath]!) as Record<string, unknown>
  const keys = before.mode === 'service'
    ? ['mode', 'model', 'temperature', 'maxTokens', 'thinking', 'reasoningEffort']
    : ['mode', 'agent']
  for (const key of keys) {
    if (Object.hasOwn(config, key)) { header[key] = config[key]; delete config[key] }
  }
  const eol = files['BOT.md']!.startsWith('---\r\n') ? '\r\n' : '\n'
  const jsonEol = files[configPath]!.includes('\r\n') ? '\r\n' : '\n'
  const next = {
    ...files,
    'BOT.md': `---${eol}${stringify(header).replace(/\n/g, eol)}---${eol}${match[2]}`,
    [configPath]: JSON.stringify(config, null, 2).replace(/\n/g, jsonEol) + jsonEol,
  }
  if (!isDeepStrictEqual(parseBot(next), before)) throw new Error('BOT format conversion changed semantics')
  return next
}

/** Narrow audit baseline for an owner proposal repairing retired QQ/Feishu skill
 * selectors. Never used by runtime parsing and never writes the active package.
 * Any other error, malformed selector or missing top-level prompt fails closed.
 */
export function botProposalBaseline(files: Record<string, string>): {
  bot: BotDefinition; removedBindingSkills: Array<{ index: number; names: string[] }>
} {
  try { return { bot: parseBot(files), removedBindingSkills: [] } } catch (error) {
    if (!(error instanceof ZodError) || !error.issues.length || !error.issues.every(issue =>
      issue.code === 'unrecognized_keys' && issue.keys.length === 1 && issue.keys[0] === 'skills' &&
      issue.path.length === 2 && issue.path[0] === 'bindings' && Number.isInteger(issue.path[1]))) throw error
    // The first strict parse established a valid header and JSON object. Only
    // binding selector keys failed. Clone JSON, remove exactly those keys, then
    // require the ordinary strict parser to validate the entire result again.
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(files['BOT.md']!)!
    const header = parseDocument(match[1]!, { uniqueKeys: true }).toJS({ maxAliasCount: 0 }) as { config: string }
    const config = JSON.parse(files[header.config]!)
    const removedBindingSkills = error.issues.map(issue => {
      const index = issue.path[1] as number, binding = config.bindings[index]
      if (!['qq', 'feishu'].includes(binding.platform)) throw error
      const names = z.array(ResourceName).max(32).parse(binding.skills)
      if (names.some(name => !config.skills?.some((skill: { name: string }) => skill.name === name))) throw error
      delete binding.skills
      return { index, names }
    })
    return { bot: parseBot({ ...files, [header.config]: JSON.stringify(config) }), removedBindingSkills }
  }
}
