import { isAbsolute, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'

export const SkillToolNameSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_-]*$/,
  'Tool names must start with a letter and contain only letters, digits, underscores or hyphens',
).refine(name => !name.includes('__'), 'Skill tool names must not contain the "__" MCP namespace delimiter')

export const SkillToolDeclarationSchema = z.object({
  source: z.string().refine(
    source => !isAbsolute(source) && !/^[A-Za-z]:/.test(source) && source.toLowerCase().endsWith('.ts'),
    'Skill TypeScript sources must be relative .ts paths inside the skill directory',
  ),
  args: z.array(z.string()).optional(),
}).strict()

export const SkillToolDeclarationsSchema = z.record(SkillToolNameSchema, SkillToolDeclarationSchema)
export type SkillToolDeclaration = z.infer<typeof SkillToolDeclarationSchema>
export type SkillToolDeclarations = z.infer<typeof SkillToolDeclarationsSchema>

export type SkillDirectoryResolver = (skill: string) => string | undefined

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\')
}

/** Verifies entrypoint ownership, not the behavior or imports of executable code. */
export async function resolveSkillToolSource(
  skill: string,
  source: string,
  getSkillDirectory: SkillDirectoryResolver,
): Promise<string> {
  const directory = getSkillDirectory(skill)
  if (!directory) throw new TypeError(`Skill "${skill}" was not found; create or discover its SKILL.md first`)
  const root = resolve(directory)
  const path = resolve(root, source)
  if (!path.toLowerCase().endsWith('.ts') || !isWithin(root, path)) {
    throw new TypeError('TypeScript entrypoints must be .ts files inside their owning skill directory')
  }
  const [realRoot, realSource, realManifest] = await Promise.all([
    realpath(root), realpath(path), realpath(resolve(root, 'SKILL.md')),
  ])
  if (!isWithin(realRoot, realSource) || !isWithin(realRoot, realManifest)) {
    throw new TypeError('Skill entrypoints and SKILL.md must not escape their owner through symlinks')
  }
  const [moduleStat, manifestStat] = await Promise.all([stat(realSource), stat(realManifest)])
  if (!moduleStat.isFile() || !manifestStat.isFile()) throw new TypeError('Skill tool source and SKILL.md must be regular files')
  return path
}
