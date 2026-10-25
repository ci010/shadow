import type { BrowserWindow, IpcMain, Session } from 'electron'
import type { RendererTarget } from './renderer-target.js'
import {
  MEDIA_CAPTURE_CHANNELS,
  DISPLAY_PICKER_EVENT,
  parseDisplayPickerResponse,
  parseMediaCaptureGrant,
  parseMediaCaptureRevocation,
  type MediaCaptureCapability,
  type MediaCaptureGrantRequest,
} from './media-capture-contract.js'
import { createDisplaySourcePicker } from './display-source-picker.js'

interface CaptureGrant extends MediaCaptureGrantRequest {
  readonly expiresAt: number
}

export function isTrustedMediaUrl(value: string, target: RendererTarget): boolean {
  return isSameMediaUrl(value, target.kind === 'url' ? target.url : target.entryUrl)
}

function isSameMediaUrl(value: string, expected: string): boolean {
  try {
    const candidate = new URL(value)
    const entry = new URL(expected)
    candidate.hash = ''
    entry.hash = ''
    return candidate.href === entry.href
  } catch {
    return false
  }
}

function isTrustedOrigin(value: string, target: RendererTarget): boolean {
  // Chromium serializes local-file security origins differently between callbacks.
  return target.kind === 'file'
    ? value === 'file://' || value === 'file:///' || value === 'null'
    : value === target.origin || value === `${target.origin}/`
}

export class MediaCaptureGrants {
  private grant: CaptureGrant | undefined

  constructor(private readonly now: () => number = Date.now) {}

  arm(raw: unknown): CaptureGrant {
    const request = parseMediaCaptureGrant(raw)
    if (this.current()) throw new TypeError('Stop the current media capture before starting another')
    this.grant = { ...request, expiresAt: this.now() + request.durationMs }
    return this.grant
  }

  current(): CaptureGrant | undefined {
    if (this.grant && this.grant.expiresAt <= this.now()) this.clear()
    return this.grant
  }

  allows(capability: MediaCaptureCapability): boolean {
    return this.current()?.capabilities.includes(capability) === true
  }

  revoke(raw: unknown): void {
    if (parseMediaCaptureRevocation(raw).runId === this.grant?.runId) this.clear()
  }

  clear(): void {
    this.grant = undefined
  }
}

type DisplayHandler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
type DisplaySelection = Parameters<Parameters<DisplayHandler>[1]>[0]['video']

function denyDisplay(callback: Parameters<DisplayHandler>[1]): void {
  try {
    callback({})
  } catch {
    // Electron 44 rejects the renderer request, then throws for a missing video
    // stream. Cancellation must not become an unhandled main-process rejection.
  }
}

export type MediaPermissionOptions = {
  readonly now?: () => number
} & ({
  readonly chooseDisplaySource: (signal: AbortSignal) => Promise<DisplaySelection | undefined>
  readonly getDisplaySources?: never
} | {
  readonly getDisplaySources: () => Promise<Electron.DesktopCapturerSource[]>
  readonly chooseDisplaySource?: never
})

