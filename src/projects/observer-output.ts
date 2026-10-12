import { z } from 'zod'

/** Safe error labels only: provider output and validation values can contain private evidence. */
export class ObserverOutputError extends Error {
  constructor(readonly code: 'model_json_invalid' | 'model_schema_invalid') {
    super(code)
    this.name = 'ObserverOutputError'
  }
}

/** Accept a single complete JSON fence, never extract objects from prose or repair JSON. */
export function parseObserverOutput<T>(text: string, schema: z.ZodType<T>): T {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  let value: unknown
  try { value = JSON.parse(fence ? fence[1]! : trimmed) }
  catch { throw new ObserverOutputError('model_json_invalid') }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ObserverOutputError('model_schema_invalid')
  return parsed.data
}
