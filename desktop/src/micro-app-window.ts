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
  const origin = new URL(input.url).origin
  const allowed = (value: string) => {
    try { return new URL(value).origin === origin && new URL(value).protocol === 'http:' }
    catch { return false }
  }
  window.removeMenu()
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  contents.session.setPermissionCheckHandler(() => false)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault() })
  contents.on('will-attach-webview', event => event.preventDefault())
  window.on('page-title-updated', event => event.preventDefault())
  input.signal.addEventListener('abort', close, { once: true })
  window.once('closed', () => {
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
