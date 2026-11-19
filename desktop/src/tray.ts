import type { Menu, MenuItemConstructorOptions, nativeImage } from 'electron'

/** Tray images use logical points on macOS, not the app icon's raster dimensions. */
export function createTrayImage(
  path: string,
  images: Pick<typeof nativeImage, 'createFromPath'>,
  platform = process.platform,
) {
  if (platform !== 'darwin') return path
  return images.createFromPath(path).resize({ width: 18, height: 18, quality: 'best' })
}

interface TrayTarget {
  setToolTip(text: string): void
  setContextMenu(menu: Menu): void
  on(event: 'click' | 'double-click', listener: () => void): unknown
  removeListener(event: 'click' | 'double-click', listener: () => void): unknown
  isDestroyed(): boolean
  destroy(): void
}

interface TrayActions {
  show(): void
  release(): void
  openDevTools(): void
}

export function installTrayMenu(
  tray: TrayTarget,
  menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu },
  actions: TrayActions,
  quit: () => void,
  restart?: () => void,
  development = !!restart,
  restartBackend?: () => void,
): () => void {
  let disposed = false
  const showWindow = () => { if (!disposed) actions.show() }
  tray.setToolTip(development ? 'Shadow (DEV)' : 'Shadow')
  tray.setContextMenu(menu.buildFromTemplate([
    { label: '显示 Shadow', click: showWindow },
    { label: '轻量模式（关闭主窗口）', click: () => { if (!disposed) actions.release() } },
    {
      label: '打开开发者工具',
      click: () => {
        if (disposed) return
        showWindow()
        actions.openDevTools()
      },
    },
    ...(development && restartBackend ? [{ label: '重启后端（开发）', click: () => { if (!disposed) restartBackend() } }] : []),
    ...(restart ? [{ label: '重启 Shadow（开发）', click: () => { if (!disposed) restart() } }] : []),
    { type: 'separator' },
    { label: '退出', click: () => { if (!disposed) quit() } },
  ]))
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
  const dispose = () => {
    if (disposed) return
    disposed = true
    tray.removeListener('click', showWindow)
    tray.removeListener('double-click', showWindow)
    if (!tray.isDestroyed()) tray.destroy()
  }
  return dispose
}
