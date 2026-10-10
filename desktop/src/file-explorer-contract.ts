export const FILE_EXPLORER_CHANNEL = 'shadow:files:show-in-folder'

export interface DesktopFileExplorerApi {
  showInFolder(path: string): Promise<void>
}

export function createFileExplorerApi(ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }): DesktopFileExplorerApi {
  return Object.freeze({
    async showInFolder(path: string): Promise<void> {
      await ipc.invoke(FILE_EXPLORER_CHANNEL, path)
    },
  })
}
