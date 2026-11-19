import { otioSourceTime, type OtioModel, type OtioNode, type OtioTime } from './otio-model.ts'

export const isOtioFile = (name: string) => /\.otio(?:\.json)?$/i.test(name)
export const isAbsoluteMedia = (target: string) => /^(?:file:|[\\/]|[a-z]:)/i.test(target)

export interface OtioDocument {
  path: string
  owner: { folder: string } | { session: string; space: 'session-files' | 'workdir' | 'attachment' }
  sha256?: string
  modified?: string
}
export interface OtioMedium { path: string; kind: 'video' | 'image' }

/** A target_url is authored data, never a browser src. Convert only proved, root-relative paths;
 * the owning file endpoint still authorizes each request (including its symlink checks). */
export function resolveOtioMedia(documentPath: string, target: string, localRoot?: string): OtioMedium | null {
  if (!target || target.length > 4096 || /[\x00-\x1f\x7f?#]/.test(target) || /^[\\/]{2}/.test(target)) return null
  let path = target.replaceAll('\\', '/')
  if (/^file:/i.test(path)) {
    if (!/^file:\/\/\/(?!\/)/i.test(path)) return null
    path = path.slice('file://'.length).replace(/^\/(?=[a-z]:\/)/i, '')
  } else if (/^[a-z][a-z\d.+-]*:/i.test(path) && !/^[a-z]:\//i.test(path)) return null
  const parts: string[] = []
  for (const raw of path.split('/')) {
    let part: string
    try { part = decodeURIComponent(raw) } catch { return null }
    if (/[\\/\x00-\x1f\x7f]/.test(part)) return null
    parts.push(part)
  }
  path = parts.join('/')
  let base = documentPath.split('/').slice(0, -1)
  if (isAbsoluteMedia(path)) {
    if (!localRoot) return null
    const root = localRoot.replaceAll('\\', '/').replace(/\/+$/, '')
    const prefix = `${root}/`
    if (!(/^[a-z]:/i.test(root) ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return null
    path = path.slice(prefix.length)
    base = []
  }
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!base.length) return null; base.pop() }
    else if (part.includes(':')) return null
    else base.push(part)
  }
  const result = base.join('/')
  if (!result || base.some(part => !part || part === '..' || part === '.')) return null
  if (/\.(mp4|m4v|mov|webm)$/i.test(result)) return { path: result, kind: 'video' }
  if (/\.(png|jpe?g|webp|avif|bmp|gif)$/i.test(result)) return { path: result, kind: 'image' }
  return null
}

/** First timeline frame at or after a cut, tolerating only round-off at a frame boundary. */
export function firstOtioFrame(seconds: number, rate: number): number {
  const n = seconds * rate, rounded = Math.round(n)
  return Math.abs(n - rounded) <= 4 * Number.EPSILON * Math.max(1, Math.abs(n)) ? rounded : Math.ceil(n)
}
export function mediaPosition(node: OtioNode, seconds: number): number | null {
  const source = otioSourceTime(node, seconds)
  return source ? source.value / source.rate - (node.mediaStart ? node.mediaStart.value / node.mediaStart.rate : 0) : null
}
export function otioReviewAnchor(document: OtioDocument, model: OtioModel, node: OtioNode, frame: number,
  picture: OtioNode | null, mode: 'timeline' | 'clip', medium?: OtioMedium | null) {
  const at: OtioTime = { value: frame, rate: model.rate }, seconds = frame / model.rate
  const first = firstOtioFrame(node.start, model.rate)
  const after = firstOtioFrame(node.end, model.rate)
  const atSelection = frame >= first && frame < after
  const selectionFrame = atSelection ? frame : first
  return {
    document,
    element: { pointer: node.id, schema: node.schema, name: node.name,
      kind: node.kind,
      enabled: node.enabled,
      // A structural reference is to the element, not whatever happens to be on the monitor.
      referenceFrame: first < after ? {
        basis: atSelection ? 'playhead-within-element' : 'first-frame-within-element',
        relative: { value: selectionFrame, rate: model.rate },
        source: node.kind === 'Clip' ? otioSourceTime(node, selectionFrame / model.rate) : null,
      } : null, timelineSeconds: { startInclusive: node.start, endExclusive: node.end },
      ...(node.authoredRange && { sourceRange: node.authoredRange }),
      ...(node.transition && { transition: node.transition }),
      ...(node.activeMediaKey && { activeMediaKey: node.activeMediaKey }),
      ...(node.kind === 'Clip' && { sourceAtPlayhead: otioSourceTime(node, seconds) }),
    },
    playhead: { relative: at, ...(model.globalStart && { global: {
      value: model.globalStart.value + seconds * model.globalStart.rate, rate: model.globalStart.rate,
    } }) },
    // Selection may be a parent, audio item, transition or a clip below the top layer.
    monitor: { mode, clip: picture ? { pointer: picture.id, name: picture.name, timing: 'calculated' as const, source: otioSourceTime(picture, seconds),
      ...(medium && { mediaPath: medium.path }), ...(picture.mediaStart && { mediaStart: picture.mediaStart }),
      requestedMediaSeconds: mediaPosition(picture, seconds),
    } : null, ...(model.warnings.length && { previewLimits: model.warnings }) },
  }
}
export type OtioAnchor = ReturnType<typeof otioReviewAnchor>
export function otioReviewText(anchor: OtioAnchor, capture?: { presentedMediaSeconds: number | null }): string {
  // Preserve names/paths verbatim as JSON data, not Markdown links, attachment markers or new fences.
  const record = JSON.stringify({ ...anchor, ...(capture && { markedFrame: capture }) })
    .replaceAll('`', '\\u0060').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  const schema = /^[a-z][\w.-]{0,63}$/i.test(anchor.element.schema) ? ` · ${anchor.element.schema}` : ''
  return `OpenTimelineIO${schema}\n\`\`\`json\n${record}\n\`\`\``
}
