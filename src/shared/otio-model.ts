export const MAX_OTIO_BYTES = 8 * 1024 * 1024
const MAX_DEPTH = 64
const MAX_NODES = 20_000

export interface OtioTime { value: number; rate: number }
export interface OtioRange { start: OtioTime; duration: OtioTime }
export interface OtioNode {
  readonly id: string
  kind: string
  schema: string
  name: string
  parentId: string | null
  depth: number
  start: number
  end: number
  sourceStart: OtioTime | null
  targetUrl?: string
  mediaStart?: OtioTime
  activeMediaKey?: string
  transition?: { inOffset: OtioTime; outOffset: OtioTime; type?: string }
  authoredRange?: OtioRange
  /** Nearest Track kind, inherited by items under that track. */
  trackKind?: string
  enabled: boolean
}
export interface OtioMarker {
  id: string
  ownerId: string
  name: string
  color: string
  comment: string
  markedRange: OtioRange
  /** Clipped timeline-relative seconds, not global_start_time timecode. */
  start: number
  end: number
  point: boolean
}
export type OtioWarning = 'transition-cut' | 'clip-effects' | 'unsupported-item' | 'unsupported-track'
export interface OtioModel {
  root: OtioNode
  nodes: OtioNode[]
  rate: number
  duration: number
  globalStart: OtioTime | null
  warnings: OtioWarning[]
  markers: OtioMarker[]
}

type Obj = Record<string, unknown>
type Item = {
  node: OtioNode; children: Item[]; duration: number; offset: number;
  trim: number; source: OtioTime | null; inOffset: number;
  durationTime?: OtioTime; trackEnd?: number
}
function fail(id: string, reason: string): never {
  throw new Error(`Invalid OTIO at ${id || '/'}: ${reason}`)
}
function object(value: unknown, id: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(id, 'expected object')
  return value as Obj
}
function schemaOf(obj: Obj, id: string): [string, string] {
  const schema = obj.OTIO_SCHEMA
  if (typeof schema !== 'string') fail(id, 'missing OTIO_SCHEMA')
  const match = /^(.+)\.[1-9]\d*$/.exec(schema)
  if (!match) fail(id, 'invalid OTIO_SCHEMA')
  return [schema, match[1]!]
}
function finite(value: number, id: string): number {
  if (!Number.isFinite(value)) fail(id, 'time overflow')
  return value
}
function seconds(t: OtioTime): number { return t.value / t.rate }
function time(value: unknown, id: string, nonnegative = false): OtioTime {
  const obj = object(value, id)
  if (obj.OTIO_SCHEMA !== 'RationalTime.1' || typeof obj.value !== 'number' ||
      !Number.isFinite(obj.value) || typeof obj.rate !== 'number' || !Number.isFinite(obj.rate) ||
      obj.rate <= 0 || (nonnegative && obj.value < 0)) fail(id, 'invalid RationalTime')
  const result = { value: obj.value, rate: obj.rate }
  if (finite(seconds(result), id) === 0 && result.value !== 0) fail(id, 'time underflow')
  return result
}
function range(value: unknown, id: string): OtioRange {
  const obj = object(value, id)
  if (obj.OTIO_SCHEMA !== 'TimeRange.1') fail(id, 'invalid TimeRange')
  return { start: time(obj.start_time, `${id}/start_time`), duration: time(obj.duration, `${id}/duration`, true) }
}
function media(obj: Obj, id: string): Obj | null {
  if (obj.media_references != null || obj.active_media_reference_key != null) {
    const refs = object(obj.media_references, `${id}/media_references`)
    const key = obj.active_media_reference_key
    if (typeof key !== 'string' || !Object.hasOwn(refs, key)) fail(id, 'invalid active media reference key')
    return object(refs[key], `${id}/media_references`)
  }
  return obj.media_reference == null ? null : object(obj.media_reference, `${id}/media_reference`)
}

