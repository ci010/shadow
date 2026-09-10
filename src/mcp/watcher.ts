import type { McpServerConfig } from '../config/schema.ts'
import type { Tools } from '../tools/registry.ts'
import { loadConfig, resolveConfigPath } from '../config/loader.ts'
import { McpConnection } from './client.ts'
import { registerMcpTools } from './adapter.ts'
import { FsWatcher, watchFs } from '../utils/fs-watcher.ts'
import type { McpManager } from './manager.ts'

export class McpWatcher {
  private watcher: FsWatcher | null = null
  private watchTask: Promise<void> | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private reloadPromise: Promise<void> | null = null
  private configPath: string | null = null

  constructor(
    private manager: McpManager,
    private registry: Tools,
    private workspace?: string,
  ) {}

  async load(servers: McpServerConfig[]): Promise<void> {
    await this.reloadWithServers(servers)
  }

  start(): void {
    if (this.watcher) return
    this.startWatchingConfig()
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
    await this.disconnectAll()
    this.unregisterTools()
  }

  private async runWatchLoop(watcher: FsWatcher): Promise<void> {
    try {
      for await (const _event of watcher) {
        this.scheduleReload()
      }
    } catch {}
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      void this.reloadFromConfig()
    }, 500)
  }

  private async reloadFromConfig(): Promise<void> {
    await this.runReload(async () => {
      const config = await loadConfig(this.configPath ?? undefined)
      await this.reloadWithServers(config.mcp.servers)
    })
  }

  private async startWatchingConfig(): Promise<void> {
    this.configPath = await resolveConfigPath()
    if (!this.configPath || this.watcher) return

    this.watcher = watchFs(this.configPath)
    this.watchTask = this.runWatchLoop(this.watcher)
    console.info(
      `[mcp-watcher] Watching bot config for MCP changes: ${this.configPath}`,
    )
  }

  private async reloadWithServers(servers: McpServerConfig[]): Promise<void> {
    await this.runReload(async () => {
      this.unregisterTools()
      await this.disconnectAll()

      if (servers.length === 0) {
        return
      }

      console.log(`[mcp-watcher] Loading MCP servers: ${servers.map((s) => s.name).join(', ')}`)

      const connections: McpConnection[] = []
      for (const cfg of servers) {
        const conn = new McpConnection(cfg, this.workspace)
        try {
          await conn.connect()
          connections.push(conn)
        } catch (err) {
          console.error(
            `[mcp-watcher] Failed to connect MCP server: ${cfg.name}`,
            err,
          )
        }
      }

      this.manager.setConnections(connections)
      const toolNames = await registerMcpTools(
        this.manager.connectionsList(),
        this.registry,
      )
      this.manager.setToolNames(toolNames)
      console.info('[mcp-watcher] Reloaded MCP servers')
    })
  }

  private async runReload(action: () => Promise<void>): Promise<void> {
    if (this.reloadPromise) {
      await this.reloadPromise
      return
    }

    this.reloadPromise = (async () => {
      try {
        await action()
      } catch (err) {
        console.error('[mcp-watcher] Failed to reload MCP servers', err)
      } finally {
        this.reloadPromise = null
      }
    })()

    await this.reloadPromise
  }

  private unregisterTools(): void {
    const names = this.manager.toolNamesList()
    if (names.length === 0) return
    for (const name of names) {
      this.registry.unregister(name)
    }
    this.manager.clearToolNames()
  }

  private async disconnectAll(): Promise<void> {
    const connections = this.manager.connectionsList()
    for (const conn of connections) {
      await conn.disconnect().catch(() => {})
    }
    this.manager.clearConnections()
  }
}
