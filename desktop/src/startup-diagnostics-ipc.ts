import { IPC_CHANNELS } from './ipc-contract.js'
import type { WindowControlTarget, WindowControlsIpc } from './window-controls.js'

type DiagnosticsWindow = Pick<WindowControlTarget, 'isDestroyed' | 'once' | 'removeListener'> & {
  readonly webContents: Pick<WindowControlTarget['webContents'], 'mainFrame' | 'isDestroyed'>
}

export function createStartupDiagnosticsApi(ipc: { invoke(channel: string): Promise<unknown> }) {
  return Object.freeze({
    revealStartupLog: async (): Promise<void> => { await ipc.invoke(IPC_CHANNELS.revealStartupLog) },
  })
}

export function installStartupDiagnostics(
  ipc: WindowControlsIpc,
  window: DiagnosticsWindow,
  reveal: () => void | Promise<void>,
): () => void {
  let disposed = false
  ipc.handle(IPC_CHANNELS.revealStartupLog, (event, ...args) => {
    if (
      disposed || window.isDestroyed() || window.webContents.isDestroyed()
      || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    ) throw new TypeError('Startup diagnostics requires the Main window')
    if (args.length !== 0) throw new TypeError('Startup diagnostics accepts no arguments')
    return reveal()
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    ipc.removeHandler(IPC_CHANNELS.revealStartupLog)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
