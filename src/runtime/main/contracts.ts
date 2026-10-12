export interface MainRuntimeHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

export interface MainRuntimeOptions {
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
