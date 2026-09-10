import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { CategoryInfo, SkillsManager } from './loader.ts'
import { loadSingleSkill, scanSkillsDirectory } from './parse.ts'
import { readFileIfExists } from '../utils/paths.ts'
import { FsWatcher, watchFs } from '../utils/fs-watcher.ts'

export class SkillsWatcher {
  private watcher: FsWatcher | null = null
  private watchTask: Promise<void> | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private changedPaths = new Set<string>()

  constructor(private skills: SkillsManager) {}

  async load(): Promise<void> {
    await this.reloadSkills()
  }

  start(): void {
    if (this.watcher) return
    const paths = this.skills.watchPaths()
    this.watcher = watchFs(paths)
    this.watchTask = this.runWatchLoop(this.watcher)
    console.info('[skills-watcher] Watching skills for changes:', paths)
  }

  async stop(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.watchTask) {
      await this.watchTask.catch(() => {})
      this.watchTask = null
    }
  }

  private async runWatchLoop(watcher: FsWatcher): Promise<void> {
    try {
      for await (const event of watcher) {
        for (const path of event.paths) {
          this.changedPaths.add(path)
        }
        this.scheduleReload()
      }
    } catch {
      return
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      const paths = new Set(this.changedPaths)
      this.changedPaths.clear()
      void this.reloadChangedSkills(paths)
    }, 300)
  }

  private async reloadChangedSkills(changedPaths: Set<string>): Promise<void> {
    try {
      const { workspaceDir } = this.skills.loadPaths()
      const affectedSkills = new Set<string>()

      for (const p of changedPaths) {
        if (!p.startsWith(workspaceDir)) continue
        const relative = p.slice(workspaceDir.length + 1)
        const skillDirName = relative.split(/[/\\]/)[0]

        // Reload category descriptions when .categories.yaml changes
        if (skillDirName === '.categories.yaml') {
          const categories = await this.loadCategories()
          this.skills.replaceCategories(categories)
          continue
        }

        if (skillDirName && !skillDirName.startsWith('.')) {
          affectedSkills.add(skillDirName)
        }
      }

      if (affectedSkills.size === 0) return

      for (const name of affectedSkills) {
        const skillDir = join(workspaceDir, name)
        const skill = await loadSingleSkill(skillDir, name)
        if (skill) {
          this.skills.setSkill(skill.meta.name, skill)
        } else {
          this.skills.removeSkill(name)
        }
      }

      console.info(
        `[skills-watcher] Reloaded ${affectedSkills.size} skill(s): ${
          [...affectedSkills].join(', ')
        }`,
      )
    } catch (err) {
      console.error('[skills-watcher] Failed to reload skills', err)
    }
  }

  private async reloadSkills(): Promise<void> {
    try {
      const { workspaceDir } = this.skills.loadPaths()
      const skills = await scanSkillsDirectory(workspaceDir)
      this.skills.replaceSkills(skills)
      // Load category descriptions
      const categories = await this.loadCategories()
      this.skills.replaceCategories(categories)
      console.info('[skills-watcher] Reloaded skills')
    } catch (err) {
      console.error('[skills-watcher] Failed to reload skills', err)
    }
  }

  /**
   * Parse `.categories.yaml`.
   */
  private async loadCategories(): Promise<Map<string, CategoryInfo>> {
    const { workspaceDir } = this.skills.loadPaths()
    const filePath = join(workspaceDir, '.categories.yaml')
    const content = await readFileIfExists(filePath)
    if (!content) return new Map()

    const raw = parseYaml(content)
    const categories = new Map<string, CategoryInfo>()
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof val === 'string') {
          categories.set(key, { description: val })
        }
      }
    }
    return categories
  }
}
