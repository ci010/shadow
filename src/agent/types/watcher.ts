import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { AgentTypesManager } from './manager.ts'
import type { AgentTypeDefinition } from './types.ts'
import { parseAgentFile } from './parse.ts'
import { readFileIfExists } from '../../utils/paths.ts'
import { FsWatcher, watchFs } from '../../utils/fs-watcher.ts'

export class AgentTypesWatcher {
  private watcher: FsWatcher | null = null
  private watchTask: Promise<void> | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private changedPaths = new Set<string>()
  private reloadTask: Promise<void> = Promise.resolve()

  constructor(private manager: AgentTypesManager) {}

  async load(): Promise<void> {
    await this.reloadAll()
  }

  start(): void {
    if (this.watcher) return
    const paths = this.manager.watchPaths()
    try {
      this.watcher = watchFs(paths)
      this.watchTask = this.runWatchLoop(this.watcher)
      console.info('[agent-types-watcher] Watching for changes:', paths)
    } catch {
      // Directory may not exist yet — that's fine
    }
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
    this.changedPaths.clear()
    await this.reloadTask
  }

  private async runWatchLoop(watcher: FsWatcher): Promise<void> {
    try {
      for await (const event of watcher) {
        if (this.watcher !== watcher) break
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
      this.reloadTask = this.reloadTask.then(() => this.reloadChanged(paths))
    }, 300)
  }

  private async reloadChanged(changedPaths: Set<string>): Promise<void> {
    try {
      const agentsDir = this.manager.loadPaths().agentsDir
      const affected = new Set<string>()

      for (const p of changedPaths) {
        if (!p.startsWith(agentsDir)) continue
        const relative = p.slice(agentsDir.length + 1)
        const dirName = relative.split(/[/\\]/)[0]
        if (dirName && !dirName.startsWith('.')) {
          affected.add(dirName)
        }
      }

      if (affected.size === 0) return

      for (const name of affected) {
        const agentDir = join(agentsDir, name)
        const typeDef = await this.loadSingle(agentDir, name)
        if (typeDef) {
          this.manager.setWorkspaceType(typeDef.name, typeDef)
        } else {
          this.manager.removeWorkspaceType(name)
        }
      }

      console.info(
        `[agent-types-watcher] Reloaded ${affected.size} agent type(s): ${
          [...affected].join(', ')
        }`,
      )
    } catch (err) {
      console.error('[agent-types-watcher] Failed to reload agent types', err)
    }
  }

  private async reloadAll(): Promise<void> {
    try {
      const types = new Map<string, AgentTypeDefinition>()
      const { agentsDir } = this.manager.loadPaths()
      await this.scanDirectory(types, agentsDir)
      this.manager.replaceWorkspaceTypes(types)
      if (types.size > 0) {
        console.info(
          `[agent-types-watcher] Loaded ${types.size} workspace agent type(s)`,
        )
      }
    } catch {
      // agents/ dir may not exist — that's fine
    }
  }

  private async scanDirectory(
    types: Map<string, AgentTypeDefinition>,
    dir: string,
  ): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const agentDir = join(dir, entry)
      const info = await stat(agentDir).catch(() => null)
      if (!info?.isDirectory()) continue

      const typeDef = await this.loadSingle(agentDir, entry)
      if (typeDef) {
        types.set(typeDef.name, typeDef)
      }
    }
  }

  private async loadSingle(
    agentDir: string,
    fallbackName: string,
  ): Promise<AgentTypeDefinition | null> {
    const info = await stat(agentDir).catch(() => null)
    if (!info?.isDirectory()) return null

    const filePath = join(agentDir, 'AGENT.md')
    const content = await readFileIfExists(filePath)
    if (!content) return null

    return parseAgentFile(content, fallbackName, agentDir)
  }
}
