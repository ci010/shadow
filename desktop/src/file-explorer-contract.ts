export const FILE_EXPLORER_CHANNEL = 'shadow:files:show-in-folder'

export interface DesktopFileExplorerApi {
  showInFolder(path: string): Promise<void>
  attachment(proof: unknown, reveal?: boolean): Promise<boolean>
}

export function createFileExplorerApi(ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }): DesktopFileExplorerApi {
  return Object.freeze({
    async attachment(proof: unknown, reveal = false): Promise<boolean> {
      return await ipc.invoke(FILE_EXPLORER_CHANNEL, { proof, reveal }) === true
    },
    async showInFolder(path: string): Promise<void> {
      await ipc.invoke(FILE_EXPLORER_CHANNEL, path)
    },
  })
}
