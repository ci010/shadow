import { MICRO_APP_CHANNELS, parseMicroAppIdentity, type DesktopMicroAppsApi } from './micro-app-contract.js'

interface AppIpcEvent { sender: unknown; senderFrame?: unknown }
interface AppIpc {
  handle(channel: string, listener: (event: AppIpcEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
interface MainFrameOwner { webContents: { mainFrame: unknown }; isDestroyed(): boolean }

export function installMicroAppIpc(ipc: AppIpc, owner: () => MainFrameOwner | null, apps: DesktopMicroAppsApi): () => void {
  const check = (event: AppIpcEvent) => {
    const window = owner()
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('App commands require the Shadow main frame')
    }
  }
  ipc.handle(MICRO_APP_CHANNELS.open, (event, ...args) => {
    check(event)
    if (args.length !== 1) throw new TypeError('App opening requires one identity')
    return apps.open(parseMicroAppIdentity(args[0]))
  })
  ipc.handle(MICRO_APP_CHANNELS.refresh, (event, ...args) => {
    check(event)
    if (args.length) throw new TypeError('App refresh accepts no arguments')
    return apps.refresh()
  })
  return () => {
    ipc.removeHandler(MICRO_APP_CHANNELS.open)
    ipc.removeHandler(MICRO_APP_CHANNELS.refresh)
  }
}
