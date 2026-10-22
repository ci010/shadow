import { randomUUID } from 'node:crypto'
import type { DisplayPickerResponse, DisplayPickerState } from './media-capture-contract.js'

export interface DisplaySource {
  readonly id: string
  readonly name: string
  readonly thumbnail: { toDataURL(): string }
}

/** Keeps Electron capture objects in Main; renderer responses only resolve offered tokens. */
export function createDisplaySourcePicker<T extends DisplaySource>(
  getSources: () => Promise<T[]>,
  publish: (state: DisplayPickerState | null) => void,
) {
  let state: DisplayPickerState | null = null
  let pending: { offers: Map<string, T>; finish(source?: T): void } | undefined
  const update = (value: DisplayPickerState | null) => { state = value; publish(value) }
  return {
    state: () => state,
    respond(response: DisplayPickerResponse) {
      if (!pending || response.requestId !== state?.requestId) throw new TypeError('Display picker request is no longer active')
      if (response.sourceId === null) { pending.finish(); return }
      const source = pending.offers.get(response.sourceId)
      if (state.status !== 'ready' || !source) throw new TypeError('Select an offered screen or window')
      pending.finish(source)
    },
    choose(signal: AbortSignal): Promise<T | undefined> {
      if (signal.aborted || pending) return Promise.resolve(undefined)
      return new Promise((resolve) => {
        const requestId = randomUUID()
        const finish = (source?: T) => {
          if (pending !== current) return
          signal.removeEventListener('abort', abort)
          pending = undefined
          update(null)
          resolve(source)
        }
        const abort = () => finish()
        const current = { offers: new Map<string, T>(), finish }
        pending = current
        signal.addEventListener('abort', abort, { once: true })
        update({ requestId, status: 'loading', sources: [] })
        void Promise.resolve().then(() => signal.aborted ? [] : getSources()).then((sources) => {
          if (pending !== current || signal.aborted) return
          const offers = sources.map((source) => {
            const id = randomUUID()
            current.offers.set(id, source)
            return {
              id, name: source.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300),
              kind: source.id.startsWith('screen:') ? 'screen' as const : 'window' as const,
              thumbnailUrl: source.thumbnail.toDataURL().replace(/^data:image\/png;base64,$/, ''),
            }
          })
          update({ requestId, status: 'ready', sources: offers })
        }).catch(() => {
          if (pending !== current || signal.aborted) return
          current.offers.clear()
          update({ requestId, status: 'error', sources: [] })
        })
      })
    },
  }
}
