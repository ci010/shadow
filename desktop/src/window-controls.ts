import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, type DesktopWindowState } from './ipc-contract.js'

export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
}

export function framelessWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    icon: join(import.meta.dirname, '..', 'assets', 'icon.ico'),
    webPreferences: secureWebPreferences(preloadPath),
  }
}

export function removeNativeMenus(
  menu: { setApplicationMenu(value: null): void },
  window: { removeMenu(): void },
): void {
  menu.setApplicationMenu(null)
  window.removeMenu()
}

interface WindowRequest {
  readonly sender: unknown
  readonly senderFrame?: unknown
}

type WindowEvent = 'maximize' | 'unmaximize' | 'closed'

export interface WindowControlTarget {
  readonly webContents: {
    readonly mainFrame: unknown
    isDestroyed(): boolean
    send(channel: string, state: DesktopWindowState): void
  }
  isDestroyed(): boolean
  isMaximized(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
  on(event: WindowEvent, listener: () => void): unknown
  once(event: WindowEvent, listener: () => void): unknown
  removeListener(event: WindowEvent, listener: () => void): unknown
}

export interface WindowControlsIpc {
  handle(channel: string, handler: (event: WindowRequest, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export function installWindowControls(ipc: WindowControlsIpc, window: WindowControlTarget): () => void {
  const getState = (): DesktopWindowState => ({ maximized: window.isMaximized() })
  const commands = {
    [IPC_CHANNELS.windowGetState]: getState,
    [IPC_CHANNELS.windowMinimize]: () => window.minimize(),
    [IPC_CHANNELS.windowToggleMaximize]: () => {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      return getState()
    },
    [IPC_CHANNELS.windowClose]: () => window.close(),
  }
  for (const [channel, command] of Object.entries(commands)) {
    ipc.handle(channel, (event, ...args) => {
      if (
        window.isDestroyed()
        || window.webContents.isDestroyed()
        || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
      ) {
        throw new TypeError('Window command requires the Main window')
      }
      if (args.length !== 0) throw new TypeError('Window command accepts no arguments')
      return command()
    })
  }

  const publishState = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.windowStateChanged, getState())
    }
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    window.removeListener('maximize', publishState)
    window.removeListener('unmaximize', publishState)
    window.removeListener('closed', dispose)
    for (const channel of Object.keys(commands)) ipc.removeHandler(channel)
  }
  window.on('maximize', publishState)
  window.on('unmaximize', publishState)
  window.once('closed', dispose)
  return dispose
}
