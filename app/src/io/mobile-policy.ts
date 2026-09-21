import type { IoSource } from '../../../src/io/contracts.ts'

let restricted = false
export const MOBILE_CAPTURE_UNAVAILABLE = 'Camera, microphone, and screen capture are not supported by this mobile client. Use the browser or desktop app, or upload an existing file.'

/** Native permissions and usage descriptions are not configured in this client. */
export function installMobileCaptureRestriction() {
  const previous = restricted
  restricted = true
  return () => { restricted = previous }
}
export function mobileCaptureRestricted(): boolean { return restricted }
export function mobileCaptureIssue(sources: readonly Pick<IoSource, 'kind'>[]): string | undefined {
  return restricted && sources.some(source => source.kind === 'microphone' || source.kind === 'camera' || source.kind === 'screen')
    ? MOBILE_CAPTURE_UNAVAILABLE : undefined
}
