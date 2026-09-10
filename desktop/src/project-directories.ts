import { IPC_CHANNELS, type ShadowDesktopApi } from './ipc-contract.js'
import type { WindowControlsIpc, WindowControlTarget } from './window-controls.js'

type DirectoryWindow = Pick<WindowControlTarget, 'isDestroyed' | 'once' | 'removeListener'> & {
  readonly webContents: Pick<WindowControlTarget['webContents'], 'mainFrame' | 'isDestroyed'>
}

function parseDirectory(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 10_000
    || /[\u0000-\u001f\u007f]/.test(value)
    || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)
  ) {
    throw new TypeError('Project directory selection is invalid')
  }
  return value
}

export function createProjectDirectoriesApi(
  ipc: { invoke(channel: string): Promise<unknown> },
): ShadowDesktopApi['projects'] {
  return Object.freeze({
    selectDirectory: async () => parseDirectory(await ipc.invoke(IPC_CHANNELS.selectProjectDirectory)),
  })
}

export function installProjectDirectoryPicker(
  ipc: WindowControlsIpc,
  window: DirectoryWindow,
  pick: () => Promise<string | null>,
): () => void {
  let disposed = false
  let pending: Promise<string | null> | undefined
  ipc.handle(IPC_CHANNELS.selectProjectDirectory, (event, ...args) => {
    if (
      disposed
      || window.isDestroyed()
      || window.webContents.isDestroyed()
      || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new TypeError('Project folder selection requires the Main window')
    }
    if (args.length !== 0) throw new TypeError('Project folder selection accepts no arguments')
    pending ??= Promise.resolve().then(pick).then((path) => {
      if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return null
      return parseDirectory(path)
    }).finally(() => { pending = undefined })
    return pending
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    ipc.removeHandler(IPC_CHANNELS.selectProjectDirectory)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
