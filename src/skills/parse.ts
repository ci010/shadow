import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { LearnedSkillMeta, Skill, SkillMeta } from './loader.ts'
import { readFileIfExists } from '../utils/paths.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import { getArch, getOs } from '../utils/runtime.ts'

/**
 * Scan a directory of skill folders into a `name → Skill` map.
 *
 * Each immediate subdirectory containing a `SKILL.md` becomes one skill.
 * Dot-prefixed entries are ignored, and skills whose platform/arch restrictions
 * don't match the current host are skipped. Missing directories yield an empty
 * map rather than throwing.
 */
export async function scanSkillsDirectory(
  dir: string,
): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue

    const skillDir = join(dir, entry)
    const info = await stat(skillDir).catch(() => null)
    if (!info?.isDirectory()) continue

    const skill = await loadSingleSkill(skillDir, entry)
    if (skill) {
      skills.set(skill.meta.name, skill)
    }
  }
  return skills
}

/**
 * Load a single skill from its directory. Returns `null` when there is no
 * `SKILL.md` or the skill is restricted to other platforms/architectures.
 */
export async function loadSingleSkill(
  skillDir: string,
  fallbackName: string,
): Promise<Skill | null> {
  const info = await stat(skillDir).catch(() => null)
  if (!info?.isDirectory()) return null

  const skillFilePath = join(skillDir, 'SKILL.md')
  const content = await readFileIfExists(skillFilePath)
  if (!content) return null

  const { meta, body, learnedMeta } = parseSkillFile(content, fallbackName)

  const currentOs = getOs()
  if (meta.platform?.length && !meta.platform.includes(currentOs)) {
    console.debug(
      `[skills] Skipping skill "${meta.name}": platform ${currentOs} not in [${
        meta.platform.join(', ')
      }]`,
    )
    return null
  }
  const currentArch = getArch()
  if (meta.arch?.length && !meta.arch.includes(currentArch)) {
    console.debug(
      `[skills] Skipping skill "${meta.name}": arch ${currentArch} not in [${
        meta.arch.join(', ')
      }]`,
    )
    return null
  }

  const isLearned = learnedMeta !== undefined
  console.debug(`[skills] Loaded skill "${meta.name}" from ${skillFilePath}`)
  return { meta, body, dirPath: skillDir, isLearned, learnedMeta }
}

/**
 * Parse a SKILL.md file's YAML frontmatter and markdown body into metadata.
 * When no frontmatter is present, the directory name is used as a fallback
 * name and the leading text becomes the description.
 */
export function parseSkillFile(
  content: string,
  fallbackName: string,
): { meta: SkillMeta; body: string; learnedMeta?: LearnedSkillMeta } {
  const { frontmatter: fm, body } = parseFrontmatter(content)

  if (Object.keys(fm).length === 0) {
    return {
      meta: {
        name: fallbackName,
        description: content.replace(/\r\n/g, '\n').slice(0, 200),
      },
      body: content.replace(/\r\n/g, '\n'),
    }
  }

  const metadata =
    (fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata))
      ? fm.metadata as Record<string, unknown>
      : {}

  const str = (v: unknown): string => typeof v === 'string' ? v : ''
  const strList = (v: unknown): string[] | undefined => {
    if (Array.isArray(v)) return v.map(String)
    if (typeof v === 'string' && v) return v.split(',').map((t) => t.trim())
    return undefined
  }

  const meta: SkillMeta = {
    name: str(fm.name) || fallbackName,
    description: str(fm.description),
    platform: strList(fm.platform),
    arch: strList(fm.arch),
    admin: fm.admin === true,
    category: str(metadata.category || fm.category) || undefined,
    core: fm.core === true,
  }

  // Learned skill fields can be at top level or nested under metadata
  const related = str(metadata.related || fm.related)
  const learnedAt = str(metadata.learnedAt || fm.learnedAt)
  const version = typeof (metadata.version ?? fm.version) === 'number'
    ? (metadata.version ?? fm.version) as number
    : undefined
  const coauthor = str(metadata.coauthor || fm.coauthor) || undefined

  let learnedMeta: LearnedSkillMeta | undefined
  if (related || learnedAt) {
    learnedMeta = { ...meta, related, learnedAt, version, coauthor }
  }

  return { meta, body, learnedMeta }
}
