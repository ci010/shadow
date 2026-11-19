import { otioPictureSpans, type OtioModel, type OtioNode } from './otio-model.ts'
import type { OtioDocument } from './otio-review.ts'

export const STORYBOARD_PAGE = 48
export const DESCRIPTION_LIMIT = 2000
export function storyboardOrder(model: OtioModel, track: OtioNode | undefined, interval: boolean,
  missing?: (node: OtioNode) => boolean) {
  const spans = otioPictureSpans(model, track)
  const eligible = spans.filter(({ node }) => !missing || (node && missing(node)))
  const runs = eligible.flatMap(({ start, end, node }) => {
    if (!interval) return node ? [{ start, node, count: 1 }] : []
    const first = Math.ceil(start / 2), after = Math.ceil(end / 2)
    return after > first ? [{ start: first * 2, count: after - first, node }] : []
  })
  const count = runs.reduce((sum, run) => sum + run.count, 0)
  return { count, page(offset: number) {
    const rows: { seconds: number; node: OtioNode | null }[] = []
    for (const run of runs) {
      if (offset >= run.count) { offset -= run.count; continue }
      for (; offset < run.count && rows.length < STORYBOARD_PAGE; offset++) {
        rows.push({ seconds: run.start + offset * 2, node: run.node })
      }
      if (rows.length === STORYBOARD_PAGE) break
      offset = 0
    }
    return rows
  } }
}

/** Exact revision identity: reordered/replaced clip pointers must never inherit captions. */
export function storyboardKey(api: string, source: OtioDocument): string | null {
  if (!source.path || !source.sha256 || !/^[a-f0-9]{64}$/.test(source.sha256)) return null
  if ('session' in source.owner && (!source.owner.session || source.owner.space === 'attachment')) return null
  if ('folder' in source.owner && !source.owner.folder) return null
  try {
    const url = new URL(api)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return 'shadow:otio-description:1:' + JSON.stringify([url.origin, url.pathname.replace(/\/+$/, ''), source.owner, source.path, source.sha256])
  } catch { return null }
}
export function readStoryboardDescriptions(storage: Storage, key: string): Map<string, string> {
  const value: unknown = JSON.parse(storage.getItem(key) ?? '{}')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid descriptions')
  const entries = Object.entries(value)
  if (entries.some(([, text]) => typeof text !== 'string' || text.length > DESCRIPTION_LIMIT)) throw new Error('Invalid descriptions')
  return new Map(entries)
}