export function parseOtio(text: string): OtioModel {
  if (text.length > MAX_OTIO_BYTES || new TextEncoder().encode(text).length > MAX_OTIO_BYTES) {
    fail('', `input exceeds ${MAX_OTIO_BYTES} bytes`)
  }
  const obj = object(JSON.parse(text), '')
  const globalStart = obj.global_start_time == null ? null : time(obj.global_start_time, '/global_start_time')
  const nodes: OtioNode[] = []
  const warnings = new Set<OtioWarning>()
  const markers: OtioMarker[] = []
  const authoredMarkers = new Map<string, OtioMarker[]>()
  let markerCount = 0
  let compositionRate: number | undefined
  let visualRate: number | undefined

  function build(raw: unknown, id: string, parent: OtioNode | null, audioAncestor = false): Item {
    const depth = parent ? parent.depth + 1 : 0
    if (depth > MAX_DEPTH || nodes.length >= MAX_NODES) fail(id, 'structure limit exceeded')
    const obj = object(raw, id)
    const [schema, kind] = schemaOf(obj, id)
    if (!parent && schema !== 'Timeline.1') fail(id, 'expected Timeline.1')
    if (parent && kind === 'Timeline') fail(id, 'nested Timeline is unsupported')
    if ((kind === 'Clip' && !['Clip.1', 'Clip.2'].includes(schema)) ||
        (['Track', 'Stack', 'Gap', 'Transition'].includes(kind) && schema !== `${kind}.1`)) {
      fail(id, `unsupported schema ${schema}`)
    }
    if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') fail(id, 'invalid enabled flag')
    const node: OtioNode = {
      id, kind, schema, name: typeof obj.name === 'string' ? obj.name : '',
      parentId: parent?.id ?? null, depth, start: 0, end: 0, sourceStart: null,
      enabled: obj.enabled !== false && (parent?.enabled ?? true),
    }
    if (parent?.trackKind !== undefined) node.trackKind = parent.trackKind
    nodes.push(node)
    if (obj.markers != null) {
      if (!Array.isArray(obj.markers)) fail(id, 'invalid markers')
      authoredMarkers.set(id, obj.markers.map((raw, index) => {
        const markerId = `${id}/markers/${index}`
        if (++markerCount > MAX_NODES) fail(markerId, 'marker limit exceeded')
        const marker = object(raw, markerId)
        if (!['Marker.1', 'Marker.2'].includes(String(marker.OTIO_SCHEMA))) fail(markerId, 'unsupported marker schema')
        return {
          id: markerId, ownerId: id,
          name: typeof marker.name === 'string' ? marker.name : '',
          color: typeof marker.color === 'string' ? marker.color : '',
          comment: typeof marker.comment === 'string' ? marker.comment : '',
          markedRange: range(marker.marked_range, `${markerId}/marked_range`),
          start: 0, end: 0, point: false,
        }
      }))
    }
    const item: Item = { node, children: [], duration: 0, offset: 0, trim: 0, source: null, inOffset: 0 }
    if (kind === 'Timeline') {
      const tracks = build(obj.tracks, '/tracks', node)
      if (tracks.node.kind !== 'Stack') fail('/tracks', 'expected a Stack')
      item.children.push(tracks)
      item.duration = tracks.duration
      return item
    }
    if (kind === 'Track') {
      if (typeof obj.kind !== 'string') fail(id, 'missing Track kind')
      node.trackKind = obj.kind
      if (!['Audio', 'Video'].includes(obj.kind)) warnings.add('unsupported-track')
    }
    if (obj.effects != null && !Array.isArray(obj.effects)) fail(id, 'invalid effects')
    const hasEffects = Array.isArray(obj.effects) && obj.effects.length > 0
    if (hasEffects) authoredMarkers.delete(id)
    if (kind === 'Transition') {
      if (parent?.kind !== 'Track') fail(id, 'expected Transition inside a Track')
      const inOffset = time(obj.in_offset, `${id}/in_offset`, true)
      const outOffset = time(obj.out_offset, `${id}/out_offset`, true)
      node.transition = { inOffset, outOffset }
      if (typeof obj.transition_type === 'string') node.transition.type = obj.transition_type
      item.inOffset = seconds(inOffset)
      item.duration = finite(item.inOffset + seconds(outOffset), id)
      warnings.add('transition-cut')
      return item
    }
    let sourceRange = obj.source_range == null ? null : range(obj.source_range, `${id}/source_range`)
    if (sourceRange) node.authoredRange = sourceRange
    if (kind === 'Clip') {
      const reference = media(obj, id)
      if (typeof obj.active_media_reference_key === 'string') node.activeMediaKey = obj.active_media_reference_key
      if (reference) {
        const [referenceSchema] = schemaOf(reference, `${id}/media_reference`)
        if (referenceSchema === 'ExternalReference.1' && typeof reference.target_url === 'string') {
          node.targetUrl = reference.target_url
        }
        if (reference.available_range != null) {
          const available = range(reference.available_range, `${id}/media_reference/available_range`)
          node.mediaStart = available.start
          sourceRange ??= available
        }
      }
      if (hasEffects) warnings.add('clip-effects')
    }
    const underAudio = audioAncestor || (kind === 'Track' && node.trackKind === 'Audio')
    if (sourceRange) {
      const rangeRate = sourceRange.duration.rate
      if (!underAudio && node.enabled) {
        if (kind === 'Stack' || kind === 'Track') compositionRate ??= rangeRate
        else if (kind === 'Clip' && (node.trackKind === undefined || node.trackKind === 'Video')) visualRate ??= rangeRate
      }
      item.trim = seconds(sourceRange.start)
      item.duration = seconds(sourceRange.duration)
      item.durationTime = sourceRange.duration
      if (!hasEffects) item.source = sourceRange.start
    }
    if (kind === 'Stack' || kind === 'Track') {
      if (hasEffects) fail(id, 'composition effects make its timing unsupported')
      if (!Array.isArray(obj.children)) fail(id, 'missing children array')
      let duration = 0
      let correction = 0
      let commonRate: number | undefined
      let frames = 0
      let useFrames = true
      for (let i = 0; i < obj.children.length; i++) {
        const child = build(obj.children[i], `${id}/children/${i}`, node, underAudio)
        item.children.push(child)
        if (kind === 'Stack') duration = Math.max(duration, child.duration)
        else if (child.node.kind === 'Transition') child.offset = duration - child.inOffset
        else {
          child.offset = duration
          // Compensated sum prevents a long run of non-binary frame periods
          // from accumulating enough drift to cross a frame boundary.
          if (child.duration > 0) {
            const adjusted = child.duration - correction
            const next = finite(duration + adjusted, child.node.id)
            if (next <= duration) fail(child.node.id, 'duration loses precision')
            correction = (next - duration) - adjusted
            const timing = child.durationTime
            commonRate ??= timing?.rate
            if (useFrames && timing && timing.rate === commonRate &&
                Number.isSafeInteger(timing.value) && Number.isSafeInteger(frames + timing.value)) {
              frames += timing.value
              duration = frames / timing.rate
              correction = 0
            } else {
              useFrames = false
              duration = next
            }
            if (duration <= child.offset) fail(child.node.id, 'duration loses precision')
          }
          child.trackEnd = duration
        }
      }
      if (!sourceRange) {
        // OTIO Track::available_range includes edge handles, although its
        // child placements still use the unshifted, non-overlapping cursor.
        const first = item.children[0]
        const last = item.children[item.children.length - 1]
        if (first?.node.kind === 'Transition') duration += first.inOffset
        if (last?.node.kind === 'Transition') duration += last.duration - last.inOffset
        item.duration = finite(duration, id)
      }
    } else {
      if (obj.children != null) fail(id, 'unsupported child placement')
      if (!sourceRange) fail(id, 'no source or available range for timed item')
      if (kind !== 'Clip' && kind !== 'Gap') {
        item.source = null
        warnings.add('unsupported-item')
      }
    }
    return item
  }

  const tree = build(obj, '', null)
  function project(item: Item, origin: number, min: number, max: number, placedEnd?: number) {
    const { node } = item
    const finish = placedEnd ?? finite(origin + item.duration, node.id)
    if (finish === origin && item.duration > 0) fail(node.id, 'duration loses precision')
    node.start = Math.min(max, Math.max(min, origin))
    node.end = Math.max(node.start, Math.min(max, finish))
    if (item.source && node.start < node.end) {
      const elapsed = node.start - origin
      node.sourceStart = {
        value: finite(item.source.value + elapsed * item.source.rate, node.id), rate: item.source.rate,
      }
    }
    // Markers use the owner's untrimmed/source coordinates. Parent trims
    // have already shifted origin; subtract this owner's trim exactly once.
    // Effects have no supported time mapping, just as for source playback.
    if (node.end > node.start && (node.kind === 'Timeline' || node.kind === 'Transition' || item.source || item.trim === 0)) {
      for (const marker of authoredMarkers.get(node.id) ?? []) {
        const start = finite(origin + seconds(marker.markedRange.start) - item.trim, marker.id)
        const span = seconds(marker.markedRange.duration)
        const range = marker.markedRange
        const localEnd = range.start.rate === range.duration.rate
          ? (range.start.value + range.duration.value) / range.start.rate
          : seconds(range.start) + span
        const end = finite(origin + localEnd - item.trim, marker.id)
        marker.point = span === 0
        if (marker.point ? start < node.start || start >= node.end : end <= node.start || start >= node.end) continue
        marker.start = Math.max(node.start, start)
        marker.end = Math.min(node.end, end)
        markers.push(marker)
      }
    }
    for (const child of item.children) {
      const childOrigin = finite(origin + (child.offset - item.trim), child.node.id)
      const childEnd = child.trackEnd === undefined ? undefined :
        finite(origin + (child.trackEnd - item.trim), child.node.id)
      project(child, childOrigin, node.start, node.end, childEnd)
    }
  }
  project(tree, 0, 0, tree.duration)
  // Gap and audio timing units need not represent video frames.
  const displayRate = globalStart?.rate ?? compositionRate ?? visualRate ?? 24
  const frameCount = tree.duration * displayRate
  if (frameCount > Number.MAX_SAFE_INTEGER || (frameCount === 0 && tree.duration > 0)) {
    fail('', 'timeline frame count cannot be represented')
  }
  return { root: tree.node, nodes, rate: displayRate, duration: tree.duration, globalStart, warnings: [...warnings], markers }
}

