import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ClipboardBookmark, IpcMain, BrowserWindow } from 'electron'
import type { RendererTarget } from './renderer-target.js'
import { isTrustedMediaUrl } from './media-permissions.js'
import {
  CLIPBOARD_FILES_CHANNEL, MAX_CLIPBOARD_BYTES, MAX_CLIPBOARD_FILES,
  parseClipboardFiles, type ClipboardFile,
} from './clipboard-files-contract.js'

const run = promisify(execFile)
const fileDropScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$files = @([System.Windows.Forms.Clipboard]::GetFileDropList())
ConvertTo-Json -InputObject $files -Compress
`

export function parseClipboardPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CLIPBOARD_FILES) {
    throw new Error('Copy no more than 100 files at a time.')
  }
  const paths = value.map((path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 32_768 || path.includes('\0')) {
      throw new TypeError('Invalid clipboard file path')
    }
    return path
  })
  return [...new Set(paths)]
}

export async function readClipboardPaths(
  clipboard: { read(): Promise<Array<{ types: readonly string[]; getType(type: string): Promise<Blob | ClipboardBookmark> }>> },
  platform = process.platform,
): Promise<string[]> {
  if (platform === 'win32') {
    // Chromium does not reliably expose Explorer's CF_HDROP as DOM File objects.
    // STA is required by the Windows clipboard API; no renderer-supplied paths or shell code.
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await run(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(fileDropScript, 'utf16le').toString('base64'),
    ], { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
    return parseClipboardPaths(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
  }
  const paths: string[] = []
  for (const item of await clipboard.read()) {
    const type = item.types.find(type => [
      'text/uri-list',
      'electron application/osclipboard;format="public.file-url"',
      'electron application/osclipboard;format="x-special/gnome-copied-files"',
    ].includes(type))
    if (!type) continue
    const blob = await item.getType(type)
    if (!(blob instanceof Blob) || blob.size > 1024 * 1024) throw new Error('Invalid clipboard file list')
    for (const line of (await blob.text()).split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line === 'copy' || line === 'cut') continue
      const url = new URL(line)
      if (url.protocol !== 'file:') continue
      paths.push(fileURLToPath(url))
    }
  }
  return parseClipboardPaths(paths)
}

export async function readClipboardFiles(paths: readonly string[]): Promise<ClipboardFile[]> {
  const result: ClipboardFile[] = []
  let total = 0
  for (const path of parseClipboardPaths(paths)) {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (info.isDirectory()) throw new Error('Folders cannot be pasted as attachments. Copy files instead.')
      if (!info.isFile()) throw new Error('Only regular files can be pasted as attachments.')
      if (info.size + total > MAX_CLIPBOARD_BYTES) throw new Error('Copied files exceed 100 MiB. Use Add file instead.')
      const bytes = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length !== info.size) throw new Error('A copied file changed while being read. Copy it again.')
      total += length
      result.push({ name: basename(path), bytes: new Uint8Array(bytes.subarray(0, length)), lastModified: info.mtimeMs })
    } finally { await handle.close() }
  }
  return result
}

export function installClipboardFiles(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  window: Pick<BrowserWindow, 'isDestroyed' | 'once' | 'removeListener' | 'webContents'>,
  target: RendererTarget,
  read: () => Promise<ClipboardFile[]>,
): () => void {
  const contents = window.webContents
  let disposed = false
  let pending: Promise<ClipboardFile[]> | undefined
  let revision = 0
  let trustedUrl = isTrustedMediaUrl(contents.mainFrame.url, target) ? contents.mainFrame.url : undefined
  let trustedFrame = trustedUrl === undefined ? undefined : contents.mainFrame
  let reloadUrl: string | undefined
  const sameUrl = (first: string, second: string) => first.split('#')[0] === second.split('#')[0]
  const unavailable = () => disposed || window.isDestroyed() || contents.isDestroyed()
  const trusted = () => !unavailable() && trustedFrame === contents.mainFrame
    && trustedUrl !== undefined && sameUrl(contents.mainFrame.url, trustedUrl)
  const invalidate = () => {
    revision++
    trustedUrl = undefined
    trustedFrame = undefined
    reloadUrl = undefined
  }
  const onNavigation = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace) return
    const reloading = trusted() && trustedUrl !== undefined && sameUrl(url, trustedUrl)
    invalidate()
    if (reloading) reloadUrl = url
  }
  const onDocumentNavigation = (_event: unknown, url: string) => {
    const allowed = isTrustedMediaUrl(url, target) || (reloadUrl !== undefined && sameUrl(url, reloadUrl))
    invalidate()
    if (allowed) { trustedUrl = url; trustedFrame = contents.mainFrame }
  }
  const onInPageNavigation = (_event: unknown, url: string, mainFrame: boolean) => {
    if (!mainFrame || trustedFrame !== contents.mainFrame || trustedUrl === undefined) return
    let allowed = isTrustedMediaUrl(url, target)
    if (target.kind === 'url') {
      try {
        const candidate = new URL(url)
        allowed = candidate.origin === target.origin && !candidate.username && !candidate.password
      } catch { allowed = false }
    }
    if (allowed) trustedUrl = url
    else invalidate()
  }
  contents.on('did-start-navigation', onNavigation)
  contents.on('did-navigate', onDocumentNavigation)
  contents.on('did-navigate-in-page', onInPageNavigation)
  contents.on('render-process-gone', invalidate)
  contents.on('destroyed', invalidate)
  ipc.handle(CLIPBOARD_FILES_CHANNEL, (event, ...args: unknown[]) => {
    if (!trusted() || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new TypeError('Clipboard files require the trusted Main window')
    }
    if (args.length) throw new TypeError('Clipboard file reads accept no arguments')
    const started = revision
    pending ??= read().then(files => {
      if (!trusted() || revision !== started) {
        throw new Error('The clipboard destination is no longer available')
      }
      return parseClipboardFiles(files)
    }).finally(() => { pending = undefined })
    return pending
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    invalidate()
    ipc.removeHandler(CLIPBOARD_FILES_CHANNEL)
    contents.removeListener('did-start-navigation', onNavigation)
    contents.removeListener('did-navigate', onDocumentNavigation)
    contents.removeListener('did-navigate-in-page', onInPageNavigation)
    contents.removeListener('render-process-gone', invalidate)
    contents.removeListener('destroyed', invalidate)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
