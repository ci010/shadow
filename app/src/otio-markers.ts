import type { OtioMarker, OtioModel } from './otio-model.ts'

// Authored colors are domain data, never interpolated as arbitrary CSS.
const colors: Record<string, string> = {
  RED: '#d94b4b', PINK: '#dc6cab', ORANGE: '#cf802d', YELLOW: '#b59b20',
  GREEN: '#38935b', CYAN: '#278d9c', BLUE: '#4c7bd1', PURPLE: '#9466c2',
  MAGENTA: '#ba55bb', BLACK: '#666666', WHITE: '#aaaaaa',
}
export function otioMarkerColor(color: string) { return colors[color.toUpperCase()] ?? 'var(--c-control-border)' }
export function otioMarkerGeometry(marker: OtioMarker, window: { start: number; span: number }) {
  const end = window.start + window.span
  if (window.span <= 0 || (marker.point ? marker.start < window.start || marker.start >= end
    : marker.end <= window.start || marker.start >= end)) return null
  return {
    left: `${(Math.max(marker.start, window.start) - window.start) / window.span * 100}%`,
    width: marker.point ? '2px' : `${(Math.min(marker.end, end) - Math.max(marker.start, window.start)) / window.span * 100}%`,
  }
}
export function otioMarkerRows(model: OtioModel) {
  const owners = new Map<string, OtioMarker[][]>()
  for (const marker of [...(model.markers ?? [])].sort((a, b) => a.start - b.start)) {
    const rows = owners.get(marker.ownerId) ?? []
    let row = rows.find(row => row.at(-1)!.end <= marker.start && row.at(-1)!.start < marker.start)
    if (!row) { row = []; rows.push(row) }
    row.push(marker)
    owners.set(marker.ownerId, rows)
  }
  return [...owners].flatMap(([ownerId, rows]) => {
    const owner = model.nodes.find(node => node.id === ownerId)!
    return rows.map((markers, index) => ({ id: `${ownerId}:${index}`, owner, markers }))
  })
}
