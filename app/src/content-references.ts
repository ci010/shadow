import { workKeySchema } from '../../src/initiatives/work-key.ts'

/** Canonical actionable references are Markdown, not a second message schema. */
export function referenceLabel(text: string): string {
  return text.replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/[&\\`*_{}\[\]()<>!|"]/g, char => `&#${char.charCodeAt(0)};`)
}
export function referenceRoutePart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
export function workReference(projectId: string, key: string, title = key): string {
  return `[${referenceLabel(title)}](/projects/${referenceRoutePart(projectId)}/board?work=${referenceRoutePart(key)} "${referenceLabel(key)}; Work reference only; no assignment or notification.")`
}
export type ContentReference = { kind: 'session' | 'work'; projectId: string; id: string; href: string }
/** Explicit app routes only, never absolute URLs, filesystem paths or arbitrary queries. */
export function contentReference(href: string): ContentReference | undefined {
  const match = /^#?(\/projects\/([^/?#]+)\/(?:chat\/([^/?#]+)|(?:board|dashboard)\?work=([^&#]+)))$/.exec(href)
  if (!match) return undefined
  try {
    const projectId = decodeURIComponent(match[2]!)
    const id = decodeURIComponent((match[3] ?? match[4])!)
    if (!projectId || !id || /[\/\\\u0000-\u001f\u007f]/.test(projectId + id)) return undefined
    if (!match[3] && !workKeySchema.safeParse(id).success) return undefined
    return { kind: match[3] ? 'session' : 'work', projectId, id, href: match[1]! }
  } catch { return undefined }
}

/** Workflow links carry selection only; they never execute or configure a flow. */
export function workflowContentReference(href: string): string | undefined {
  const match = /^#?(\/projects\/([^/?#]+)\/workflows\?([^#]+))$/.exec(href)
  if (!match) return
  try {
    const project = decodeURIComponent(match[2]!)
    if (!project || /[\/\\\u0000-\u001f\u007f]/.test(project)) return
    const query = new URLSearchParams(match[3])
    const keys = [...query.keys()]
    if (keys.some(key => !['workflow', 'run', 'bot', 'node'].includes(key) || query.getAll(key).length !== 1)) return
    if (query.has('workflow') === query.has('bot') || query.has('bot') && query.has('run')) return
    if ([...query.values()].some(value => !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))) return
    return match[1]
  } catch { return }
}
