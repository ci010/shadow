import { isAbsolute, join, relative, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { getBuiltinSkills } from './builtins.ts'
import { SkillsWatcher } from './watcher.ts'

/**
 * Skill metadata parsed from YAML frontmatter.
 */
export interface SkillMeta {
  name: string
  description: string
  /** Restrict skill to specific OS platforms (e.g. ["windows", "linux", "darwin"]). Empty / absent = no restriction. */
  platform?: string[]
  /** Restrict skill to specific CPU architectures (e.g. ["x86_64", "aarch64"]). Empty / absent = no restriction. */
  arch?: string[]
  /** When true, skill is only visible to admin sessions. */
  admin?: boolean
  /** Category grouping for prompt display (e.g. "platform", "conversion"). */
  category?: string
  /** When true, skill is listed inline in prompt instead of grouped by category. */
  core?: boolean
}

/**
 * Category description loaded from `.categories.yaml`.
 */
export interface CategoryInfo {
  description: string
}

/**
 * Extended metadata for learned/rephrased skills.
 * These are skills the local AI has internalized through real execution trails.
 */
export interface LearnedSkillMeta extends SkillMeta {
  /** Related skill names (comma-separated) this learning is based on */
  related: string
  /** ISO timestamp when skill was learned */
  learnedAt: string
  /** Version number for iterative learning */
  version?: number
  /** Identity profile name of who co-authored/taught this skill */
  coauthor?: string
}

/**
 * A loaded skill at various levels of detail.
 */
export interface Skill {
  meta: SkillMeta
  /** Full markdown body (level 2) */
  body: string
  /** Directory containing the SKILL.md */
  dirPath: string
  /** Whether this is a learned/internalized skill */
  isLearned?: boolean
  /** Extended metadata for learned skills */
  learnedMeta?: LearnedSkillMeta
}

/**
 * Three-level progressive skill loading:
 *
 * 1. **Metadata** — name + short description (~100 words). Always in context.
 * 2. **Full body** — full SKILL.md markdown. Loaded when skill is triggered.
 * 3. **Bundled resources** — referenced files in skill directory. Loaded on demand.
 *
 * All skills (both generic and learned) are discovered from `<workspace>/skills/`.
 * A skill is considered "learned" when its frontmatter contains a `related` or
 * `learnedAt` field, indicating it was derived from real execution experience.
 */
export class SkillsManager {
  /** Workspace skills discovered under `<workspace>/skills/` (watched, mutable). */
  private skills = new Map<string, Skill>()
  /** Built-in skills bundled with the app under `src/skills/builtin/` (immutable). */
  private builtins = new Map<string, Skill>()
  private categories = new Map<string, CategoryInfo>()
  private workspaceDir: string
  private watcher: SkillsWatcher

  constructor(workspace: string) {
    this.workspaceDir = workspacePath(workspace, 'skills')
    this.watcher = new SkillsWatcher(this)
  }

  async load(): Promise<void> {
    this.builtins = await getBuiltinSkills()
    await this.watcher.load()
  }

  startWatching(): void {
    this.watcher.start()
  }

  async stopWatching(): Promise<void> {
    await this.watcher.stop()
  }

  watchPaths(): string[] {
    return [this.workspaceDir]
  }

  loadPaths(): { workspaceDir: string } {
    return { workspaceDir: this.workspaceDir }
  }

  replaceSkills(skills: Map<string, Skill>): void {
    this.skills = skills
  }

  setSkill(name: string, skill: Skill): void {
    this.skills.set(name, skill)
  }

  removeSkill(name: string): void {
    this.skills.delete(name)
  }

  replaceCategories(categories: Map<string, CategoryInfo>): void {
    this.categories = categories
  }

  // ── Builtin / workspace resolution ────────────────────────────────────

  /**
   * Resolve a single skill by name. Workspace skills shadow built-ins of the
   * same name.
   */
  private resolveSkill(name: string): Skill | undefined {
    return this.skills.get(name) ?? this.builtins.get(name)
  }

  /**
   * All available skills, with workspace skills shadowing built-ins that share
   * the same name.
   */
  private allSkills(): Skill[] {
    const merged = new Map<string, Skill>()
    for (const [k, v] of this.builtins) merged.set(k, v)
    for (const [k, v] of this.skills) merged.set(k, v)
    return [...merged.values()]
  }

  // ── Level 1: Metadata (always in context) ─────────────────────────────

  /**
   * Get compact metadata summaries for all discovered skills.
   * Learned skills are marked with a [learned] indicator.
   */
  getMetadataSummary(admin?: boolean): string {
    const entries = this.allSkills()
      .filter((s) => !s.meta.admin || admin)
    if (entries.length === 0) return ''

    const skills = entries.filter((s) => !s.isLearned)

    const shortDesc = (desc: string): string => {
      const firstSentence = desc.match(/^.+?[.!?。！？](?=\s|$)/)
      return firstSentence ? firstSentence[0] : desc.slice(0, 120)
    }

    // Partition: core, categorized non-core, uncategorized non-core
    const coreSkills = skills.filter((s) => s.meta.core)
    const nonCore = skills.filter((s) => !s.meta.core)
    const categorized = nonCore.filter((s) => s.meta.category)
    const uncategorized = nonCore.filter((s) => !s.meta.category)

    // Group categorized by category name
    const byCategory = new Map<string, Skill[]>()
    for (const s of categorized) {
      const cat = s.meta.category!
      if (!byCategory.has(cat)) byCategory.set(cat, [])
      byCategory.get(cat)!.push(s)
    }

    const lines: string[] = []

    // Core skills inline
    for (const s of coreSkills) {
      lines.push(
        `  <skill name="${s.meta.name}">${shortDesc(s.meta.description)}</skill>`,
      )
    }

    // Category groups
    for (const [catName, catSkills] of byCategory) {
      const catInfo = this.categories.get(catName)
      const catDesc = catInfo?.description ?? catName
      const skillNames = catSkills.map((s) => s.meta.name).join(', ')
      lines.push(
        `  <category name="${catName}" count="${catSkills.length}" skills="${skillNames}">${catDesc}</category>`,
      )
    }

    // Uncategorized fallback — listed inline
    for (const s of uncategorized) {
      lines.push(
        `  <skill name="${s.meta.name}">${shortDesc(s.meta.description)}</skill>`,
      )
    }

    if (lines.length === 0) return ''

    const usage = [
      '## Skills',
      '',
      'Skills are reusable capabilities — they describe *how* to do something (format, conventions, workflows).',
      'Skills are loaded via `read("v:skills/<name>")`, not via `import_tool`. Unlike tools, skills don\'t execute — they inform.',
      '- read("v:skills/<name>") to load a skill body',
      '- read("v:skills/<category>") to read skills in a category',
      '- read("v:skills/<name>/<path>") for bundled resources',
    ].join('\n')

    return `${usage}\n<available_skills>\n${lines.join('\n')}\n</available_skills>`
  }

  // ── Level 2: Full body (on-demand) ────────────────────────────────────

  /**
   * Get the full markdown body of a skill by name.
   */
  getSkillBody(name: string): string | undefined {
    return this.resolveSkill(name)?.body
  }

  // ── Level 3: Bundled resources (on-demand) ────────────────────────────

  /**
   * Read a bundled resource file from a skill's directory.
   */
  async getSkillResource(
    skillName: string,
    resourcePath: string,
  ): Promise<string | undefined> {
    const skill = this.resolveSkill(skillName)
    if (!skill) return undefined
    const fullPath = resolve(skill.dirPath, resourcePath)
    const within = relative(skill.dirPath, fullPath)
    if (isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) {
      throw new TypeError('Skill resource must remain inside its skill directory')
    }
    return await readFileIfExists(fullPath)
  }

  /** All discovered skill names (workspace + builtin, deduped). */
  skillNames(): string[] {
    return [...new Set([...this.builtins.keys(), ...this.skills.keys()])]
  }

  /**
   * Return all skill names + descriptions for a given category.
   * Used by virtual fs mount so the agent can `read("v:skills/browser")`.
   */
  getCategoryDetail(category: string): string | undefined {
    const catSkills = this.allSkills()
      .filter((s) => s.meta.category === category && !s.isLearned)

    if (catSkills.length === 0) return undefined

    const catInfo = this.categories.get(category)
    const desc = catInfo ? ` description="${catInfo.description}"` : ''
    const skillLines = catSkills.map((s) =>
      `  <skill name="${s.meta.name}">${s.meta.description}</skill>`
    )

    return `<category name="${category}"${desc}>\n${skillLines.join('\n')}\n</category>`
  }

  /**
   * List all known category names.
   */
  getCategoryNames(): string[] {
    const cats = new Set<string>()
    for (const s of this.allSkills()) {
      if (s.meta.category && !s.isLearned) cats.add(s.meta.category)
    }
    return [...cats].sort()
  }

  // ── Learned Skills Management ─────────────────────────────────────────

  /**
   * Get the original (non-learned) skill body for reference during learning.
   * Prefers a workspace skill, then falls back to a built-in of the same name.
   * Returns undefined if no original skill exists.
   */
  async getOriginalSkillBody(skillName: string): Promise<string | undefined> {
    const skillPath = join(this.getLearnedSkillPath(skillName), 'SKILL.md')
    const workspaceBody = await readFileIfExists(skillPath)
    if (workspaceBody !== undefined) return workspaceBody
    return this.builtins.get(skillName)?.body
  }

  /**
   * Get all learned skills.
   */
  getLearnedSkills(): Skill[] {
    return this.allSkills().filter((s) => s.isLearned)
  }

  /**
   * Get the skill directory path for a skill name.
   */
  getLearnedSkillPath(skillName: string): string {
    if (!skillName.trim() || skillName === '.' || skillName === '..' || /[/\\:\0]/.test(skillName)) {
      throw new TypeError('Skill name must be a single directory name')
    }
    return join(this.workspaceDir, skillName)
  }

  /**
   * Save a learned skill into the skills directory. Creates the directory
   * structure and SKILL.md file.
   *
   * @param skillName - Name of the skill being learned
   * @param content - The full SKILL.md content including frontmatter
   */
  async saveLearnedSkill(skillName: string, content: string): Promise<void> {
    const skillDir = this.getLearnedSkillPath(skillName)
    await mkdir(skillDir, { recursive: true })
    const skillFile = join(skillDir, 'SKILL.md')
    await writeFile(skillFile, content)
    console.info(`[skills-loader] Saved learned skill: ${skillName}`)
  }

  /**
   * Generate the frontmatter string for a learned skill.
   */
  generateLearnedFrontmatter(meta: LearnedSkillMeta): string {
    const lines = [
      '---',
      `name: ${meta.name}`,
      `description: ${meta.description}`,
      'metadata:',
      `  related: ${meta.related}`,
      `  learnedAt: ${meta.learnedAt}`,
    ]
    if (meta.version !== undefined) lines.push(`  version: ${meta.version}`)
    if (meta.coauthor) lines.push(`  coauthor: ${meta.coauthor}`)
    lines.push('---')
    return lines.join('\n')
  }
}
