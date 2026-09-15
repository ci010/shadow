import type { McpServerConfig } from '../config/schema.ts'
import { McpWatcher } from './watcher.ts'

export class McpManager {
  private watcher: McpWatcher
  private servers: McpServerConfig[]
  private initPromise: Promise<void> | null = null

  constructor(updateCatalog: (servers: McpServerConfig[]) => Promise<void>, servers: McpServerConfig[] = [], configPath?: string) {
    this.servers = servers
    this.watcher = new McpWatcher(updateCatalog, configPath)
  }

  async ensureLoaded(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.watcher.load(this.servers)
    }
    await this.initPromise
  }

  async load(servers: McpServerConfig[]): Promise<void> {
    await this.watcher.load(servers)
  }

  startWatching(): void {
    this.watcher.start()
  }

  async stopWatching(): Promise<void> {
    await this.watcher.stop()
  }
}
