/** Read-only projection of semantic memory logs, not external Signal events. */
export interface KnowledgeEventRow {
  line: number
  source: string
  event?: {
    when?: string; who?: string; what?: string; why?: string
    summary?: string; challenge?: string; origin?: string; refs: string[]
  }
}

export function parseKnowledgeEvents(content: string): KnowledgeEventRow[] {
  return content.split(/\r?\n/).flatMap((source, index) => {
    if (!source.trim()) return []
    const row: KnowledgeEventRow = { line: index + 1, source }
    let value: unknown
    try { value = JSON.parse(source) } catch { return [row] }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [row]
    const record = value as Record<string, unknown>
    const text = (key: string) => typeof record[key] === 'string' ? record[key] as string : undefined
    // Unknown/old records are never coerced into invented event descriptions.
    if (!['when', 'who', 'what', 'why', 'summary'].some(key => text(key) !== undefined)) return [row]
    row.event = {
      when: text('when'), who: text('who'), what: text('what'), why: text('why'),
      summary: text('summary'), challenge: text('challenge'), origin: text('origin'),
      refs: Array.isArray(record.refs) ? record.refs.filter((ref): ref is string => typeof ref === 'string') : [],
    }
    return [row]
  })
}
