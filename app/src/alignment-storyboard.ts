export interface StoryboardItem { id: string; sourceId?: string; title: string; detail: string; duration: number; color: string; thumbnail?: string; filename?: string; sha256?: string }
export function storyboardSample(): StoryboardItem[] {
  return [
    { id: 'arrival', title: 'Arrival', detail: 'Wide shot · establish the quiet room', duration: 4, color: '#647c90' },
    { id: 'window', title: 'The window', detail: 'Medium shot · notice something outside', duration: 3, color: '#b39066' },
    { id: 'reaction', title: 'Reaction', detail: 'Close-up · pause before the reveal', duration: 2, color: '#93667d' },
    { id: 'reveal', title: 'Reveal', detail: 'Reverse shot · show the visitor', duration: 4, color: '#65896c' },
  ]
}
export function validateStoryboardOrder(ids: readonly string[], originalIds: readonly string[]): string[] {
  if (ids.length !== originalIds.length || new Set(ids).size !== ids.length || ids.some(id => !originalIds.includes(id))) throw new Error('Storyboard order must preserve every source item exactly once')
  return [...ids]
}
export function moveStoryboardItem<T>(items: readonly T[], index: number, offset: -1 | 1): T[] {
  const next = [...items], target = index + offset
  if (index < 0 || target < 0 || index >= items.length || target >= items.length) return next
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}
export function storyboardThumbnail(color: string, index: number): string {
  const scenes = [
    '<path d="M0 220L480 175V300H0" fill="#3b4143"/><rect x="30" y="30" width="155" height="175" fill="#26373b"/><path d="M45 45h125v145H45z" fill="#b7c8bc"/><path d="M107 45v145M45 116h125" stroke="#303c40" stroke-width="6"/><path d="M235 225v-70h130v70" fill="#8c6b53"/><circle cx="390" cy="116" r="18" fill="#c7b499"/><path d="M370 225v-85h40v85" fill="#263d46"/>',
    '<rect x="20" y="15" width="440" height="270" fill="#26383c"/><rect x="40" y="30" width="400" height="240" fill="#adc1b4"/><path d="M40 210l95-90 65 60 100-110 140 140v60H40" fill="#627e77"/><path d="M240 30v240M40 150h400" stroke="#344b50" stroke-width="12"/>',
    '<ellipse cx="245" cy="300" rx="130" ry="130" fill="#293d46"/><ellipse cx="245" cy="125" rx="65" ry="85" fill="#c9ab91"/><path d="M179 117q-15-110 80-80 65 10 54 100l-30-65-104 45" fill="#36332e"/><path d="M210 130h15m40 0h15" stroke="#3b3935" stroke-width="5"/><path d="M235 174q15 7 28-3" fill="none" stroke="#806654" stroke-width="4"/>',
    '<rect x="160" y="15" width="170" height="285" fill="#26373d"/><rect x="175" y="28" width="140" height="272" fill="#cfb78e"/><circle cx="245" cy="100" r="28" fill="#ad8e75"/><path d="M190 300v-145q55-40 110 0v145" fill="#4d635e"/><path d="M0 285l175-45M480 285l-165-45" stroke="#a28c73" stroke-width="3"/>'
  ]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="480" height="300" fill="${color}"/>${scenes[Math.abs(index)%4]}<rect x="0" y="270" width="100" height="30" fill="#111a"/><text x="14" y="291" fill="#eee" font-family="monospace" font-size="16">SHOT 0${index+1}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** A proposal layout, in seconds from the beginning of the proposed sequence. */
export function storyboardTiming(items: readonly Pick<StoryboardItem, 'id' | 'duration'>[]) {
  let cursor = 0
  const ids = new Set<string>()
  return items.map(item => {
    if (ids.has(item.id) || !Number.isFinite(item.duration) || item.duration < 0.1 || item.duration > 600) throw new Error('Invalid shot duration')
    ids.add(item.id)
    const start = cursor
    cursor += item.duration
    return { id: item.id, start, end: cursor, duration: item.duration }
  })
}
