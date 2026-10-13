import {
  MEDIA_CAPTURE_CHANNELS,
  DISPLAY_PICKER_EVENT,
  parseDisplayPickerResponse,
  parseDisplayPickerState,
  type DesktopMediaCaptureApi,
  parseMediaCaptureGrant,
  parseMediaCaptureRevocation,
} from './media-capture-contract.js'

export function createMediaCaptureApi(
  ipc: {
    invoke(channel: string, value: unknown): Promise<unknown>
    on?(channel: string, listener: (event: unknown, value: unknown) => void): unknown
    removeListener?(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  },
  hasUserActivation: () => boolean,
  consumeComposerGesture?: () => boolean,
): DesktopMediaCaptureApi {
  return Object.freeze({
    displayPicker: Object.freeze({
      subscribe(listener) {
        let disposed = false
        let received = false
        const receive = (_event: unknown, value: unknown) => {
          if (disposed) return
          received = true
          listener(parseDisplayPickerState(value))
        }
        ipc.on?.(DISPLAY_PICKER_EVENT, receive)
        // Subscribe first so an initial snapshot cannot overwrite a newer offer/close.
        void ipc.invoke(MEDIA_CAPTURE_CHANNELS.pickerState, {}).then(value => {
          if (!disposed && !received) listener(parseDisplayPickerState(value))
        }).catch(() => { if (!disposed && !received) listener(null) })
        return () => { disposed = true; ipc.removeListener?.(DISPLAY_PICKER_EVENT, receive) }
      },
      respond: (response) => {
        const parsed = parseDisplayPickerResponse(response)
        if (parsed.sourceId !== null && !hasUserActivation()) {
          return Promise.reject(new TypeError('Screen sharing requires the trusted Share button'))
        }
        return ipc.invoke(MEDIA_CAPTURE_CHANNELS.pickerRespond, parsed) as Promise<void>
      },
    } satisfies NonNullable<DesktopMediaCaptureApi['displayPicker']>),
    arm: (request) => {
      // Evaluated in the isolated preload world, not from a caller-supplied flag.
      if (!hasUserActivation()) {
        return Promise.reject(new TypeError('Media capture requires the trusted Start button'))
      }
      return ipc.invoke(MEDIA_CAPTURE_CHANNELS.arm, parseMediaCaptureGrant(request)) as Promise<{ expiresAt: number }>
    },
    ...(consumeComposerGesture ? { armComposerMicrophone: (request: Parameters<DesktopMediaCaptureApi['arm']>[0]) => {
      const parsed = parseMediaCaptureGrant(request)
      if (parsed.capabilities.length !== 1 || parsed.capabilities[0] !== 'microphone' || parsed.durationMs > 65_000) {
        return Promise.reject(new TypeError('Composer gesture permits only a bounded microphone reservation'))
      }
      if (!consumeComposerGesture()) return Promise.reject(new TypeError('Microphone requires a trusted composer gesture'))
      return ipc.invoke(MEDIA_CAPTURE_CHANNELS.arm, parsed) as Promise<{ expiresAt: number }>
    } } : {}),
    revoke: (request) =>
      ipc.invoke(MEDIA_CAPTURE_CHANNELS.revoke, parseMediaCaptureRevocation(request)) as Promise<void>,
  } satisfies DesktopMediaCaptureApi)
}
