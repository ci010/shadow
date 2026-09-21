import type { Input } from 'electron'

export const DOCUMENT_TAB_CHANNEL = 'shadow:cycle-document-tab'
type Direction = -1 | 1
type DocumentAction = Direction | 'close' | 'close-all' | 'toggle-explorer'
type BeforeInput = (event: { preventDefault(): void }, input: Input) => void

interface DocumentTabWindow {
  webContents: {
    isDestroyed(): boolean
    send(channel: string, action: DocumentAction): void
    on(event: 'before-input-event', listener: BeforeInput): unknown
    removeListener(event: 'before-input-event', listener: BeforeInput): unknown
  }
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

// Route native input around frame-local DOM handlers; the renderer still owns pane eligibility.
export function installDocumentTabShortcuts(window: DocumentTabWindow): () => void {
  const contents = window.webContents
  let disposed = false
  const receive: BeforeInput = (event, input) => {
    if (disposed || window.isDestroyed() || contents.isDestroyed()
      || input.type !== 'keyDown' || !input.control
      || input.alt || input.meta || input.isComposing) return
    const close = input.key.toLowerCase() === 'w'
    const toggleExplorer = input.key.toLowerCase() === 'e' && input.shift
    if (!close && !toggleExplorer && input.key !== 'Tab') return
    // Suppress the DOM keydown so the renderer cannot cycle twice.
    event.preventDefault()
    if ((close || toggleExplorer) && input.isAutoRepeat) return
    contents.send(DOCUMENT_TAB_CHANNEL, toggleExplorer ? 'toggle-explorer' : close ? (input.shift ? 'close-all' : 'close') : input.shift ? -1 : 1)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    contents.removeListener('before-input-event', receive)
    window.removeListener('closed', dispose)
  }
  contents.on('before-input-event', receive)
  window.once('closed', dispose)
  return dispose
}

interface DocumentTabTransport {
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}

export function receiveDocumentTabShortcuts(
  ipc: DocumentTabTransport,
  listener: (action: DocumentAction) => void,
): () => void {
  let disposed = false
  const receive = (_event: unknown, value: unknown) => {
    if (!disposed && (value === -1 || value === 1 || value === 'close' || value === 'close-all' || value === 'toggle-explorer')) listener(value)
  }
  ipc.on(DOCUMENT_TAB_CHANNEL, receive)
  return () => {
    if (disposed) return
    disposed = true
    ipc.removeListener(DOCUMENT_TAB_CHANNEL, receive)
  }
}
