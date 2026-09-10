import {
  IPC_CHANNELS,
  parseDesktopWindowState,
  type DesktopWindowControls,
  type DesktopWindowState,
} from './ipc-contract.js'

interface WindowControlsTransport {
  invoke(channel: string): Promise<unknown>
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}

export function createWindowControlsApi(ipc: WindowControlsTransport): DesktopWindowControls {
  return Object.freeze({
    getState: async () => parseDesktopWindowState(await ipc.invoke(IPC_CHANNELS.windowGetState)),
    minimize: async () => { await ipc.invoke(IPC_CHANNELS.windowMinimize) },
    toggleMaximize: async () => parseDesktopWindowState(await ipc.invoke(IPC_CHANNELS.windowToggleMaximize)),
    close: async () => { await ipc.invoke(IPC_CHANNELS.windowClose) },
    onStateChanged(listener: (state: DesktopWindowState) => void) {
      if (typeof listener !== 'function') throw new TypeError('Window state listener must be a function')
      let disposed = false
      const receive = (_event: unknown, value: unknown) => {
        if (disposed) return
        let state: DesktopWindowState
        try {
          state = parseDesktopWindowState(value)
        } catch {
          return
        }
        listener(state)
      }
      ipc.on(IPC_CHANNELS.windowStateChanged, receive)
      return () => {
        if (disposed) return
        disposed = true
        ipc.removeListener(IPC_CHANNELS.windowStateChanged, receive)
      }
    },
  })
}
