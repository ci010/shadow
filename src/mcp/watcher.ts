import type { McpServerConfig } from '../config/schema.ts'
import { loadConfig, resolveConfigPath } from '../config/loader.ts'
import { FsWatcher, watchFs } from '../utils/fs-watcher.ts'

export class McpWatcher {
  private watcher: FsWatcher | null = null
  private watchTask: Promise<void> | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private reloadPromise: Promise<void> | null = null
  private configPath: string | null = null
  private startTask?: Promise<void>
  private stopping = false

  constructor(
    private updateCatalog: (servers: McpServerConfig[]) => Promise<void>,
    private readonly scopedConfigPath?: string,
  ) {}

  async load(servers: McpServerConfig[]): Promise<void> {
    await this.reloadWithServers(servers)
  }

  start(): void {
    if (this.watcher) return
    this.stopping = false
    this.startTask = this.startWatchingConfig().catch(error => console.error('[mcp-watcher] Cannot watch configuration', error))
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.startTask
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
    await this.reloadPromise
  }

  private async runWatchLoop(watcher: FsWatcher): Promise<void> {
    try {
      for await (const _event of watcher) {
        this.scheduleReload()
      }
    } catch (error) {
      if (!this.stopping) console.error('[mcp-watcher] Configuration watch failed', error)
    }
  }

  private scheduleReload(): void {
    if (this.stopping) return
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      void this.reloadFromConfig()
    }, 500)
  }

  private async reloadFromConfig(): Promise<void> {
    try {
      const config = await loadConfig(this.configPath ?? undefined)
      if (this.stopping) return
      await this.reloadWithServers(config.mcp.servers)
    } catch (error) { console.error('[mcp-watcher] Cannot reload configuration', error) }
  }

  private async startWatchingConfig(): Promise<void> {
    this.configPath = this.scopedConfigPath ?? await resolveConfigPath()
    if (!this.configPath || this.watcher || this.stopping) return

    this.watcher = watchFs(this.configPath)
    this.watchTask = this.runWatchLoop(this.watcher)
    console.info(
      `[mcp-watcher] Watching bot config for MCP changes: ${this.configPath}`,
    )
  }

  private async reloadWithServers(servers: McpServerConfig[]): Promise<void> {
    // A later update must still run after a failed update, without dropping it.
    const pending = (this.reloadPromise ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.updateCatalog(servers))
    this.reloadPromise = pending
    try {
      await pending
    } finally {
      if (this.reloadPromise === pending) this.reloadPromise = null
    }
  }
}
