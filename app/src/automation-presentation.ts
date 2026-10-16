import type { MessageKey } from './i18n.ts'
export type AutomationField = { label: MessageKey; text: string; textKey?: MessageKey }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 4000) : ''
export function isReadableSystemAutomation(id?: string): boolean {
  return id === 'system:work-organizer'
}
/** Whitelist semantic content: never promote prompts, traces or arbitrary JSON. */
export function automationPresentation(source: string, input: boolean, id?: string): AutomationField[] {
  if (!isReadableSystemAutomation(id)) return []
  let value: Record<string, unknown> | undefined
  try { value = record(JSON.parse(source.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, ''))) } catch { /* Plain organizer finals are intentional. */ }
  const fields: AutomationField[] = []
  const add = (label: MessageKey, value: unknown) => { const content = text(value); if (content) fields.push({ label, text: content }) }
  if (!value) {
    if (!input && id === 'system:work-organizer' && source.trim() && !source.trim().startsWith('{')) add('Organization outcome', source)
    return fields
  }
  add('Organization mode', value.mode)
  if (Array.isArray(value.manifest)) for (const topic of value.manifest) {
    const item = record(topic)
    add('Title', item?.title)
    add('Objective', item?.objective)
    add('Summary', item?.summary)
  }
  add('Organization outcome', value.status)
  for (const key of ['coveredCount', 'manifestCount', 'patches']) if (typeof value[key] === 'number') fields.push({ label: key === 'coveredCount' ? 'Covered topics' : key === 'manifestCount' ? 'Topics' : 'Saved patches', text: String(value[key]) })
  return fields
}

/** Run titles may be the first line of a structured prompt rather than a human title. */
export function readableAutomationTitle(title?: string): string | undefined {
  const value = title?.trim()
  if (!value || /^[\[{`]/.test(value)) return undefined
  return value.split('\n')[0]!.slice(0, 160)
}