export function installMediaPermissions(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  window: BrowserWindow,
  target: RendererTarget,
  options: MediaPermissionOptions,
): () => void {
  const contents = window.webContents
  const session = contents.session
  const grants = new MediaCaptureGrants(options.now)
  let disposed = false
  let picking = false
  let pickerAbort: AbortController | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let trustedUrl = isTrustedMediaUrl(contents.mainFrame.url, target) ? contents.mainFrame.url : undefined
  let trustedFrame = trustedUrl === undefined ? undefined : contents.mainFrame
  let reloadUrl: string | undefined
  const trustedContents = (sender: unknown) =>
    !disposed && !window.isDestroyed() && !contents.isDestroyed()
    && sender === contents && trustedFrame === contents.mainFrame
    && trustedUrl !== undefined && isSameMediaUrl(contents.mainFrame.url, trustedUrl)
  const picker = options.getDisplaySources && createDisplaySourcePicker(options.getDisplaySources, state => {
    if (!trustedContents(contents)) return
    try { contents.mainFrame.send(DISPLAY_PICKER_EVENT, state) }
    catch { pickerAbort?.abort() }
  })
  const clear = () => {
    grants.clear()
    pickerAbort?.abort()
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = undefined
  }
  const trustedRequest = (sender: unknown, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    trustedContents(sender) && details.isMainFrame === true
    && typeof details.requestingUrl === 'string' && trustedUrl !== undefined
    && isSameMediaUrl(details.requestingUrl, trustedUrl)
  const allowsMedia = (type: unknown) =>
    type === 'audio' ? grants.allows('microphone') : type === 'video' && grants.allows('camera')

  session.setPermissionCheckHandler((sender, permission, origin, details) => {
    if (!trustedRequest(sender, details) || !isTrustedOrigin(origin, target)) return false
    if (details.securityOrigin !== undefined && !isTrustedOrigin(details.securityOrigin, target)) return false
    if (permission === 'clipboard-sanitized-write') return true
    if (permission === 'media') return allowsMedia(details.mediaType)
    return permission === 'display-capture' && grants.allows('screen')
  })
  session.setPermissionRequestHandler((sender, permission, callback, details) => {
    if (!trustedRequest(sender, details)) return callback(false)
    if ('securityOrigin' in details && details.securityOrigin !== undefined
      && !isTrustedOrigin(details.securityOrigin, target)) return callback(false)
    if (permission === 'clipboard-sanitized-write') return callback(true)
    if (permission === 'display-capture') return callback(grants.allows('screen'))
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined
    // Electron 44 requests "media" with [] before getDisplayMedia. The display
    // handler still validates the frame, gesture, grant and selected source.
    callback(permission === 'media' && Array.isArray(types)
      && (types.length === 0 ? grants.allows('screen') : types.every(allowsMedia)))
  })
  const displayHandler: DisplayHandler = (request, callback) => {
    const grant = grants.current()
    const allowed = () => trustedContents(contents)
      && request.frame === contents.mainFrame && request.frame !== null
      && isTrustedOrigin(request.securityOrigin, target)
      && request.userGesture === true && request.videoRequested && !request.audioRequested
      && grant !== undefined && grants.current() === grant && grants.allows('screen')
    if (!allowed() || picking) return denyDisplay(callback)
    picking = true
    const abort = new AbortController()
    pickerAbort = abort
    void Promise.resolve().then(() => picker ? picker.choose(abort.signal) : options.chooseDisplaySource!(abort.signal)).then((video) => {
      if (video && allowed()) callback({ video })
      else denyDisplay(callback)
    }, () => denyDisplay(callback)).catch(() => {
      // A selected source can disappear while Electron is resolving it.
    }).finally(() => {
      picking = false
      pickerAbort = undefined
    })
  }
  // Electron's experimental macOS picker skips this handler, including the
  // post-selection revocation/expiry check. Keep that bypass disabled.
  session.setDisplayMediaRequestHandler(displayHandler, { useSystemPicker: false })

  for (const [channel, command] of [
    [MEDIA_CAPTURE_CHANNELS.arm, (value: unknown) => {
      const grant = grants.arm(value)
      if (expiryTimer) clearTimeout(expiryTimer)
      expiryTimer = setTimeout(clear, Math.max(1, grant.expiresAt - (options.now ?? Date.now)()))
      expiryTimer.unref()
      return { expiresAt: grant.expiresAt }
    }],
    [MEDIA_CAPTURE_CHANNELS.revoke, (value: unknown) => {
      grants.revoke(value)
      if (!grants.current()) clear()
    }],
    [MEDIA_CAPTURE_CHANNELS.pickerState, (value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length) {
        throw new TypeError('Display picker state requires an empty request')
      }
      if (!grants.current()) clear()
      return picker?.state() ?? null
    }],
    [MEDIA_CAPTURE_CHANNELS.pickerRespond, (value: unknown) => {
      const response = parseDisplayPickerResponse(value)
      if (!grants.allows('screen')) clear()
      if (!picker || !picking || !grants.allows('screen') || pickerAbort?.signal.aborted) {
        throw new TypeError('Display picker request is no longer active')
      }
      picker.respond(response)
    }],
  ] as const) {
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (channel === MEDIA_CAPTURE_CHANNELS.pickerState
        && event.sender === contents && event.senderFrame === contents.mainFrame
        && !trustedContents(event.sender)) return null
      if (!trustedContents(event.sender) || event.senderFrame !== contents.mainFrame) {
        throw new TypeError('Media capture requires the trusted Main frame')
      }
      if (args.length !== 1) throw new TypeError('Media capture requires one request')
      return command(args[0])
    })
  }

  const invalidateDocument = () => {
    trustedFrame = undefined
    trustedUrl = undefined
    reloadUrl = undefined
    clear()
  }
  const onNavigation = (_event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (!isMainFrame || isInPlace) return
    const reloading = trustedFrame === contents.mainFrame && trustedUrl !== undefined
      && isSameMediaUrl(url, trustedUrl)
    invalidateDocument()
    if (reloading) reloadUrl = url
  }
  const onDocumentNavigation = (_event: unknown, url: string) => {
    const trusted = isTrustedMediaUrl(url, target)
      || (reloadUrl !== undefined && isSameMediaUrl(url, reloadUrl))
    invalidateDocument()
    if (trusted) {
      trustedFrame = contents.mainFrame
      trustedUrl = url
    }
  }
  const onInPageNavigation = (_event: unknown, url: string, isMainFrame: boolean) => {
    if (!isMainFrame || trustedFrame !== contents.mainFrame || trustedUrl === undefined) return
    // History routing keeps the verified document, not every page on its origin.
    let allowed = isTrustedMediaUrl(url, target)
    if (target.kind === 'url') {
      try {
        const candidate = new URL(url)
        allowed = candidate.origin === target.origin && !candidate.username && !candidate.password
      } catch { allowed = false }
    }
    if (allowed) trustedUrl = url
    else invalidateDocument()
  }
  contents.on('did-start-navigation', onNavigation)
  contents.on('did-navigate', onDocumentNavigation)
  contents.on('did-navigate-in-page', onInPageNavigation)
  contents.on('render-process-gone', invalidateDocument)
  contents.on('destroyed', invalidateDocument)
  const dispose = () => {
    if (disposed) return
    disposed = true
    invalidateDocument()
    for (const channel of Object.values(MEDIA_CAPTURE_CHANNELS)) ipc.removeHandler(channel)
    contents.removeListener('did-start-navigation', onNavigation)
    contents.removeListener('did-navigate', onDocumentNavigation)
    contents.removeListener('did-navigate-in-page', onInPageNavigation)
    contents.removeListener('render-process-gone', invalidateDocument)
    contents.removeListener('destroyed', invalidateDocument)
    window.removeListener('closed', dispose)
    // Never restore Electron's permissive defaults on a shared session.
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_sender, _permission, callback) => callback(false))
    session.setDisplayMediaRequestHandler((_request, callback) => denyDisplay(callback), { useSystemPicker: false })
  }
  window.once('closed', dispose)
  return dispose
}
