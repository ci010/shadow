import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import { FILE_EXPLORER_CHANNEL } from './file-explorer-contract.js'
import { isTrustedMediaUrl } from './media-permissions.js'
import type { RendererTarget } from './renderer-target.js'

export function installFileExplorer(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  window: BrowserWindow,
  target: RendererTarget,
  show: (path: string) => void,
): () => void {
  let disposed = false
  const trusted = (event: Electron.IpcMainInvokeEvent) => !disposed && !window.isDestroyed()
    && !window.webContents.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isTrustedMediaUrl(window.webContents.mainFrame.url, target)
  ipc.handle(FILE_EXPLORER_CHANNEL, async (event, ...args: unknown[]) => {
    if (!trusted(event)) throw new TypeError('File explorer requires the trusted Main window')
    const path = args[0]
    if (args.length !== 1 || typeof path !== 'string' || path.length > 32_768
      || path.includes('\0') || !isAbsolute(path)) throw new TypeError('Invalid file explorer path')
    await stat(path)
    if (!trusted(event)) throw new TypeError('File explorer window is no longer available')
    show(path)
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    ipc.removeHandler(FILE_EXPLORER_CHANNEL)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
