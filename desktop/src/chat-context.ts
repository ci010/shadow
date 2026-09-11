import { IPC_CHANNELS, type ShadowDesktopApi } from './ipc-contract.js'
import type { WindowControlsIpc, WindowControlTarget } from './window-controls.js'

type ContextWindow = Pick<WindowControlTarget, 'isDestroyed' | 'once' | 'removeListener'> & {
  readonly webContents: Pick<WindowControlTarget['webContents'], 'mainFrame' | 'isDestroyed'>
}

function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new TypeError('Chat context selection is invalid')
  }
  const paths: string[] = []
  for (const path of value) {
    if (
      typeof path !== 'string'
      || path.length === 0
      || path.length > 10_000
      || /[\u0000-\u001f\u007f-\u009f]/.test(path)
      || !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/i.test(path)
    ) {
      throw new TypeError('Chat context selection is invalid')
    }
    paths.push(path)
  }
  return paths
}

export function createChatContextApi(
  ipc: { invoke(channel: string): Promise<unknown> },
): ShadowDesktopApi['chatContext'] {
  return Object.freeze({
    selectFiles: async () => parsePaths(await ipc.invoke(IPC_CHANNELS.selectChatContextFiles)),
    selectFolders: async () => parsePaths(await ipc.invoke(IPC_CHANNELS.selectChatContextFolders)),
  })
}

export function installChatContextPickers(
  ipc: WindowControlsIpc,
  window: ContextWindow,
  pick: ShadowDesktopApi['chatContext'],
): () => void {
  let disposed = false
  const unavailable = () => disposed || window.isDestroyed() || window.webContents.isDestroyed()
  const pending = new Map<string, Promise<string[]>>()
  let queue: Promise<unknown> = Promise.resolve()
  const commands = {
    [IPC_CHANNELS.selectChatContextFiles]: pick.selectFiles,
    [IPC_CHANNELS.selectChatContextFolders]: pick.selectFolders,
  }
  for (const [channel, command] of Object.entries(commands)) {
    ipc.handle(channel, (event, ...args) => {
      if (
        unavailable()
        || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
      ) {
        throw new TypeError('Chat context selection requires the Main window')
      }
      if (args.length !== 0) throw new TypeError('Chat context selection accepts no arguments')
      const existing = pending.get(channel)
      if (existing) return existing
      // Coalesce repeated requests and serialize file/folder dialogs on the same window.
      const result = queue.then(async () => {
        if (unavailable()) return []
        try {
          const paths = await command()
          return unavailable() ? [] : parsePaths(paths)
        } catch (error) {
          if (unavailable()) return []
          throw error
        }
      }).finally(() => { pending.delete(channel) })
      pending.set(channel, result)
      queue = result.catch(() => {})
      return result
    })
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const channel of Object.keys(commands)) ipc.removeHandler(channel)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
