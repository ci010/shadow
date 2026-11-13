import { createHash } from 'node:crypto'

/** Stable finite JSON identities; no execution or capability access. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value)
    if (result === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Expected finite JSON')
    return result
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
