import type { MemoryResource } from './contracts.ts'

/** Model-facing terminology only. Persisted resource kinds and version hashes stay
 * unchanged so old scoped-learning journals and immutable references still work. */
export function memoryLogView<T extends { kind: MemoryResource['kind'] }>(record: T): Omit<T, 'kind'> & { kind: Exclude<MemoryResource['kind'], 'event'> | 'log' } {
  return { ...record, kind: record.kind === 'event' ? 'log' : record.kind }
}
