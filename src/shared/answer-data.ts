// Shared wire contract: tool history contains only a bounded display projection.
export const ANSWER_DATA_PREFIX = 'SHADOW_ANSWER_DATA_V1\n'
const limit = 12 * 1024

type Cell = string | number | boolean | null
export type AnswerData =
  | { kind: 'table'; title: string; columns: string[]; rows: Cell[][] }
  | { kind: 'line' | 'bar'; title: string; columns: [string, string]; rows: [string, number][] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const label = (value: unknown): value is string => typeof value === 'string' && value.length <= 160
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const cell = (value: unknown): value is Cell => value === null || label(value) || number(value) || typeof value === 'boolean'

function validate(value: unknown): AnswerData {
  const invalid = () => new Error('answerData needs only kind, title, columns and 1–40 rows. Use up to 8 table columns or exactly two chart columns (label, finite number). Text is limited to 160 characters.')
  if (!record(value) || Object.keys(value).length !== 4) throw invalid()
  const { kind, title, columns, rows } = value
  if (!label(title) || !Array.isArray(columns) || columns.length < 1 || columns.length > 8 || !Array.from(columns).every(label) ||
    !Array.isArray(rows) || rows.length < 1 || rows.length > 40 ||
    !Array.from(rows).every(row => Array.isArray(row) && row.length === columns.length && Array.from(row).every(cell))) throw invalid()
  if (kind === 'table') return { kind, title, columns, rows }
  if ((kind === 'line' || kind === 'bar') && columns.length === 2 &&
    rows.every(([x, y]) => label(x) && number(y) && Math.abs(y) <= 1e15)) {
    return { kind, title, columns: [columns[0], columns[1]], rows }
  }
  throw invalid()
}

export function encodeAnswerData(value: unknown): string {
  const payload = JSON.stringify(validate(value))
  if (new TextEncoder().encode(payload).length > limit) throw new Error('answerData exceeds 12 KiB.')
  return ANSWER_DATA_PREFIX + payload
}

export function decodeAnswerData(result: string): AnswerData | undefined {
  if (!result.startsWith(ANSWER_DATA_PREFIX) || result.length > ANSWER_DATA_PREFIX.length + limit) return
  const payload = result.slice(ANSWER_DATA_PREFIX.length)
  if (new TextEncoder().encode(payload).length > limit) return
  try { return validate(JSON.parse(payload)) } catch { return undefined }
}