const pictureIndex = new WeakMap<OtioModel, { node: OtioNode; blocked: boolean }[]>()
function indexPictures(model: OtioModel) {
  const states = new Map<string, 'audio' | 'unknown' | undefined>()
  const pictures: { node: OtioNode; blocked: boolean }[] = []
  for (const node of model.nodes) {
    const parentState = node.parentId === null ? undefined : states.get(node.parentId)
    let state = parentState
    if (node.kind === 'Track') {
      if (node.trackKind === 'Audio') state = 'audio'
      else if (node.trackKind !== 'Video') state ??= 'unknown'
    }
    states.set(node.id, state)
    if (!node.enabled || node.start >= node.end || state === 'audio') continue
    if (state === 'unknown') pictures.push({ node, blocked: true })
    else if (node.kind === 'Clip') pictures.push({ node, blocked: false })
    else if (!['Timeline', 'Stack', 'Track', 'Gap', 'Transition'].includes(node.kind)) {
      pictures.push({ node, blocked: true })
    }
  }
  pictureIndex.set(model, pictures)
  return pictures
}

// Only accommodate floating-point round-off, not fractions of a frame.
// Bounding by the interval length also preserves genuine tiny intervals.
function atBoundary(query: number, boundary: number, span: number): boolean {
  return Math.abs(query - boundary) <= Math.min(span / 8, 4 * Number.EPSILON * Math.abs(boundary))
}
function contains(query: number, start: number, end: number): boolean {
  const span = end - start
  return span > 0 && (query >= start || atBoundary(query, start, span)) &&
    query < end && !atBoundary(query, end, span)
}

