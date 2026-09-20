import { isAbsolute, join, relative, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { getBuiltinSkills } from './builtins.ts'
import { SkillsWatcher } from './watcher.ts'
import { SkillDisclosure } from './disclosure.ts'
import type { SkillToolDeclarations } from './tool-declarations.ts'

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
  /** Session-local tool declarations activated only by explicitly reading this skill. */
  tools?: SkillToolDeclarations
  /** Invalid declarations leave the instructions discoverable, but block activation. */
  toolsError?: string
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
  private removedDirectories = new Set<string>()
  private generation = 0
  private categories = new Map<string, CategoryInfo>()
  private workspaceDir: string
  private watcher: SkillsWatcher
  private readonly disclosure = new SkillDisclosure()

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
    this.skills = new Map([...skills].filter(([, skill]) => this.acceptSkill(skill)))
    this.generation++
  }

  setSkill(name: string, skill: Skill): void {
    if (!this.acceptSkill(skill)) return
    this.skills.set(name, skill)
    this.generation++
  }

  /** Lets asynchronous scans discard reads that raced a direct save or deletion. */
  get mutationGeneration(): number { return this.generation }

  private acceptSkill(skill: Skill): boolean {
    const directory = resolve(skill.dirPath)
    if (!this.removedDirectories.has(directory)) return true
    // A watcher read started before deletion must not resurrect its stale body.
    if (!existsSync(join(directory, 'SKILL.md'))) return false
    this.removedDirectories.delete(directory)
    return true
  }

  /** Invalidate by directory, including skills whose frontmatter name differs. */
  forgetSkillDirectory(directory: string): void {
    this.generation++
    const resolved = resolve(directory)
    this.removedDirectories.add(resolved)
    for (const [name, skill] of this.skills) {
      if (resolve(skill.dirPath) === resolved) this.skills.delete(name)
    }
  }

  /** Effective skills with authoritative provenance; workspace overrides win. */
  availableSkillSources(admin = false): Array<{
    skill: Skill
    source: 'project' | 'builtin'
    shadowsBuiltin: boolean
  }> {
    return this.availableSkills(admin).map(skill => ({
      skill,
      source: this.skills.get(skill.meta.name) === skill ? 'project' : 'builtin',
      shadowsBuiltin: this.skills.get(skill.meta.name) === skill && this.builtins.has(skill.meta.name),
    }))
  }

  removeSkill(name: string): void {
    this.skills.delete(name)
    this.generation++
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

  availableSkills(admin = false): Skill[] {
    return this.allSkills().filter(skill => !skill.meta.admin || admin)
  }

  getSkill(name: string, admin = false): Skill | undefined {
    const skill = this.resolveSkill(name)
    return skill && (!skill.meta.admin || admin) ? skill : undefined
  }

  // ── Level 1: Metadata (always in context) ─────────────────────────────

  /**
   * Get bounded core/recent metadata hints, with full catalog discovery guidance.
   * Passive disclosure does not record usage.
   */
  getMetadataSummary(admin?: boolean, sessionId?: string): string {
    return this.disclosure.summary(this.availableSkills(admin), sessionId)
  }

  /** Record only successful explicit exact skill reads/saves, never discovery. */
  markSkillUsed(name: string, sessionId?: string): void {
    const skill = this.resolveSkill(name)
    if (skill) this.disclosure.markSkillUsed(skill, sessionId)
  }

  // ── Level 2: Full body (on-demand) ────────────────────────────────────

  /**
   * Get the full markdown body of a skill by name.
   */
  getSkillBody(name: string): string | undefined {
    return this.resolveSkill(name)?.body
  }

  getSkillDirectory(name: string): string | undefined {
    return this.resolveSkill(name)?.dirPath
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
  getCategoryDetail(category: string, admin = false): string | undefined {
    const catSkills = this.allSkills()
      .filter((s) => s.meta.category === category && !s.isLearned && (!s.meta.admin || admin))

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
