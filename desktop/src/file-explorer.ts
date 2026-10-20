import { desktopMediaKey, verifyMediaReveal } from './media-reveal-key.js'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import { FILE_EXPLORER_CHANNEL } from './file-explorer-contract.js'
import { isTrustedMediaUrl } from './media-permissions.js'
import type { RendererTarget } from './renderer-target.js'

export function installFileExplorer(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  window: BrowserWindow,
  target: RendererTarget,
  show: (path: string) => void,
): () => void {
  let disposed = false
  const contents = window.webContents
  // Verify the loaded document, then follow its history routes. URL-only checks
  // reject Vue's HTTP pushState routes; origin-only checks would trust other documents.
  let trustedFrame = isTrustedMediaUrl(contents.mainFrame.url, target) ? contents.mainFrame : undefined
  let trustedUrl = trustedFrame ? contents.mainFrame.url : undefined
  let reloadUrl: string | undefined
  const sameUrl = (a: string, b: string) => {
    try {
      const left = new URL(a), right = new URL(b)
      left.hash = right.hash = ''
      return left.href === right.href
    } catch { return false }
  }
  const invalidate = () => { trustedFrame = undefined; trustedUrl = undefined; reloadUrl = undefined }
  const onStart = (_event: unknown, url: string, inPlace: boolean, main: boolean) => {
    if (!main || inPlace) return
    const reload = trustedFrame === contents.mainFrame && trustedUrl !== undefined && sameUrl(url, trustedUrl)
    invalidate()
    if (reload) reloadUrl = url
  }
  const onNavigate = (_event: unknown, url: string) => {
    const allowed = isTrustedMediaUrl(url, target) || (reloadUrl !== undefined && sameUrl(url, reloadUrl))
    invalidate()
    if (allowed) { trustedFrame = contents.mainFrame; trustedUrl = url }
  }
  const onInPage = (_event: unknown, url: string, main: boolean) => {
    if (!main || trustedFrame !== contents.mainFrame || trustedUrl === undefined) return
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
  contents.on('did-start-navigation', onStart)
  contents.on('did-navigate', onNavigate)
  contents.on('did-navigate-in-page', onInPage)
  contents.on('render-process-gone', invalidate)
  contents.on('destroyed', invalidate)
  const trusted = (event: Electron.IpcMainInvokeEvent) => !disposed && !window.isDestroyed()
    && !contents.isDestroyed() && event.sender === contents
    && event.senderFrame === contents.mainFrame && trustedFrame === contents.mainFrame
    && trustedUrl !== undefined && sameUrl(contents.mainFrame.url, trustedUrl)
  ipc.handle(FILE_EXPLORER_CHANNEL, async (event, ...args: unknown[]) => {
    if (!trusted(event)) throw new TypeError('File explorer requires the trusted Main window')
    const input = args[0]
    if (args.length === 1 && input && typeof input === 'object') {
      const { proof, reveal } = input as { proof?: unknown; reveal?: unknown }
      if (!verifyMediaReveal(proof, desktopMediaKey) || !isAbsolute(proof.path)) return false
      if (reveal === false) return true
      if (reveal !== true) return false
      await stat(proof.path)
      if (!trusted(event)) throw new TypeError('File explorer window is no longer available')
      show(proof.path)
      return true
    }
    const path = input
    if (args.length !== 1 || typeof path !== 'string' || path.length > 32_768
      || path.includes('\0') || !isAbsolute(path)) throw new TypeError('Invalid file explorer path')
    await stat(path)
    if (!trusted(event)) throw new TypeError('File explorer window is no longer available')
    show(path)
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    invalidate()
    ipc.removeHandler(FILE_EXPLORER_CHANNEL)
    contents.removeListener('did-start-navigation', onStart)
    contents.removeListener('did-navigate', onNavigate)
    contents.removeListener('did-navigate-in-page', onInPage)
    contents.removeListener('render-process-gone', invalidate)
    contents.removeListener('destroyed', invalidate)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
