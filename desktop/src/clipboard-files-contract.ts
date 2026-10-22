export const CLIPBOARD_FILES_CHANNEL = 'shadow:clipboard:read-files'
export const MAX_CLIPBOARD_FILES = 100
export const MAX_CLIPBOARD_BYTES = 100 * 1024 * 1024

export interface ClipboardFile {
  name: string
  bytes: Uint8Array
  lastModified: number
}

export interface DesktopClipboardFilesApi {
  readFiles(): Promise<ClipboardFile[]>
}

export function parseClipboardFiles(value: unknown): ClipboardFile[] {
  if (!Array.isArray(value) || value.length > MAX_CLIPBOARD_FILES) {
    throw new TypeError('Invalid clipboard files')
  }
  let total = 0
  return value.map((file: unknown) => {
    if (!file || typeof file !== 'object' || !('name' in file) || typeof file.name !== 'string'
      || !file.name || /[/\\\x00-\x1f]/.test(file.name)
      || !('bytes' in file) || !(file.bytes instanceof Uint8Array)
      || !('lastModified' in file) || typeof file.lastModified !== 'number'
      || !Number.isFinite(file.lastModified) || file.lastModified < 0) {
      throw new TypeError('Invalid clipboard file')
    }
    total += file.bytes.byteLength
    if (total > MAX_CLIPBOARD_BYTES) throw new TypeError('Clipboard files exceed 100 MiB')
    return { name: file.name, bytes: file.bytes, lastModified: file.lastModified }
  })
}

export function createClipboardFilesApi(
  ipc: { invoke(channel: string): Promise<unknown> },
  consumeTrustedPaste: () => boolean,
): DesktopClipboardFilesApi {
  return Object.freeze({
    readFiles: async () => {
      if (!consumeTrustedPaste()) throw new TypeError('Clipboard files require a trusted paste')
      return parseClipboardFiles(await ipc.invoke(CLIPBOARD_FILES_CHANNEL))
    },
  })
}

export function createPasteClipboardFilesApi(
  ipc: { invoke(channel: string): Promise<unknown> },
  events: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): DesktopClipboardFilesApi {
  let trustedPaste = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const paste = (event: ClipboardEvent) => {
    if (!event.isTrusted) return
    trustedPaste = true
    clearTimeout(timer)
    timer = setTimeout(() => { trustedPaste = false }, 0)
  }
  events.addEventListener('paste', paste, true)
  events.addEventListener('unload', () => {
    trustedPaste = false
    clearTimeout(timer)
    events.removeEventListener('paste', paste, true)
  }, { once: true })
  return createClipboardFilesApi(ipc, () => {
    const allowed = trustedPaste
    trustedPaste = false
    return allowed
  })
}
