import type { McpServerConfig } from '../config/schema.ts'

export class McpManager {
  private pending: Promise<void> | null = null
  private initPromise: Promise<void> | null = null
  private stopping = false

  constructor(
    private readonly updateCatalog: (servers: McpServerConfig[]) => Promise<void>,
    private readonly servers: McpServerConfig[] = [],
  ) {}

  async ensureLoaded(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.load(this.servers)
    }
    await this.initPromise
  }

  async load(servers: McpServerConfig[]): Promise<void> {
    if (this.stopping) throw new Error('MCP manager is stopping')
    const snapshot = structuredClone(servers)
    const pending = (this.pending ?? Promise.resolve()).catch(() => {}).then(() => this.updateCatalog(snapshot))
    this.pending = pending
    this.initPromise = pending
    try { await pending }
    finally { if (this.pending === pending) this.pending = null }
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.pending
  }
}
