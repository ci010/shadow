import { t } from '../i18n.ts'
import type { IoDefinition } from '../../../src/io/contracts.ts'
import { MAX_MEDIA_CAPTURE_DURATION_MS, type DesktopMediaCaptureApi, type MediaCaptureCapability } from '../../../desktop/src/media-capture-contract.ts'
import type {} from '../desktop-bootstrap.ts'

declare module '../desktop-bootstrap.ts' {
  interface ShadowDesktopApi {
    readonly mediaCapture?: DesktopMediaCaptureApi
  }
}

export function desktopMediaBridge(): DesktopMediaCaptureApi | undefined {
  return typeof window === 'undefined' ? undefined : window.shadowDesktop?.mediaCapture
}

export function desktopCapabilities(definition: IoDefinition): MediaCaptureCapability[] {
  const result = new Set<MediaCaptureCapability>()
  for (const source of definition.sources) {
    if (source.kind === 'microphone' || source.kind === 'camera' || source.kind === 'screen') result.add(source.kind)
    if (source.kind === 'camera' && source.audio) result.add('microphone')
  }
  return [...result]
}

export function desktopSourceIssue(definition: IoDefinition): string | undefined {
  if (definition.sources.some(source => source.kind === 'screen' && source.audio)) return t('Desktop screen audio is unavailable. Create a new request with screen audio disabled and a separate microphone source if needed.')
  if (definition.limits.durationMs > MAX_MEDIA_CAPTURE_DURATION_MS) return t('Desktop capture is limited to {value1} seconds. Create a request within this limit.', { value1: MAX_MEDIA_CAPTURE_DURATION_MS / 1000 })
  return undefined
}

export function desktopIoIssue(definition: IoDefinition): string | undefined {
  if (typeof window === 'undefined' || !window.shadowDesktop || !desktopCapabilities(definition).length) return undefined
  if (!window.shadowDesktop.mediaCapture) return t('This desktop build lacks trusted media grants. Update the desktop app before capturing devices.')
  return desktopSourceIssue(definition)
}
