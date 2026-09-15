import type { McpServerConfig } from '../config/schema.ts'
import type { Tools } from '../tools/registry.ts'
import type { McpConnection } from './client.ts'
import { McpWatcher } from './watcher.ts'

export class McpManager {
  private connections = new Map<string, McpConnection>()
  private toolNames: string[] = []
  private watcher: McpWatcher
  private servers: McpServerConfig[]
  private initPromise: Promise<void> | null = null

  constructor(registry: Tools, servers: McpServerConfig[] = [], workspace = '.', configPath?: string) {
    this.servers = servers
    this.watcher = new McpWatcher(this, registry, workspace, configPath)
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

  setConnections(connections: McpConnection[]): void {
    this.connections.clear()
    for (const conn of connections) {
      this.connections.set(conn.config.name, conn)
    }
  }

  connectionsList(): McpConnection[] {
    return Array.from(this.connections.values())
  }

  getConnection(name: string): McpConnection | undefined {
    return this.connections.get(name)
  }

  clearConnections(): void {
    this.connections.clear()
  }

  toolNamesList(): string[] {
    return this.toolNames
  }

  setToolNames(names: string[]): void {
    this.toolNames = names
  }

  clearToolNames(): void {
    this.toolNames = []
  }
}
