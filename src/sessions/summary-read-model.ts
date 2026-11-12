import { isDeepStrictEqual } from 'node:util'

/** Pull-validated navigation dependencies, never full execution states. Comparing
 * detached inputs catches in-place writes and live dependencies without relying
 * on events, TTLs, or every writer remembering to increment a revision. */
export class SummaryRowCache<T> {
  private rows = new Map<string, { fingerprint: unknown; value: T; bytes: number }>()
  private bytes = 0
  constructor(private maxBytes = 16 * 1024 * 1024) {}
  get(id: string, fingerprint: unknown): T | undefined {
    const row = this.rows.get(id)
    return row && isDeepStrictEqual(row.fingerprint, fingerprint) ? row.value : undefined
  }
  set(id: string, fingerprint: unknown, value: T): void {
    this.delete(id)
    const bytes = Buffer.byteLength(JSON.stringify(fingerprint)) + Buffer.byteLength(JSON.stringify(value))
    if (bytes > this.maxBytes) return
    this.rows.set(id, { fingerprint: structuredClone(fingerprint), value, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes) this.delete(this.rows.keys().next().value!)
  }
  retain(ids: Set<string>): void {
    for (const id of this.rows.keys()) if (!ids.has(id)) this.delete(id)
  }
  private delete(id: string): void {
    const row = this.rows.get(id)
    if (row) this.bytes -= row.bytes
    this.rows.delete(id)
  }
}
