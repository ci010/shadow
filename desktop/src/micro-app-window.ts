import { CHILD_MICRO_APP_SCHEME } from './micro-app-contract.js'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { MicroAppWindowHandle, MicroAppWindowInput } from './micro-apps.js'

export function microAppWindowOptions(input: MicroAppWindowInput): BrowserWindowConstructorOptions {
  return {
    title: input.name, icon: input.iconPath, width: 1040, height: 800,
    minWidth: 400, minHeight: 360, show: false, frame: true, autoHideMenuBar: true,
    webPreferences: {
      partition: input.partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true,
      backgroundThrottling: false,
    },
  }
}

export async function createMicroAppWindow(
  create: (options: BrowserWindowConstructorOptions) => BrowserWindow,
  input: MicroAppWindowInput,
): Promise<MicroAppWindowHandle> {
  input.signal.throwIfAborted()
  const window = create(microAppWindowOptions(input))
  const close = () => { if (!window.isDestroyed()) window.destroy() }
  const contents = window.webContents
  const appSession = contents.session
  const launch = new URL(input.url)
  const protocol = input.relay ? `${CHILD_MICRO_APP_SCHEME}:` : 'http:'
  const allowed = (value: string) => {
    try { const url = new URL(value); return url.protocol === protocol && url.host === launch.host }
    catch { return false }
  }
  if (!allowed(input.url)) { close(); throw new Error('Invalid Micro App origin') }
  if (input.relay) appSession.protocol.handle(CHILD_MICRO_APP_SCHEME, input.relay)
  window.removeMenu()
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  appSession.setPermissionCheckHandler(() => false)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault() })
  contents.on('will-attach-webview', event => event.preventDefault())
  window.on('page-title-updated', event => event.preventDefault())
  input.signal.addEventListener('abort', close, { once: true })
  window.once('closed', () => {
    if (input.relay) appSession.protocol.unhandle(CHILD_MICRO_APP_SCHEME)
    input.signal.removeEventListener('abort', close)
    input.onClosed()
  })
  try {
    input.signal.throwIfAborted()
    await window.loadURL(input.url)
    if (window.isDestroyed()) throw new Error('Micro App window closed while loading')
    window.setTitle(input.name)
    window.show()
    window.focus()
  } catch {
    if (!window.isDestroyed()) window.destroy()
    // Electron load errors can include the one-use ticket URL.
    throw new Error('Micro App window could not load. Reopen it from Shadow Apps.')
  }
  return {
    focus: () => {
      if (window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show(); window.focus()
    },
    close,
  }
}