function excludedPicture(node: OtioNode, track?: OtioNode, hidden?: ReadonlySet<string>) {
  if (track && !node.id.startsWith(`${track.id}/children/`)) return true
  for (const id of hidden ?? []) if (node.id.startsWith(`${id}/children/`)) return true
  return false
}

export function otioPictureAt(model: OtioModel, seconds: number, track?: OtioNode, hidden?: ReadonlySet<string>): OtioNode | null {
  if (!Number.isFinite(seconds) || !contains(seconds, 0, model.duration)) return null
  // Reversed preorder visits the highest stack layer first. Transitions do
  // not participate in lookup: the adjacent clips meet at the hard cut.
  const pictures = pictureIndex.get(model) ?? indexPictures(model)
  for (let i = pictures.length - 1; i >= 0; i--) {
    const { node, blocked } = pictures[i]!
    if (excludedPicture(node, track, hidden)) continue
    if (contains(seconds, node.start, node.end)) return blocked ? null : node
  }
  return null
}

export function otioSourceTime(node: OtioNode, seconds: number): OtioTime | null {
  if (!node.sourceStart || !Number.isFinite(seconds) || !contains(seconds, node.start, node.end)) return null
  const { value, rate } = node.sourceStart
  const elapsed = atBoundary(seconds, node.start, node.end - node.start) ? 0 : seconds - node.start
  const result = value + elapsed * rate
  return Number.isFinite(result) ? { value: result, rate } : null
}

/** Flatten the same hard-cut picture stack as the monitor, highest preorder index wins. */
export function otioPictureSpans(model: OtioModel, track?: OtioNode, hidden?: ReadonlySet<string>) {
  const pictures = pictureIndex.get(model) ?? indexPictures(model)
  const events: { time: number; index: number; start: boolean }[] = []
  pictures.forEach(({ node }, index) => {
    if (excludedPicture(node, track, hidden)) return
    events.push({ time: node.start, index, start: true }, { time: node.end, index, start: false })
  })
  events.sort((a, b) => a.time - b.time)
  const heap: number[] = [], live = new Set<number>()
  const push = (index: number) => {
    let i = heap.length
    heap.push(index)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p]! >= index) break
      heap[i] = heap[p]!; i = p
    }
    heap[i] = index
  }
  const prune = () => {
    while (heap.length && !live.has(heap[0]!)) {
      const tail = heap.pop()!
      if (!heap.length) break
      let i = 0
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1
        if (c + 1 < heap.length && heap[c + 1]! > heap[c]!) c++
        if (heap[c]! <= tail) break
        heap[i] = heap[c]!; i = c
      }
      heap[i] = tail
    }
  }
  const spans: { start: number; end: number; node: OtioNode | null }[] = []
  let start = 0
  const append = (end: number) => {
    if (end <= start) return
    prune()
    const picture = pictures[heap[0]!]
    const node = picture && !picture.blocked ? picture.node : null
    const previous = spans.at(-1)
    if (previous?.node === node) previous.end = end
    else spans.push({ start, end, node })
    start = end
  }
  for (const event of events) {
    append(event.time)
    if (event.start) { live.add(event.index); push(event.index) }
    else live.delete(event.index)
  }
  append(model.duration)
  return spans
}
