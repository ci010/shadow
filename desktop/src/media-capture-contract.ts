export const MEDIA_CAPTURE_CHANNELS = {
  arm: 'shadow:media-capture:arm',
  revoke: 'shadow:media-capture:revoke',
  pickerState: 'shadow:media-capture:picker-state',
  pickerRespond: 'shadow:media-capture:picker-respond',
} as const
export const DISPLAY_PICKER_EVENT = 'shadow:media-capture:picker-changed'

export interface DisplayPickerSource {
  /** Opaque offer token, not an Electron capture ID. */
  readonly id: string
  readonly name: string
  readonly kind: 'screen' | 'window'
  readonly thumbnailUrl: string
}

export interface DisplayPickerState {
  readonly requestId: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly sources: readonly DisplayPickerSource[]
}

export interface DisplayPickerResponse {
  readonly requestId: string
  readonly sourceId: string | null
}

export interface DesktopDisplayPickerApi {
  subscribe(listener: (state: DisplayPickerState | null) => void): () => void
  respond(response: DisplayPickerResponse): Promise<void>
}

export const MAX_MEDIA_CAPTURE_DURATION_MS = 24 * 60 * 60 * 1000
export type MediaCaptureCapability = 'microphone' | 'camera' | 'screen'

export interface MediaCaptureGrantRequest {
  readonly runId: string
  /** Camera audio requires an explicit microphone grant. Screen system audio is unsupported. */
  readonly capabilities: readonly MediaCaptureCapability[]
  readonly durationMs: number
}

export interface DesktopMediaCaptureApi {
  readonly displayPicker?: DesktopDisplayPickerApi
  /** Call directly from trusted Start, before awaiting network work; never from a guest event. */
  arm(request: MediaCaptureGrantRequest): Promise<{ readonly expiresAt: number }>
  /** Reserve from the observed composer gesture; microphone only, max 65 seconds. */
  armComposerMicrophone?(request: MediaCaptureGrantRequest): Promise<{ readonly expiresAt: number }>
  /** Prevents acquisition; the renderer must also stop existing tracks and pending capture work. */
  revoke(request: { readonly runId: string }): Promise<void>
}

function parseRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || Object.keys(value).some((key) => !fields.includes(key))
  ) throw new TypeError('Invalid media capture request')
  return value as Record<string, unknown>
}

function parseRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError('Invalid media capture run ID')
  }
  return value
}

export function parseMediaCaptureGrant(value: unknown): MediaCaptureGrantRequest {
  const record = parseRecord(value, ['runId', 'capabilities', 'durationMs'])
  const capabilities = record.capabilities
  if (
    !Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 3
    || capabilities.some((item) => !['microphone', 'camera', 'screen'].includes(item))
    || new Set(capabilities).size !== capabilities.length
    || !Number.isSafeInteger(record.durationMs) || (record.durationMs as number) < 1
    || (record.durationMs as number) > MAX_MEDIA_CAPTURE_DURATION_MS
  ) throw new TypeError('Invalid media capture capabilities or duration')
  return {
    runId: parseRunId(record.runId),
    capabilities: [...capabilities] as MediaCaptureCapability[],
    durationMs: record.durationMs as number,
  }
}

export function parseMediaCaptureRevocation(value: unknown): { runId: string } {
  return { runId: parseRunId(parseRecord(value, ['runId']).runId) }
}

export function parseDisplayPickerResponse(value: unknown): DisplayPickerResponse {
  const record = parseRecord(value, ['requestId', 'sourceId'])
  return {
    requestId: parseRunId(record.requestId),
    sourceId: record.sourceId === null ? null : parseRunId(record.sourceId),
  }
}

export function parseDisplayPickerState(value: unknown): DisplayPickerState | null {
  if (value === null) return null
  const record = parseRecord(value, ['requestId', 'status', 'sources'])
  if (!['loading', 'ready', 'error'].includes(record.status as string) || !Array.isArray(record.sources)) {
    throw new TypeError('Invalid display picker state')
  }
  const sources = record.sources.map((value) => {
    const source = parseRecord(value, ['id', 'name', 'kind', 'thumbnailUrl'])
    if (typeof source.name !== 'string' || source.name.length > 300
      || !['screen', 'window'].includes(source.kind as string)
      || typeof source.thumbnailUrl !== 'string'
      || (source.thumbnailUrl !== '' && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(source.thumbnailUrl))) {
      throw new TypeError('Invalid display picker source')
    }
    return { id: parseRunId(source.id), name: source.name, kind: source.kind as 'screen' | 'window', thumbnailUrl: source.thumbnailUrl }
  })
  if (new Set(sources.map(source => source.id)).size !== sources.length
    || (record.status !== 'ready' && sources.length)) throw new TypeError('Invalid display picker sources')
  return { requestId: parseRunId(record.requestId), status: record.status as DisplayPickerState['status'], sources }
}
