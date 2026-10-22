import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Skill } from './loader.ts'
import { scanSkillsDirectory } from './parse.ts'

/**
 * Built-in skills ship with the application source under `src/skills/builtin/`.
 * They are always available regardless of workspace, and can be shadowed by a
 * workspace skill of the same name.
 */
const BUILTIN_SKILLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  './builtin',
)

/** Load all skills bundled with the application. */
export function getBuiltinSkills(): Promise<Map<string, Skill>> {
  return scanSkillsDirectory(BUILTIN_SKILLS_DIR)
}
