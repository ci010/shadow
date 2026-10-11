import type { Menu, MenuItemConstructorOptions } from 'electron'

interface TrayTarget {
  setToolTip(text: string): void
  setContextMenu(menu: Menu): void
  on(event: 'click', listener: () => void): unknown
  removeListener(event: 'click', listener: () => void): unknown
  isDestroyed(): boolean
  destroy(): void
}

interface TrayWindow {
  webContents: {
    isDestroyed(): boolean
    openDevTools(options: { mode: 'detach' }): void
  }
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

export function installTrayMenu(
  tray: TrayTarget,
  menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu },
  window: TrayWindow,
  quit: () => void,
  restart?: () => void,
  development = !!restart,
): () => void {
  let disposed = false
  const available = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed()
  const showWindow = () => {
    if (!available()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  tray.setToolTip(development ? 'Shadow (DEV)' : 'Shadow')
  tray.setContextMenu(menu.buildFromTemplate([
    { label: '显示 Shadow', click: showWindow },
    {
      label: '打开开发者工具',
      click: () => {
        if (!available()) return
        showWindow()
        window.webContents.openDevTools({ mode: 'detach' })
      },
    },
    ...(restart ? [{ label: '重启 Shadow（开发）', click: () => { if (!disposed) restart() } }] : []),
    { type: 'separator' },
    { label: '退出', click: () => { if (!disposed) quit() } },
  ]))
  tray.on('click', showWindow)
  const dispose = () => {
    if (disposed) return
    disposed = true
    window.removeListener('closed', dispose)
    tray.removeListener('click', showWindow)
    if (!tray.isDestroyed()) tray.destroy()
  }
  window.once('closed', dispose)
  return dispose
}
