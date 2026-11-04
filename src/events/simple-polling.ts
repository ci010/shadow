import { createHash } from 'node:crypto'
import { z } from 'zod'

// Deliberately not JSONPath: own-property traversal only, no expressions or code.
const path = z.array(z.string().min(1).max(128)).max(16)
export const SimplePollingSchema = z.object({
  mode: z.enum(['items', 'snapshot']),
  request: z.object({
    method: z.literal('GET'), path: z.string().min(1).max(1024),
    query: z.record(z.string().max(4096)).optional(),
  }).strict(),
  select: path,
  eventType: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/),
  contentPath: path.optional(),
  idPath: path.optional(),
  fingerprintPath: path.optional(),
  filter: z.object({ path, equals: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict().optional(),
  // No generic pagination guesses. The caller must establish that this endpoint
  // is complete; reaching the bound fails closed rather than accepting a page.
  completeResponse: z.literal(true),
  maxItems: z.number().int().min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === 'items' && (!value.idPath || !value.maxItems || value.fingerprintPath)) {
    context.addIssue({ code: 'custom', message: 'items requires idPath and maxItems; fingerprintPath is snapshot-only' })
  }
  if (value.mode === 'snapshot' && (value.idPath || value.maxItems || value.filter)) {
    context.addIssue({ code: 'custom', message: 'snapshot does not support idPath, maxItems or filter' })
  }
})
export type SimplePolling = z.infer<typeof SimplePollingSchema>

function at(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('Missing extraction path')
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error('Non JSON extraction')
  return text
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export function simplePollingResult(config: SimplePolling, body: unknown, checkpoint: unknown) {
  const selected = at(body, config.select)
  const content = (value: unknown) => {
    const extracted = config.contentPath ? at(value, config.contentPath) : value
    return typeof extracted === 'string' ? extracted : canonical(extracted)
  }
  if (config.mode === 'snapshot') {
    const fingerprint = digest(config.fingerprintPath ? at(selected, config.fingerprintPath) : selected)
    const previous = checkpoint === null ? null : z.object({ fingerprint: z.string(), sequence: z.number().int().nonnegative() }).strict().parse(checkpoint)
    const sequence = previous ? previous.sequence + (previous.fingerprint === fingerprint ? 0 : 1) : 0
    return {
      events: previous && previous.fingerprint !== fingerprint
        ? [{ id: `snapshot:${sequence}:${fingerprint}`, type: config.eventType, content: content(selected) }] : [],
      checkpoint: { fingerprint, sequence },
    }
  }
  if (!Array.isArray(selected) || selected.length >= config.maxItems!) throw new Error('Incomplete or oversized items response; pagination is unsupported')
  const previous = checkpoint === null ? null : z.object({ ids: z.array(z.string()).max(1000) }).strict().parse(checkpoint)
  const ids = new Set(previous?.ids ?? [])
  const batch = new Set<string>()
  const events: Array<{ id: string; type: string; content: string }> = []
  for (const item of selected) {
    const rawId = at(item, config.idPath!)
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || String(rawId).length === 0 || String(rawId).length > 256) throw new Error('Invalid item ID')
    const id = String(rawId)
    if (batch.has(id)) throw new Error('Duplicate item ID')
    batch.add(id)
    if (previous && !ids.has(id) && (!config.filter || at(item, config.filter.path) === config.filter.equals)) {
      events.push({ id: digest(id), type: config.eventType, content: content(item) })
    }
    ids.add(id)
  }
  if (ids.size > 1000) throw new Error('Item identity capacity exceeded; use advanced code with an explicit cursor')
  return { events, checkpoint: { ids: [...ids] } }
}
