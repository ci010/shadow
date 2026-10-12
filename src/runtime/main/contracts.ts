export interface MainRuntimeHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

export interface MainRuntimeOptions {
  /** Canonical app data root; direct callers default to agent.workspace. */
  readonly dataDir?: string
  /** Agent host execution; omitted preserves legacy standalone behavior. */
  readonly localExecutor?: boolean
  readonly localNodeId?: string
  readonly configPath?: string
  readonly clusterSnapshotPath?: string
  readonly gateway?: {
    readonly port?: number
    readonly host?: string
    readonly launchCredential?: string
    readonly browserPinHash?: string
  }
}
