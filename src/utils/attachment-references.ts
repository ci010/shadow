/** Plain-text reference protocol. Parsing never authorizes or resolves a path. */
export interface AttachmentReference {
  path: string
  name?: string
  reference?: string
  kind?: 'image' | 'file'
  source?: string
  modified?: boolean
}
export function escapeReferenceXml(value: string): string {
  return value.replace(/[&<>"'\r\n\t]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[char]!)
}
function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#13|#10|#9);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#13': '\r', '#10': '\n', '#9': '\t' })[entity]!)
}
export function serializeAttachmentReferences(refs: readonly AttachmentReference[]): string {
  if (!refs.length) return ''
  return '<attachment-references version="1">\n' + refs.map((ref, index) => {
    const attrs: Record<string, string> = { index: String(index + 1), path: ref.path }
    if (ref.name !== undefined) attrs.name = ref.name
    if (ref.reference !== undefined) attrs.reference = ref.reference
    if (ref.kind !== undefined) attrs.kind = ref.kind
    if (ref.source !== undefined) { attrs.source = ref.source; attrs.version = ref.modified ? 'marked copy; original unchanged' : 'original unmarked' }
    return '  <attachment ' + Object.entries(attrs).map(([key, value]) => `${key}="${escapeReferenceXml(value)}"`).join(' ') + ' />'
  }).join('\n') + '\n</attachment-references>'
}
/** Accept only our exact escaped format, not a general XML language/DTD. */
export function parseAttachmentReferences(text: string): AttachmentReference[] | undefined {
  if (!text.startsWith('<attachment-references version="1">\n') || !text.endsWith('\n</attachment-references>')) return undefined
  const refs: AttachmentReference[] = []
  for (const line of text.split('\n').slice(1, -1)) {
    if (!/^  <attachment (?:[a-z]+="[^"<>]*" ?)+\/>$/.test(line)) return undefined
    const attrs = Object.fromEntries([...line.matchAll(/([a-z]+)="([^"<>]*)"/g)].map(match => [match[1], unescapeXml(match[2]!)]))
    if (!attrs.path || attrs.index !== String(refs.length + 1) || (attrs.kind && !['image', 'file'].includes(attrs.kind))) return undefined
    refs.push({ path: attrs.path, ...(attrs.name !== undefined ? { name: attrs.name } : {}), ...(attrs.reference !== undefined ? { reference: attrs.reference } : {}), ...(attrs.kind ? { kind: attrs.kind as 'image' | 'file' } : {}), ...(attrs.source !== undefined ? { source: attrs.source, modified: attrs.version === 'marked copy; original unchanged' } : {}) })
  }
  return refs.length && serializeAttachmentReferences(refs) === text ? refs : undefined
}
