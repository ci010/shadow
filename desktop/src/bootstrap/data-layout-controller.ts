export interface DataLayoutStatus {
  readonly status: 'ready' | 'migration-required' | 'blocked'
  readonly reason?: string
}
export interface DataLayoutProgress {
  readonly phase: string
  readonly completed?: number
  readonly total?: number
}
export interface DataLayoutView extends DataLayoutStatus {
  readonly dataDir: string
  readonly running: boolean
  readonly progress?: DataLayoutProgress
  readonly error?: string
}

/** Only an explicit operator action starts the offline mover. Detection is read-only. */
export class DataLayoutController {
  private view?: DataLayoutView
  private operation: Promise<DataLayoutView> | undefined
  constructor(
    private readonly detect: (root: string) => Promise<DataLayoutStatus>,
    private readonly run: (root: string, progress: (value: DataLayoutProgress) => void) => Promise<void>,
  ) {}
  async inspect(dataDir: string): Promise<DataLayoutView> {
    if (this.operation) return this.view!
    const result = await this.detect(dataDir)
    const error = result.status !== 'ready' && this.view?.dataDir === dataDir ? this.view.error : undefined
    return this.view = { ...result, dataDir, running: false, ...(error ? { error } : {}) }
  }
  current(): DataLayoutView | undefined { return this.view }
  start(): Promise<DataLayoutView> {
    if (this.operation) return this.operation
    const root = this.view?.dataDir
    if (!root) return Promise.reject(new Error('Inspect the selected data folder before upgrading'))
    this.operation = this.upgrade(root).finally(() => { this.operation = undefined })
    return this.operation
  }
  private async upgrade(root: string): Promise<DataLayoutView> {
    const detected = await this.detect(root)
    if (detected.status !== 'migration-required') {
      return this.view = { ...detected, dataDir: root, running: false }
    }
    this.view = { ...detected, dataDir: root, running: true, progress: { phase: 'Starting upgrade' } }
    try {
      await this.run(root, progress => { this.view = { ...this.view!, progress } })
      const result = await this.detect(root)
      if (result.status !== 'ready') throw new Error(result.reason ?? 'Upgrade did not produce a ready data layout')
      return this.view = { ...result, dataDir: root, running: false }
    } catch (error) {
      return this.view = { ...this.view!, running: false, error: error instanceof Error ? error.message : 'Upgrade failed' }
    }
  }
}
