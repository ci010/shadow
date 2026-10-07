import { t } from './i18n.ts'
import type { SourceLines } from './file-selection.ts'

export interface MemoryEvent {
  when?: string
  who: string
  what: string
  why?: string
  challenge?: string
  refs?: string[]
  origin?: string
}

export type MemoryEventRecord = SourceLines & (
  | { kind: 'event'; event: MemoryEvent; extra: { name: string; value: string }[] }
  | { kind: 'invalid' | 'partial'; raw: string; message: string }
)

export function isMemoryEventFile(path: string): boolean {
  return /(?:^|\/)memory\/events\/[^/]+\.jsonl$/i.test(path.replaceAll('\\', '/'))
}

function isEvent(value: unknown): value is MemoryEvent & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.who === 'string' && typeof record.what === 'string'
    && ['when', 'why', 'challenge', 'origin'].every(key => record[key] === undefined || typeof record[key] === 'string')
    && (record.refs === undefined || (Array.isArray(record.refs) && record.refs.every(ref => typeof ref === 'string')))
}

const fields = new Set(['when', 'who', 'what', 'why', 'challenge', 'refs', 'origin'])

export function parseMemoryEvents(source: string, truncated = false): MemoryEventRecord[] {
  const lines = source.split(/\r\n|\r|\n/)
  return lines.flatMap((raw, index): MemoryEventRecord[] => {
    if (!raw.trim()) return []
    const span: SourceLines = { start: index + 1, end: index + 1, provenance: 'source block' }
    const partial = truncated && index === lines.length - 1
    let value: unknown
    try {
      value = JSON.parse(raw.trim())
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return [{ ...span, kind: partial ? 'partial' : 'invalid', raw, message: partial
        ? t('This record is cut off by the preview limit. Use Download to read the full entry.')
        : t('Invalid JSON on this line. The original text is shown below.') }]
    }
    if (!isEvent(value)) {
      return [{ ...span, kind: 'invalid', raw,
        message: t('This line does not match the memory event format. The original text is shown below.') }]
    }
    return [{ ...span, kind: 'event', event: value, extra: Object.entries(value)
      .filter(([key]) => !fields.has(key))
      .map(([name, field]) => ({ name, value: typeof field === 'string' ? field : JSON.stringify(field, null, 2) })) }]
  })
}

export function memoryEventTime(when: string): string {
  return when.replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 ').replace(/Z$/, ' UTC')
}
