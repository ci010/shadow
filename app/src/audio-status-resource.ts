import { apiUrl } from './api-url.ts'
import { settingsResource } from './settings-resource.ts'
import type { ResourceLivePool } from './live-resource-refresh.ts'
import type { AudioStatus } from './audio-input.ts'
import { isRecord } from './folders-sidebar.ts'
import { t } from './i18n.ts'
import { diagnosticFetch } from './frontend-network-log.ts'

function parseStatus(value: unknown): AudioStatus {
  if (!isRecord(value) || !isRecord(value.asr) || !isRecord(value.tts)
    || typeof value.asr.ready !== 'boolean' || typeof value.tts.ready !== 'boolean'
    || !['local', 'remote'].includes(String(value.asr.route)) || !['local', 'remote'].includes(String(value.tts.route))) {
    throw new Error(t('Invalid audio status response.'))
  }
  return value as unknown as AudioStatus
}

/** A capability hint, never a recording grant. Configuration events and live
 * recovery refresh it; explicit setup entry rechecks external files as well.
 * Actual capture/transcription still use their authoritative backend paths. */
export function audioStatusResource(pool: ResourceLivePool, base: string, request: typeof fetch = fetch) {
  const dispatch = diagnosticFetch(request)
  const resource = settingsResource(pool, base, request, '/api/audio/status', async signal => {
    const response = await dispatch(apiUrl(base, '/api/audio/status'), { signal, cache: 'no-store' })
    if (!response.ok) throw Object.assign(new Error(t('Unable to read Project audio status. Retry before setup.')), { status: response.status })
    return parseStatus(await response.json())
  })
  return {
    async read(signal?: AbortSignal, fresh = false): Promise<AudioStatus> {
      return parseStatus(await resource.read(signal, fresh))
    },
    subscribe(listener: (value: AudioStatus | undefined) => void) {
      return resource.subscribe(state => listener(state.value === undefined ? undefined : parseStatus(state.value)))
    },
    release: resource.release,
  }
}
