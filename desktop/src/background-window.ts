interface CloseEvent {
  preventDefault(): void
}

interface BackgroundApp {
  on(event: 'before-quit' | 'activate', listener: () => void): unknown
  removeListener(event: 'before-quit' | 'activate', listener: () => void): unknown
}

interface BackgroundWindow {
  on(event: 'close', listener: (event: CloseEvent) => void): unknown
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'close', listener: (event: CloseEvent) => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  isMinimized(): boolean
  hide(): void
  restore(): void
  show(): void
  focus(): void
}

export function installBackgroundWindow(
  app: BackgroundApp,
  window: BackgroundWindow,
): () => void {
  let quitting = false
  let disposed = false
  const beforeQuit = () => { quitting = true }
  const close = (event: CloseEvent) => {
    if (disposed || quitting || window.isDestroyed()) return
    event.preventDefault()
    window.hide()
  }
  const activate = () => {
    if (disposed || quitting || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    app.removeListener('before-quit', beforeQuit)
    app.removeListener('activate', activate)
    window.removeListener('close', close)
    window.removeListener('closed', dispose)
  }
  app.on('before-quit', beforeQuit)
  app.on('activate', activate)
  window.on('close', close)
  window.once('closed', dispose)
  return dispose
}
