export interface DuplexCloseInfo {
  code: string
  reason: string
  clean: boolean
}

export interface NodeMessageDuplex {
  readonly incoming: AsyncIterable<unknown>
  readonly closed: Promise<DuplexCloseInfo>
  send(message: unknown): Promise<void>
  close(info: DuplexCloseInfo): Promise<void>
}
