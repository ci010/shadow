export interface MainRuntimeHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

export interface MainRuntimeOptions {
  readonly localNodeId?: string
  readonly configPath?: string
  readonly clusterSnapshotPath?: string
  readonly gateway?: {
    readonly port?: number
    readonly host?: string
    readonly launchCredential?: string
  }
}
